// Popcorn Pact: Streaming Availability (Movie of the Night) as a media provider.
//
// The likely launch provider, because it answers the question the product is
// actually about -- what can these two people watch tonight, on the services
// they pay for -- in one call rather than a discover call plus a per-title
// availability lookup.
//
// It is also the provider whose rows are richest in identity: a show carries its
// own id, an IMDb id and a TMDB id at once. All three are recorded, which is
// what lets a title stay recognisable if Popcorn Pact later moves to or from
// TMDB. Note that its TMDB id is namespaced ("movie/123") and is unwrapped here,
// so it matches what the TMDB adapter would have written.
//
// Unlike the other two, this API returns films and series from one endpoint
// distinguished by a `show_type` parameter, so the two calls this makes are a
// choice for symmetry rather than a constraint.

import { asExternalId, asImageUrl, asReleaseYear, asRows, isRecord, trimmedOrNull } from '../normalise.ts';
import { fetchJson, gatherByMediaType } from '../http.ts';
import type {
  DiscoverRequest,
  MediaProvider,
  MediaRecord,
  MediaType,
  ProviderCapabilities,
} from '../types.ts';

export type StreamingAvailabilityConfig = {
  baseUrl: string;
  /** Server-only. Optional so local development can run against a mock. */
  apiKey: string;
  /** Availability is regional; this is the country the pool is built for. */
  country: string;
};

const SHOW_TYPES: Record<MediaType, string> = { movie: 'movie', tv: 'series' };

const CAPABILITIES: ProviderCapabilities = { streamingAvailability: true };

// Ordered by preference: the first size present wins. Poster sizes are the
// provider's own CDN URLs, which is where artwork stays.
const POSTER_SIZES = ['w480', 'w600', 'w360', 'w720', 'w240'];
const BACKDROP_SIZES = ['w720', 'w1080', 'w480', 'w360'];

export function createStreamingAvailabilityProvider(
  config: StreamingAvailabilityConfig
): MediaProvider {
  return {
    name: 'streaming-availability',
    capabilities: CAPABILITIES,

    async discover(request: DiscoverRequest): Promise<MediaRecord[]> {
      const rows = await gatherByMediaType(request.mediaTypes, (mediaType) =>
        fetchShows(config, mediaType, request.services)
      );

      const records: MediaRecord[] = [];
      for (const row of rows) {
        if (records.length >= request.limit) break;

        const record = toRecord(row);
        if (record) records.push(record);
      }

      return records;
    },
  };
}

function authHeaders(config: StreamingAvailabilityConfig): Record<string, string> {
  if (!config.apiKey) return {};

  // The same API is sold through RapidAPI and directly by Movie of the Night,
  // and the two spell the credential differently. The host decides which.
  const host = new URL(config.baseUrl).hostname;
  if (host.endsWith('rapidapi.com')) {
    return { 'x-rapidapi-key': config.apiKey, 'x-rapidapi-host': host };
  }

  return { 'x-api-key': config.apiKey };
}

async function fetchShows(
  config: StreamingAvailabilityConfig,
  mediaType: MediaType,
  services: readonly string[] | null
): Promise<Record<string, unknown>[]> {
  const url = new URL(`${config.baseUrl}/shows/search/filters`);
  url.searchParams.set('country', config.country);
  url.searchParams.set('show_type', SHOW_TYPES[mediaType]);
  url.searchParams.set('order_by', 'popularity_1year');

  // The group's explicit constraint, in this provider's vocabulary: catalogue
  // slugs such as `netflix` or `prime.subscription`. An empty list never reaches
  // here -- the caller answers that without an upstream call at all.
  if (services !== null && services.length > 0) {
    url.searchParams.set('catalogs', services.join(','));
  }

  const payload = await fetchJson(url, {
    headers: authHeaders(config),
    label: `streaming-availability ${mediaType} search`,
  });

  // Documented as `{ shows: [...] }`; a bare array is tolerated because a thin
  // proxy in front of the API is a plausible deployment and costs one branch.
  const shows = isRecord(payload) ? payload.shows : payload;
  return asRows(shows);
}

function toRecord(row: Record<string, unknown>): MediaRecord | null {
  const mediaType = toMediaType(row.showType);
  if (mediaType === null) return null;

  const externalIds: Record<string, string> = {};

  const ownId = asExternalId(row.id);
  if (ownId !== null) externalIds['streaming-availability'] = ownId;

  const imdbId = asExternalId(row.imdbId);
  if (imdbId !== null) externalIds.imdb = imdbId;

  const tmdbId = unwrapTmdbId(row.tmdbId);
  if (tmdbId !== null) externalIds.tmdb = tmdbId;

  // Identity is the one thing a record cannot do without.
  if (Object.keys(externalIds).length === 0) return null;

  const images = isRecord(row.imageSet) ? row.imageSet : {};

  return {
    mediaType,
    title: trimmedOrNull(row.title),
    releaseYear: asReleaseYear(row.releaseYear ?? row.firstAirYear),
    overview: trimmedOrNull(row.overview),
    posterUrl: pickImage(images.verticalPoster, POSTER_SIZES),
    backdropUrl: pickImage(images.horizontalBackdrop, BACKDROP_SIZES),
    externalIds,
  };
}

function toMediaType(value: unknown): MediaType | null {
  if (value === 'movie') return 'movie';
  if (value === 'series') return 'tv';
  return null;
}

/** `"movie/603"` -> `"603"`, so the id matches what the TMDB adapter writes. */
function unwrapTmdbId(value: unknown): string | null {
  const text = trimmedOrNull(value);
  if (text === null) return null;
  return asExternalId(text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text);
}

function pickImage(imageSet: unknown, sizes: readonly string[]): string | null {
  if (!isRecord(imageSet)) return null;

  for (const size of sizes) {
    const url = asImageUrl(imageSet[size]);
    if (url !== null) return url;
  }

  return null;
}
