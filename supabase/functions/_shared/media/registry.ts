// Popcorn Pact: which media provider this deployment uses.
//
// Provider choice is a server-side configuration value and nothing else. It is
// read here, from the environment, and never travels to the Expo client, never
// appears in a request body, and never leaks into the pool-generation response:
// the app is told that a pool exists, not who supplied its titles.
//
// Adding a provider means adding an adapter and one case below. Switching one
// means setting MEDIA_PROVIDER and that provider's credentials as Edge Function
// secrets -- no migration, no client release, no change to pool, swipe or match
// code.
//
//   MEDIA_PROVIDER   tmdb (default) | tvdb | streaming-availability
//
//   TMDB_ACCESS_TOKEN                  TMDB_API_BASE_URL   TMDB_WATCH_REGION
//                                      TMDB_IMAGE_BASE_URL
//   TVDB_API_KEY  TVDB_PIN             TVDB_API_BASE_URL   TVDB_IMAGE_BASE_URL
//   STREAMING_AVAILABILITY_API_KEY     STREAMING_AVAILABILITY_BASE_URL
//                                      STREAMING_AVAILABILITY_COUNTRY
//
// Credentials are deliberately optional at construction time. Local development
// runs against a mock that needs none, and a missing credential against the real
// API simply produces a 401, which surfaces as an unavailable upstream rather
// than as a startup failure.

import { createStreamingAvailabilityProvider } from './providers/streaming-availability.ts';
import { createTmdbProvider } from './providers/tmdb.ts';
import {
  createTvdbProvider,
  diagnoseTvdbOverviews,
  type TvdbOverviewDiagnostic,
} from './providers/tvdb.ts';
import { MediaProviderConfigurationError, type MediaProvider } from './types.ts';

export const PROVIDER_NAMES = ['tmdb', 'tvdb', 'streaming-availability'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

const DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  tmdb: 'https://api.themoviedb.org/3',
  tvdb: 'https://api4.thetvdb.com/v4',
  'streaming-availability': 'https://api.movieofthenight.com/v4',
};

/** The configured provider, unless a caller overrides it (tests only). */
export function configuredProviderName(): ProviderName {
  const configured = (Deno.env.get('MEDIA_PROVIDER') ?? '').trim().toLowerCase();
  if (configured === '') return 'tmdb';

  if (!isProviderName(configured)) {
    throw new MediaProviderConfigurationError(`unknown MEDIA_PROVIDER: ${configured}`);
  }

  return configured;
}

export function defaultBaseUrl(name: ProviderName): string {
  const configured = env(`${envPrefix(name)}_BASE_URL`);
  return (configured || DEFAULT_BASE_URLS[name]).replace(/\/+$/, '');
}

/**
 * Builds the adapter for `name`.
 *
 * `baseUrl` is separated from the name so the test seam can point a provider at
 * a local mock without also having to reproduce its credential handling.
 */
export function createMediaProvider(name: ProviderName, baseUrl: string): MediaProvider {
  switch (name) {
    case 'tmdb':
      return createTmdbProvider({
        baseUrl,
        accessToken: env('TMDB_ACCESS_TOKEN'),
        watchRegion: env('TMDB_WATCH_REGION') || 'US',
        imageBaseUrl: env('TMDB_IMAGE_BASE_URL') || 'https://image.tmdb.org/t/p',
      });

    case 'tvdb':
      return createTvdbProvider({
        baseUrl,
        apiKey: env('TVDB_API_KEY'),
        pin: env('TVDB_PIN'),
        imageBaseUrl: env('TVDB_IMAGE_BASE_URL') || 'https://artworks.thetvdb.com',
      });

    case 'streaming-availability':
      return createStreamingAvailabilityProvider({
        baseUrl,
        apiKey: env('STREAMING_AVAILABILITY_API_KEY'),
        country: (env('STREAMING_AVAILABILITY_COUNTRY') || 'us').toLowerCase(),
      });
  }
}

/** Hosted-only TVDB observation using the same secret-backed adapter config. */
export function diagnoseConfiguredTvdbOverviews(
  limit: number,
  baseUrl = defaultBaseUrl('tvdb')
): Promise<TvdbOverviewDiagnostic> {
  return diagnoseTvdbOverviews(
    {
      baseUrl,
      apiKey: env('TVDB_API_KEY'),
      pin: env('TVDB_PIN'),
      imageBaseUrl: env('TVDB_IMAGE_BASE_URL') || 'https://artworks.thetvdb.com',
    },
    limit
  );
}

// Spelled out rather than derived from the name: TMDB_API_BASE_URL predates the
// abstraction and a deployment already sets it, so the mapping has to be a fact
// rather than a transformation that happens to agree today.
function envPrefix(name: ProviderName): string {
  switch (name) {
    case 'tmdb':
      return 'TMDB_API';
    case 'tvdb':
      return 'TVDB_API';
    case 'streaming-availability':
      return 'STREAMING_AVAILABILITY';
  }
}

function env(key: string): string {
  return (Deno.env.get(key) ?? '').trim();
}
