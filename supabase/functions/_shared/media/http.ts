// Popcorn Pact: the one way a media provider adapter talks to its upstream.
//
// Adapters differ in what they ask for; they do not differ in how long they are
// willing to wait, how they report an unreachable host, or how they behave
// against a loopback mock in local development. Keeping that here means adding a
// provider is a matter of describing its API, not re-deriving its plumbing.

import { MediaProviderUnavailableError } from './types.ts';

export const UPSTREAM_TIMEOUT_MS = 8_000;

type RequestOptions = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** Named in the error, so a failure says which call failed. */
  label: string;
};

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * One upstream call, returning parsed JSON.
 *
 * Every failure mode -- unreachable, non-2xx, unparseable -- becomes
 * {@link MediaProviderUnavailableError}, because from the caller's point of view
 * they are the same event: this request produced no candidates. Which of them
 * happened is in the message, for the logs.
 */
export async function fetchJson(url: URL, options: RequestOptions): Promise<unknown> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };

  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) };
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    const retried = await retryViaContainerHost(url, init);
    if (!retried) {
      throw new MediaProviderUnavailableError(
        `${options.label} unreachable: ${(cause as Error).message}`
      );
    }
    response = retried;
  }

  if (!response.ok) {
    throw new MediaProviderUnavailableError(`${options.label} responded ${response.status}`);
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new MediaProviderUnavailableError(
      `${options.label} returned unparseable JSON: ${(cause as Error).message}`
    );
  }
}

/**
 * DEVELOPMENT SEAM. Edge Functions run inside the local edge-runtime container,
 * where a loopback address is the container itself rather than the developer's
 * machine. The Supabase CLI maps the host as host.docker.internal, so a loopback
 * mock is retried there before giving up.
 *
 * Only reachable when the base URL is already loopback, which in a deployed
 * function it never is.
 */
async function retryViaContainerHost(url: URL, init: RequestInit): Promise<Response | null> {
  if (!isLoopbackHost(url.hostname)) return null;

  const hostUrl = new URL(url);
  hostUrl.hostname = 'host.docker.internal';

  // Several attempts over ~2s, because Docker's host gateway does not forward a
  // host port the instant it is bound: a mock server started moments earlier is
  // briefly unreachable ("network is unreachable", not "refused"), and clears on
  // its own. Production never reaches this branch, so the wait costs nothing
  // outside local development.
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300));

    try {
      // A fresh signal per attempt: the original was consumed, and an aborted
      // one would fail every retry instantly.
      return await fetch(hostUrl, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (cause) {
      console.error(`media upstream container-host retry ${attempt} failed`, cause);
    }
  }

  return null;
}

/**
 * Runs one call per media type and merges the results.
 *
 * Providers overwhelmingly split films and series across two endpoints, and the
 * partial-failure rule is the same for all of them: one endpoint failing is not
 * fatal, because a movies-only pool is a perfectly good pool and refusing to
 * build one because the series endpoint was rate-limited leaves the group with
 * nothing rather than with something. Only when every call fails is there
 * genuinely no upstream to speak of.
 */
export async function gatherByMediaType<T, M extends string>(
  mediaTypes: readonly M[],
  fetchOne: (mediaType: M) => Promise<T[]>
): Promise<T[]> {
  if (mediaTypes.length === 0) return [];

  const settled = await Promise.allSettled(mediaTypes.map(fetchOne));
  const merged: T[] = [];
  let failed = 0;

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      merged.push(...result.value);
      return;
    }

    failed += 1;
    // Logged rather than swallowed: silently returning half the catalogue
    // should still be visible.
    console.error(`media discover for ${mediaTypes[index]} failed`, result.reason);
  });

  if (failed === mediaTypes.length) {
    throw new MediaProviderUnavailableError('every discover call failed');
  }

  return merged;
}
