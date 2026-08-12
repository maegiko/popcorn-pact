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

const COLLECTION_PATHS: Record<MediaType, string> = {
  movie: '/movies',
  tv: '/series',
};

const CAPABILITIES: ProviderCapabilities = { streamingAvailability: false };

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

      return records;
    },
  };
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
