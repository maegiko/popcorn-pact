// Popcorn Pact: the canonical media model, and the provider interface that
// produces it.
//
// Everything above this file -- pool generation, and later swipes, matches and
// watched state -- speaks only in these types. Nothing here mentions a discover
// endpoint, a watch-provider id, a poster path or a login flow, because those
// are facts about TMDB, TVDB or Streaming Availability rather than facts about a
// film. Parsing a provider's response happens inside that provider's adapter and
// nowhere else.
//
// The interface is deliberately one method wide. Generation is the only thing
// Popcorn Pact currently asks an upstream for, so that is all a provider has to
// be able to do; search, per-title detail and availability lookups get added
// when a feature needs them, not in anticipation.

/**
 * A film or a series. These stay distinct all the way down: providers reuse
 * numeric ids across the two, so `movie 123` and `tv 123` are different titles
 * everywhere in this system, including in the database key.
 */
export type MediaType = 'movie' | 'tv';

export const MEDIA_TYPES: readonly MediaType[] = ['movie', 'tv'];

/**
 * Provider slug -> that provider's identifier for the title, as the provider
 * spells it. Values are strings because IMDb ids are not numbers and Streaming
 * Availability's are opaque.
 *
 * A record may carry several at once -- `{ tvdb: '81189', imdb: 'tt0903747' }` --
 * which is how a title stays recognisable when the configured provider changes.
 */
export type ExternalIds = Record<string, string>;

/**
 * One title, as Popcorn Pact understands it.
 *
 * Identity is `mediaType` plus `externalIds`, which must carry at least one
 * entry. Everything else is metadata a provider may or may not supply: a
 * discover feed that returns bare ids is still usable, and the swipe UI has to
 * cope with a missing title or poster regardless, because a cached record can
 * predate the metadata.
 */
export type MediaRecord = {
  mediaType: MediaType;
  title: string | null;
  releaseYear: number | null;
  overview: string | null;
  /** Absolute provider/CDN URL. Never a blob, never a bare path. */
  posterUrl: string | null;
  backdropUrl: string | null;
  externalIds: ExternalIds;
};

/**
 * Streaming services the group explicitly selected, as opaque tokens.
 *
 * Opaque is the point: the core has no opinion on whether a token is a TMDB
 * watch-provider id, a Streaming Availability catalogue slug or something else.
 * Each adapter interprets them in its own vocabulary, and one that cannot
 * declares so through {@link ProviderCapabilities} rather than quietly ignoring
 * the constraint.
 *
 * `null` means the group narrowed nothing, which is a supported steady state and
 * not an incomplete profile.
 */
export type ServiceFilter = readonly string[] | null;

export type DiscoverRequest = {
  mediaTypes: readonly MediaType[];
  services: ServiceFilter;
  /** Upper bound on returned records. A pool is a finite snapshot. */
  limit: number;
};

/**
 * What a provider can do, so the core never has to ask "which provider is this".
 *
 * Streaming availability is optional on purpose. TVDB has no availability data
 * and is still a perfectly good development provider: unfiltered pools, movie
 * and TV discovery, canonical identity. Making availability a required
 * capability would rule out providers Popcorn Pact wants to be able to use.
 */
export type ProviderCapabilities = {
  /** Can honour a {@link ServiceFilter}. */
  readonly streamingAvailability: boolean;
};

export interface MediaProvider {
  /** Slug used for this provider's entries in `media_external_ids`. */
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Candidate titles for a pool.
   *
   * Malformed upstream rows are dropped rather than raised: the upstream is a
   * third party, and one bad row in a page of forty is not a reason to leave the
   * group with nothing. Ordering is the provider's own ranking, which the caller
   * may narrow but does not reorder.
   *
   * Throws {@link MediaProviderUnavailableError} only when the provider could
   * retrieve nothing at all. A provider that fetches films and series
   * separately and loses one of the two returns what it has: a movies-only pool
   * is a perfectly good pool.
   */
  discover(request: DiscoverRequest): Promise<MediaRecord[]>;
}

/** The upstream could not be reached, or refused everything asked of it. */
export class MediaProviderUnavailableError extends Error {}

/** The configured provider name is not one this deployment can build. */
export class MediaProviderConfigurationError extends Error {}
