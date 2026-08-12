// Popcorn Pact: parsing helpers shared by the media provider adapters.
//
// Every adapter reads a foreign JSON document and has to answer the same small
// questions of it -- is this a string worth keeping, is this a plausible year,
// is this a usable identifier. Sharing the answers keeps the adapters short
// enough to read as "this is what this provider calls a title", which is the
// only thing they should be about.
//
// These are all total and all lenient: a value that is not what was hoped for
// becomes null rather than an exception, because a bad field in one row must not
// take down a whole generation.

import type { MediaType } from './types.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rows of a list response, or an empty array if the shape is not a list. */
export function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function asMediaType(value: unknown): MediaType | null {
  return value === 'movie' || value === 'tv' ? value : null;
}

export function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A provider identifier as text. Numbers are accepted because most providers
 * send them that way; anything non-positive or non-integer is rejected, since a
 * `0` or `-1` id is a malformed row rather than a title.
 */
export function asExternalId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? String(value) : null;
  }

  const text = trimmedOrNull(value);
  if (text === null) return null;
  // Numeric-looking strings are held to the same rule, so '0' and '-1' cannot
  // sneak in through a provider that quotes its ids.
  if (/^-?\d+$/.test(text)) return Number(text) > 0 ? text : null;
  return text;
}

/**
 * A release year from either a bare year or a date. Bounded rather than merely
 * numeric: `media.release_year` carries the same check, and a year the database
 * would reject should be dropped here instead of aborting the snapshot.
 */
export function asReleaseYear(value: unknown): number | null {
  if (typeof value === 'number') return inRange(Math.trunc(value));

  const text = trimmedOrNull(value);
  if (text === null) return null;

  const match = text.match(/^(\d{4})/);
  return match ? inRange(Number(match[1])) : null;
}

function inRange(year: number): number | null {
  return Number.isInteger(year) && year >= 1870 && year <= 2200 ? year : null;
}

/**
 * An absolute URL, or null.
 *
 * Providers vary between absolute URLs (TVDB, Streaming Availability) and bare
 * paths that need a configured image host (TMDB), so `base` is optional and
 * applied only when the value is not already absolute.
 */
export function asImageUrl(value: unknown, base?: string): string | null {
  const text = trimmedOrNull(value);
  if (text === null) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${text.replace(/^\/+/, '')}`;
}
