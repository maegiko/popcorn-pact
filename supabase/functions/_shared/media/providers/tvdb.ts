// Popcorn Pact: TheTVDB (v4) as a media provider.
//
// The intended development provider. TVDB has no streaming-availability data at
// all, which is exactly why it is worth supporting: if the app only works
// against a provider that can answer "is this on Netflix", then availability has
// quietly become a prerequisite for the product rather than an optional
// narrowing. It declares `streamingAvailability: false`, and the caller decides
// what to do about a filter it cannot honour.
//
// Two things are TVDB-specific and stay in here:
//
//   * authentication is a login exchange, not a static header. POST /login
//     returns a bearer token valid for about a month, cached per isolate below.
//   * films and series are separate collections (/movies, /series) whose list
//     rows carry id, name, year and artwork -- enough for a swipe card, without
//     the per-title /extended call that would turn one pool into sixty
//     round-trips.
//
// Consequence of skipping /extended: a TVDB record carries only its tvdb id. It
// gains imdb/tmdb mappings the first time some other provider recognises the
// same title, which is what media_external_ids is for.

import { asExternalId, asImageUrl, asReleaseYear, asRows, isRecord, trimmedOrNull } from '../normalise.ts';
import { fetchJson, gatherByMediaType } from '../http.ts';
import {
  MediaProviderUnavailableError,
  type DiscoverRequest,
  type MediaProvider,
  type MediaRecord,
  type MediaType,
  type ProviderCapabilities,
} from '../types.ts';

export type TvdbConfig = {
  baseUrl: string;
  /** Server-only. Optional so local development can run against a mock. */
  apiKey: string;
  /** Subscriber PIN, only needed for user-supported keys. */
  pin: string;
  imageBaseUrl: string;
};

export type TvdbOverviewObservation = {
  title: string | null;
  tvdbId: string;
  mediaType: MediaType;
  rawOverviewFieldPresent: boolean;
  rawOverviewPresent: boolean;
  rawOverviewLength: number;
  normalizedOverviewPresent: boolean;
  normalizedOverviewLength: number;
  normalizedOverviewPreview: string | null;
};

export type TvdbOverviewCoverage = {
  inspected: number;
  rawOverviewPresentCount: number;
  normalizedOverviewPresentCount: number;
  coveragePercent: number;
};

export type TvdbMovieDetailObservation = {
  title: string | null;
  tvdbId: string;
  listingOverviewPresent: boolean;
  detailEndpointsTried: string[];
  detailRequestSuccess: boolean;
  detailEndpointUsed: string | null;
  rawOverviewPath: string | null;
  detailRawOverviewPresent: boolean;
  detailRawOverviewLength: number;
  normalizedDetailOverviewPresent: boolean;
  normalizedDetailOverviewLength: number;
  normalizedDetailOverviewPreview: string | null;
  failure: TvdbOverviewDiagnosticFailure | null;
};

export type TvdbMovieDetailSummary = {
  sampled: number;
  rawOverviewPresentCount: number;
  normalizedOverviewPresentCount: number;
  normalizationDroppedCount: number;
  requestFailureCount: number;
  coveragePercent: number;
  samples: TvdbMovieDetailObservation[];
};

export type TvdbOverviewDiagnostic = {
  source: {
    loginEndpoint: '/login';
    collectionEndpoints: readonly ['/movies', '/series'];
    detailLookupPerformed: true;
    productionDetailLookupPerformed: false;
    detailEndpoints: readonly ['/movies/{id}', '/movies/{id}/extended?meta=translations&short=true'];
    rawOverviewField: 'overview';
  };
  recordsInspected: number;
  rawOverviewPresentCount: number;
  normalizedOverviewPresentCount: number;
  normalizationDroppedCount: number;
  coverageByMediaType: Record<MediaType, TvdbOverviewCoverage>;
  movieDetails: TvdbMovieDetailSummary;
  samples: TvdbOverviewObservation[];
};

export type TvdbOverviewDiagnosticFailure = 'authentication' | 'network_or_rate_limit' | 'provider';

export class TvdbOverviewDiagnosticError extends Error {
  constructor(readonly failure: TvdbOverviewDiagnosticFailure) {
    super(`TVDB overview diagnostic failed: ${failure}`);
  }
}

const COLLECTION_PATHS: Record<MediaType, string> = {
  movie: '/movies',
  tv: '/series',
};

const CAPABILITIES: ProviderCapabilities = { streamingAvailability: false };
const MOVIE_DETAIL_SAMPLE_SIZE = 5;
// Live TVDB movie listings carry an overview close to never (0/30 sampled), so
// a generated pool routinely needs one detail call per admitted movie -- up to
// the pool's own cap. At the old concurrency of 2, a movie-heavy pool serialised
// into ~30 round trips and pool generation took several seconds. 8 keeps this a
// small bounded burst rather than firing all of them at once, while cutting
// that to a handful of batches.
const MOVIE_DETAIL_CONCURRENCY = 8;
const MOVIE_BASE_ENDPOINT = '/movies/{id}';
const MOVIE_EXTENDED_ENDPOINT = '/movies/{id}/extended?meta=translations&short=true';

// Tokens last about a month; this cache only has to survive an isolate, and a
// stale entry costs one extra login. Keyed by base URL so a test pointed at a
// mock never reuses a token minted against the real API.
const tokens = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1_000;

export function createTvdbProvider(config: TvdbConfig): MediaProvider {
  return {
    name: 'tvdb',
    capabilities: CAPABILITIES,

    async discover(request: DiscoverRequest): Promise<MediaRecord[]> {
      // Nothing to do with `request.services`: this provider has no availability
      // data, declares as much, and is never handed a filter it cannot apply.
      const token = await login(config);

      const rows = await gatherByMediaType(request.mediaTypes, (mediaType) =>
        fetchCollection(config, token, mediaType)
      );

      const records: MediaRecord[] = [];
      for (const { mediaType, row } of rows) {
        if (records.length >= request.limit) break;

        const record = toRecord(config, mediaType, row);
        if (record) records.push(record);
      }

      await enrichMovieOverviews(config, token, records);

      return records;
    },
  };
}

/**
 * Fills in a missing movie overview from the extended-detail endpoint.
 *
 * Scoped to the records the adapter already admitted (bounded by
 * `request.limit`, itself equal to the pool's own cap), not the wider set of
 * rows discovery paged through -- so this cannot balloon into one detail call
 * per row TVDB returned. TV records and movies that already carry a listing
 * overview are skipped: this is optional enrichment for the one gap production
 * TVDB movie listings actually have, not a general detail lookup.
 */
async function enrichMovieOverviews(
  config: TvdbConfig,
  token: string,
  records: MediaRecord[]
): Promise<void> {
  const candidates = records.filter(
    (record) => record.mediaType === 'movie' && record.overview === null
  );
  if (candidates.length === 0) return;

  await mapWithConcurrency(candidates, MOVIE_DETAIL_CONCURRENCY, async (record) => {
    let extendedPayload: unknown;
    try {
      extendedPayload = await fetchMovieDetail(config, token, record.externalIds.tvdb, true);
    } catch {
      // Enrichment is optional metadata: a failed/timed-out detail request
      // leaves the base record exactly as discovery produced it.
      return;
    }

    const raw = rawDetailOverview(null, extendedPayload);
    if (raw) record.overview = raw.value;
  });
}

/**
 * Inspect overview behavior on the same collection rows used by discovery.
 *
 * This deliberately does not call TVDB's detail endpoints. The smoke test is
 * asking what the production pool path receives today, not whether another API
 * path could supply richer metadata.
 */
export async function diagnoseTvdbOverviews(
  config: TvdbConfig,
  limit: number
): Promise<TvdbOverviewDiagnostic> {
  let token: string;
  try {
    token = await login(config);
  } catch (cause) {
    throw diagnosticError(cause);
  }

  const settled = await Promise.allSettled(
    (['movie', 'tv'] as const).map((mediaType) => fetchCollection(config, token, mediaType))
  );
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failed) throw diagnosticError(failed.reason);

  const perMediaTypeLimit = Math.max(1, Math.ceil(limit / 2));
  const rows = settled.flatMap((result) =>
    result.status === 'fulfilled' ? result.value.slice(0, perMediaTypeLimit) : []
  );
  const observations: TvdbOverviewObservation[] = [];

  for (const { mediaType, row } of rows) {
    if (observations.length >= limit) break;
    const observation = observeTvdbOverview(config, mediaType, row);
    if (observation) observations.push(observation);
  }

  const rawOverviewPresentCount = observations.filter((item) => item.rawOverviewPresent).length;
  const normalizedOverviewPresentCount = observations.filter(
    (item) => item.normalizedOverviewPresent
  ).length;
  const normalizationDroppedCount = observations.filter(
    (item) => item.rawOverviewPresent && !item.normalizedOverviewPresent
  ).length;
  const detailCandidates = observations
    .filter((item) => item.mediaType === 'movie' && !item.rawOverviewPresent)
    .slice(0, MOVIE_DETAIL_SAMPLE_SIZE);
  const detailSamples = await mapWithConcurrency(
    detailCandidates,
    MOVIE_DETAIL_CONCURRENCY,
    (listing) => inspectMovieDetails(config, token, listing)
  );

  return {
    source: {
      loginEndpoint: '/login',
      collectionEndpoints: ['/movies', '/series'],
      detailLookupPerformed: true,
      productionDetailLookupPerformed: false,
      detailEndpoints: [MOVIE_BASE_ENDPOINT, MOVIE_EXTENDED_ENDPOINT],
      rawOverviewField: 'overview',
    },
    recordsInspected: observations.length,
    rawOverviewPresentCount,
    normalizedOverviewPresentCount,
    normalizationDroppedCount,
    coverageByMediaType: {
      movie: summarizeOverviewCoverage(observations, 'movie'),
      tv: summarizeOverviewCoverage(observations, 'tv'),
    },
    movieDetails: summarizeMovieDetails(detailSamples),
    samples: representativeSamples(observations),
  };
}

export function summarizeMovieDetails(
  samples: TvdbMovieDetailObservation[]
): TvdbMovieDetailSummary {
  const rawOverviewPresentCount = samples.filter((item) => item.detailRawOverviewPresent).length;
  const normalizedOverviewPresentCount = samples.filter(
    (item) => item.normalizedDetailOverviewPresent
  ).length;

  return {
    sampled: samples.length,
    rawOverviewPresentCount,
    normalizedOverviewPresentCount,
    normalizationDroppedCount: samples.filter(
      (item) => item.detailRawOverviewPresent && !item.normalizedDetailOverviewPresent
    ).length,
    requestFailureCount: samples.filter((item) => item.failure !== null).length,
    coveragePercent:
      samples.length === 0
        ? 0
        : Number(((rawOverviewPresentCount / samples.length) * 100).toFixed(1)),
    samples,
  };
}

export function summarizeOverviewCoverage(
  observations: TvdbOverviewObservation[],
  mediaType: MediaType
): TvdbOverviewCoverage {
  const matching = observations.filter((item) => item.mediaType === mediaType);
  const rawOverviewPresentCount = matching.filter((item) => item.rawOverviewPresent).length;
  const normalizedOverviewPresentCount = matching.filter(
    (item) => item.normalizedOverviewPresent
  ).length;

  return {
    inspected: matching.length,
    rawOverviewPresentCount,
    normalizedOverviewPresentCount,
    coveragePercent:
      matching.length === 0
        ? 0
        : Number(((normalizedOverviewPresentCount / matching.length) * 100).toFixed(1)),
  };
}

export function observeTvdbOverview(
  config: TvdbConfig,
  mediaType: MediaType,
  row: Record<string, unknown>
): TvdbOverviewObservation | null {
  const record = toRecord(config, mediaType, row);
  if (!record) return null;

  const rawOverview = trimmedOrNull(row.overview);
  const normalizedOverview = record.overview;

  return {
    title: record.title,
    tvdbId: record.externalIds.tvdb,
    mediaType,
    rawOverviewFieldPresent: Object.prototype.hasOwnProperty.call(row, 'overview'),
    rawOverviewPresent: rawOverview !== null,
    rawOverviewLength: rawOverview?.length ?? 0,
    normalizedOverviewPresent: normalizedOverview !== null,
    normalizedOverviewLength: normalizedOverview?.length ?? 0,
    normalizedOverviewPreview: normalizedOverview?.slice(0, 100) ?? null,
  };
}

async function inspectMovieDetails(
  config: TvdbConfig,
  token: string,
  listing: TvdbOverviewObservation
): Promise<TvdbMovieDetailObservation> {
  const endpointsTried: string[] = [];
  let basePayload: unknown = null;
  let extendedPayload: unknown = null;
  let failure: TvdbOverviewDiagnosticFailure | null = null;

  try {
    endpointsTried.push(MOVIE_BASE_ENDPOINT);
    basePayload = await fetchMovieDetail(config, token, listing.tvdbId, false);
    endpointsTried.push(MOVIE_EXTENDED_ENDPOINT);
    extendedPayload = await fetchMovieDetail(config, token, listing.tvdbId, true);
  } catch (cause) {
    failure = diagnosticError(cause).failure;
  }

  return observeMovieDetailPayloads(config, listing, endpointsTried, basePayload, extendedPayload, failure);
}

export function observeMovieDetailPayloads(
  config: TvdbConfig,
  listing: TvdbOverviewObservation,
  detailEndpointsTried: string[],
  basePayload: unknown,
  extendedPayload: unknown,
  failure: TvdbOverviewDiagnosticFailure | null
): TvdbMovieDetailObservation {
  const raw = rawDetailOverview(basePayload, extendedPayload);
  const detailRow = raw ? detailData(raw.endpoint === MOVIE_BASE_ENDPOINT ? basePayload : extendedPayload) : null;
  const normalized =
    raw && detailRow
      ? toRecord(config, 'movie', {
          ...detailRow,
          id: listing.tvdbId,
          name: listing.title,
          overview: raw.value,
        })
      : null;

  return {
    title: listing.title,
    tvdbId: listing.tvdbId,
    listingOverviewPresent: listing.rawOverviewPresent,
    detailEndpointsTried,
    detailRequestSuccess: failure === null,
    detailEndpointUsed: raw?.endpoint ?? null,
    rawOverviewPath: raw?.path ?? null,
    detailRawOverviewPresent: raw !== null,
    detailRawOverviewLength: raw?.value.length ?? 0,
    normalizedDetailOverviewPresent: normalized?.overview !== null && normalized?.overview !== undefined,
    normalizedDetailOverviewLength: normalized?.overview?.length ?? 0,
    normalizedDetailOverviewPreview: normalized?.overview?.slice(0, 100) ?? null,
    failure,
  };
}

async function fetchMovieDetail(
  config: TvdbConfig,
  token: string,
  tvdbId: string,
  extended: boolean
): Promise<unknown> {
  const suffix = extended ? '/extended' : '';
  const url = new URL(`${config.baseUrl}/movies/${encodeURIComponent(tvdbId)}${suffix}`);
  if (extended) {
    url.searchParams.set('meta', 'translations');
    url.searchParams.set('short', 'true');
  }

  return await fetchJson(url, {
    headers: { authorization: `Bearer ${token}` },
    label: `tvdb movie ${extended ? 'extended ' : ''}detail`,
  });
}

function rawDetailOverview(
  basePayload: unknown,
  extendedPayload: unknown
): { value: string; path: string; endpoint: string } | null {
  const base = detailData(basePayload);
  const baseOverview = base ? trimmedOrNull(base.overview) : null;
  if (baseOverview) {
    return { value: baseOverview, path: 'data.overview', endpoint: MOVIE_BASE_ENDPOINT };
  }

  const extended = detailData(extendedPayload);
  const extendedOverview = extended ? trimmedOrNull(extended.overview) : null;
  if (extendedOverview) {
    return {
      value: extendedOverview,
      path: 'data.overview',
      endpoint: MOVIE_EXTENDED_ENDPOINT,
    };
  }

  const translations = extended && isRecord(extended.translations) ? extended.translations : null;
  const overviews = translations ? asRows(translations.overviewTranslations) : [];
  const preferredIndex = overviews.findIndex(
    (row) => trimmedOrNull(row.language) === 'eng' && trimmedOrNull(row.overview) !== null
  );
  const fallbackIndex = overviews.findIndex((row) => trimmedOrNull(row.overview) !== null);
  const index = preferredIndex >= 0 ? preferredIndex : fallbackIndex;
  if (index < 0) return null;

  return {
    value: trimmedOrNull(overviews[index].overview)!,
    path: `data.translations.overviewTranslations[${index}].overview`,
    endpoint: MOVIE_EXTENDED_ENDPOINT,
  };
}

function detailData(payload: unknown): Record<string, unknown> | null {
  return isRecord(payload) && isRecord(payload.data) ? payload.data : null;
}

async function login(config: TvdbConfig): Promise<string> {
  const cached = tokens.get(config.baseUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const payload = await fetchJson(new URL(`${config.baseUrl}/login`), {
    method: 'POST',
    // `pin` is omitted rather than sent empty: TVDB rejects a blank pin on
    // company keys, which do not use one.
    body: config.pin ? { apikey: config.apiKey, pin: config.pin } : { apikey: config.apiKey },
    label: 'tvdb login',
  });

  const data = isRecord(payload) ? payload.data : null;
  const token = isRecord(data) ? trimmedOrNull(data.token) : null;
  if (!token) {
    // The same error type a failed request produces: a login that answers 200
    // with no token is no more usable than a 401, and the caller should treat
    // both as "this upstream gave us nothing" rather than as a bug.
    throw new MediaProviderUnavailableError('tvdb login returned no token');
  }

  tokens.set(config.baseUrl, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

type TypedRow = { mediaType: MediaType; row: Record<string, unknown> };

async function fetchCollection(
  config: TvdbConfig,
  token: string,
  mediaType: MediaType
): Promise<TypedRow[]> {
  const url = new URL(`${config.baseUrl}${COLLECTION_PATHS[mediaType]}`);
  // One page. A pool is a finite snapshot, and TVDB's page is already larger
  // than the cap generation applies.
  url.searchParams.set('page', '0');

  const payload = await fetchJson(url, {
    headers: { authorization: `Bearer ${token}` },
    label: `tvdb ${mediaType} collection`,
  });

  const data = isRecord(payload) ? payload.data : null;
  return asRows(data).map((row) => ({ mediaType, row }));
}

function toRecord(
  config: TvdbConfig,
  mediaType: MediaType,
  row: Record<string, unknown>
): MediaRecord | null {
  const externalId = asExternalId(row.id);
  if (externalId === null) return null;

  return {
    mediaType,
    title: trimmedOrNull(row.name),
    // `year` on both collections; `firstAired` is the series fallback.
    releaseYear: asReleaseYear(row.year ?? row.firstAired),
    overview: trimmedOrNull(row.overview),
    // TVDB list rows usually carry an absolute artworks.thetvdb.com URL, but
    // sometimes a bare /banners path; asImageUrl handles both.
    posterUrl: asImageUrl(row.image, config.imageBaseUrl),
    backdropUrl: null,
    externalIds: { tvdb: externalId },
  };
}

function diagnosticError(cause: unknown): TvdbOverviewDiagnosticError {
  const message = cause instanceof Error ? cause.message : '';

  if (/tvdb login responded (401|403)\b/i.test(message)) {
    return new TvdbOverviewDiagnosticError('authentication');
  }
  if (/\bunreachable\b|\btimeout\b|responded 429\b/i.test(message)) {
    return new TvdbOverviewDiagnosticError('network_or_rate_limit');
  }
  return new TvdbOverviewDiagnosticError('provider');
}

function representativeSamples(
  observations: TvdbOverviewObservation[]
): TvdbOverviewObservation[] {
  const samples: TvdbOverviewObservation[] = [];

  for (const mediaType of ['movie', 'tv'] as const) {
    const matching = observations.filter((item) => item.mediaType === mediaType);
    samples.push(...matching.slice(0, 3));

    const withOverview = matching.find((item) => item.rawOverviewPresent);
    if (withOverview && !samples.includes(withOverview)) samples.push(withOverview);
  }

  return samples;
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = [];

  for (let index = 0; index < values.length; index += concurrency) {
    results.push(...(await Promise.all(values.slice(index, index + concurrency).map(mapper))));
  }

  return results;
}
