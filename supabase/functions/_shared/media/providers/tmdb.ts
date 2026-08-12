// Popcorn Pact: TMDB as a media provider.
//
// TMDB was the original upstream, and everything TMDB-shaped now lives here: two
// per-media-type discover endpoints, numeric watch-provider ids, poster paths
// that need an image host bolted on, and rows that carry no media_type of their
// own. None of that is visible above this file.
//
// TMDB is the richest of the three providers Popcorn Pact can use and the one
// with real watch-provider data, but it is also the one whose commercial terms
// may not work out -- hence the abstraction. It stays the default so that a
// deployment which sets no MEDIA_PROVIDER keeps behaving exactly as it did.

import {
  asExternalId,
  asImageUrl,
  asMediaType,
  asReleaseYear,
  asRows,
  isRecord,
  trimmedOrNull,
} from '../normalise.ts';
import { fetchJson, gatherByMediaType } from '../http.ts';
import type {
  DiscoverRequest,
  MediaProvider,
  MediaRecord,
  MediaType,
  ProviderCapabilities,
} from '../types.ts';

export type TmdbConfig = {
  baseUrl: string;
  /** Server-only. Optional so local development can run against a mock. */
  accessToken: string;
  watchRegion: string;
  imageBaseUrl: string;
};

const DISCOVER_PATHS: Record<MediaType, string> = {
  movie: '/discover/movie',
  tv: '/discover/tv',
};

const CAPABILITIES: ProviderCapabilities = { streamingAvailability: true };

export function createTmdbProvider(config: TmdbConfig): MediaProvider {
  return {
    name: 'tmdb',
    capabilities: CAPABILITIES,

    async discover(request: DiscoverRequest): Promise<MediaRecord[]> {
      // TMDB names services by numeric watch-provider id. A token that is not
      // one cannot be expressed here, so it is dropped rather than guessed at;
      // a request made entirely of such tokens narrows to nothing, which is a
      // real answer and not a reason to widen the pool behind the group's back.
      const providerIds = request.services === null ? null : toProviderIds(request.services);
      if (providerIds !== null && providerIds.length === 0) return [];

      const rows = await gatherByMediaType(request.mediaTypes, (mediaType) =>
        fetchDiscover(config, mediaType, providerIds)
      );

      const records: MediaRecord[] = [];
      for (const { mediaType, row } of rows) {
        if (records.length >= request.limit) break;
        if (!isEligible(row, providerIds)) continue;

        const record = toRecord(config, mediaType, row);
        if (record) records.push(record);
      }

      return records;
    },
  };
}

function toProviderIds(services: readonly string[]): number[] {
  const ids: number[] = [];
  for (const service of services) {
    const id = Number(service);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

type TypedRow = { mediaType: MediaType; row: Record<string, unknown> };

async function fetchDiscover(
  config: TmdbConfig,
  mediaType: MediaType,
  providerIds: number[] | null
): Promise<TypedRow[]> {
  const url = new URL(`${config.baseUrl}${DISCOVER_PATHS[mediaType]}`);
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('sort_by', 'popularity.desc');

  if (providerIds !== null && providerIds.length > 0) {
    // TMDB applies this itself, which is why a row that comes back carrying no
    // provider information is trusted by isEligible rather than dropped.
    url.searchParams.set('with_watch_providers', providerIds.join('|'));
    url.searchParams.set('watch_region', config.watchRegion);
  }

  const headers: Record<string, string> = {};
  if (config.accessToken) headers.authorization = `Bearer ${config.accessToken}`;

  const payload = await fetchJson(url, { headers, label: `tmdb ${mediaType} discover` });
  const results = isRecord(payload) ? payload.results : null;

  // TMDB's discover endpoints are per-media-type and their rows carry no
  // media_type, so the endpoint that produced a row is what says what it is. An
  // explicit media_type on the row still wins -- a feed that labels its own rows
  // is telling the truth about them, including when what it says is something
  // Popcorn Pact does not model. Such a row is dropped rather than relabelled
  // as whatever the endpoint was: it is not a film or a series.
  return asRows(results).flatMap((row) => {
    if (row.media_type === undefined || row.media_type === null) return [{ mediaType, row }];

    const declared = asMediaType(row.media_type);
    return declared === null ? [] : [{ mediaType: declared, row }];
  });
}

/**
 * Whether a row survives the service filter.
 *
 * The real TMDB applies `with_watch_providers` upstream and returns rows with no
 * provider information of their own, so nothing declared means "already as
 * filtered as it is going to get". A row that DOES declare its providers is held
 * to them.
 */
function isEligible(row: Record<string, unknown>, providerIds: number[] | null): boolean {
  if (providerIds === null) return true;

  const declared = Array.isArray(row.provider_ids)
    ? row.provider_ids.filter((id): id is number => typeof id === 'number')
    : null;

  if (declared === null) return true;
  return declared.some((id) => providerIds.includes(id));
}

function toRecord(
  config: TmdbConfig,
  mediaType: MediaType,
  row: Record<string, unknown>
): MediaRecord | null {
  const externalId = asExternalId(row.tmdb_id ?? row.id);
  if (externalId === null) return null;

  return {
    mediaType,
    // Films have `title`, series have `name`.
    title: trimmedOrNull(row.title ?? row.name),
    releaseYear: asReleaseYear(row.release_date ?? row.first_air_date),
    overview: trimmedOrNull(row.overview),
    posterUrl: asImageUrl(row.poster_path, `${config.imageBaseUrl}/w500`),
    backdropUrl: asImageUrl(row.backdrop_path, `${config.imageBaseUrl}/w780`),
    externalIds: { tmdb: externalId },
  };
}
