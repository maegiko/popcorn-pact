// Popcorn Pact: generate a title pool for a group.
//
// This is the trusted half of pool generation. It exists as an Edge Function
// rather than client code for three reasons: the upstream credential must never
// reach a phone, the group's access state has to be decided server-side, and the
// resulting snapshot must be written in one transaction.
//
// The whole flow is:
//
//   caller JWT -> user           who is asking (never taken from the body)
//   group_access -> state        are they a member, and is the group in grace
//   discover movie + tv          two upstream calls, merged into one candidate set
//   normalise + filter           what is actually eligible and well-formed
//   create_generated_pool()      one transaction: pool row + every title
//
// Nothing is written until the candidate list is known to be non-empty, so a
// failure anywhere above leaves no pool behind to clean up -- which matters,
// because clients hold no delete on pools and there is no cleanup path.
//
// Outcomes are returned as a status in a 200 body, the same discriminated-union
// shape the database RPCs use. "You are not in that group" and "there was
// nothing to show you" are answers, not faults. HTTP error codes are reserved
// for genuine faults: a bad request, a missing session, an unreachable upstream.

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

// The authoritative upstream. TMDB_API_BASE_URL exists so a deployment can be
// pointed at a proxy; the test header below is not part of this.
const UPSTREAM_BASE_URL = Deno.env.get('TMDB_API_BASE_URL') ?? 'https://api.themoviedb.org/3';
// Server-only, and deliberately optional: local development runs against a mock
// that needs no credential. A missing token against real TMDB simply produces a
// 401 from them, which surfaces as upstream_unavailable.
const TMDB_ACCESS_TOKEN = Deno.env.get('TMDB_ACCESS_TOKEN') ?? '';
const TMDB_WATCH_REGION = Deno.env.get('TMDB_WATCH_REGION') ?? 'US';

// A pool is a finite snapshot, not a feed. This cap is what makes that true
// regardless of how much the upstream returns. It is generous next to a discover
// page (20 rows per media type), so in practice it bounds pathological upstreams
// rather than trimming ordinary ones -- which is why plain concatenation of the
// two media types cannot starve one of them here.
const MAX_POOL_TITLES = 60;
const UPSTREAM_TIMEOUT_MS = 8_000;

// TEST/DEVELOPMENT SEAM. Lets the test suite point generation at a mock upstream
// without mocking the database. It is not production configuration and cannot be
// used as such: the value is honoured only when it addresses a loopback host,
// and not at all when POPCORNPACT_ENV says production. A deployed function
// therefore cannot be redirected by a caller-supplied header.
const TEST_BASE_URL_HEADER = 'x-popcornpact-test-tmdb-base-url';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

type GenerateStatus =
  // The contract the client depends on.
  | 'created'
  | 'not_a_member'
  | 'group_in_grace'
  | 'no_candidates'
  | 'upstream_unavailable'
  // Faults a correct client never provokes.
  | 'invalid_request'
  | 'unauthenticated'
  | 'error';

type MediaType = 'movie' | 'tv';

type PoolTitle = { tmdb_id: number; media_type: MediaType };

type MediaEndpoint = { mediaType: MediaType; path: string };

// The two halves of a pool. TMDB has no combined discover endpoint, so a pool
// that contains both films and series is necessarily two calls.
const MEDIA_ENDPOINTS: MediaEndpoint[] = [
  { mediaType: 'movie', path: '/discover/movie' },
  { mediaType: 'tv', path: '/discover/tv' },
];

type GenerateRequest = { groupId: string; effectiveProviderIds: number[] | null };

type RawCandidate = Record<string, unknown>;

class UpstreamError extends Error {}

// ---------------------------------------------------------------------------
// Request and response plumbing.
// ---------------------------------------------------------------------------

// The web client is a browser, so a cross-origin POST carrying `authorization`
// and a JSON body triggers a CORS preflight -- native iOS/Android fetch never
// does this, which is why the gap was invisible until the web target called
// the deployed function. No cookies/credentials are involved (auth travels as
// a bearer token), so a wildcard origin carries no session-fixation risk.
const CORS_HEADERS: HeadersInit = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, apikey, content-type, x-client-info, x-popcornpact-test-tmdb-base-url',
};

function respond(status: GenerateStatus, poolId: string | null, httpStatus = 200): Response {
  return new Response(JSON.stringify({ status, poolId }), {
    status: httpStatus,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function parseRequest(request: Request): Promise<GenerateRequest | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (typeof body !== 'object' || body === null) return null;
  const { groupId, effectiveProviderIds } = body as Record<string, unknown>;

  if (typeof groupId !== 'string' || groupId.trim() === '') return null;

  // Provider filtering is optional, so an absent key means the same as null:
  // no filter. An explicit empty array does NOT -- that means "no provider is
  // eligible", which is a real and different answer.
  if (effectiveProviderIds === null || effectiveProviderIds === undefined) {
    return { groupId, effectiveProviderIds: null };
  }

  if (
    !Array.isArray(effectiveProviderIds) ||
    !effectiveProviderIds.every((id) => typeof id === 'number' && Number.isInteger(id))
  ) {
    return null;
  }

  return { groupId, effectiveProviderIds: effectiveProviderIds as number[] };
}

// ---------------------------------------------------------------------------
// Supabase calls, always as the caller.
//
// Every request below carries the caller's JWT, so RLS and the RPC's own checks
// apply to them and not to some elevated identity. The service-role key is
// deliberately never used here: this function needs no authority the caller
// does not already have.
// ---------------------------------------------------------------------------

function callerHeaders(token: string): HeadersInit {
  return {
    apikey: SUPABASE_ANON_KEY,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function resolveUserId(token: string): Promise<string | null> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: callerHeaders(token),
  });

  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`auth/v1/user responded ${response.status}`);

  const user = (await response.json()) as { id?: unknown };
  return typeof user.id === 'string' ? user.id : null;
}

// null means "no such group as far as this caller is concerned". The view is
// security_invoker, so a group the caller does not belong to is simply not
// visible -- membership and existence collapse into one answer, which is what
// not_a_member should mean anyway.
async function readGroupState(token: string, groupId: string): Promise<string | null> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/group_access`);
  url.searchParams.set('select', 'state');
  url.searchParams.set('group_id', `eq.${groupId}`);

  const response = await fetch(url, { headers: callerHeaders(token) });
  if (!response.ok) throw new Error(`group_access responded ${response.status}`);

  const rows = (await response.json()) as { state?: unknown }[];
  const state = rows[0]?.state;
  return typeof state === 'string' ? state : null;
}

async function createGeneratedPool(
  token: string,
  groupId: string,
  titles: PoolTitle[]
): Promise<{ status: string; pool_id: string | null }> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_generated_pool`, {
    method: 'POST',
    headers: callerHeaders(token),
    body: JSON.stringify({ p_group_id: groupId, p_titles: titles }),
  });

  if (!response.ok) {
    throw new Error(`create_generated_pool responded ${response.status}: ${await response.text()}`);
  }

  const rows = (await response.json()) as { status?: unknown; pool_id?: unknown }[];
  const row = rows[0];

  return {
    status: typeof row?.status === 'string' ? row.status : 'error',
    pool_id: typeof row?.pool_id === 'string' ? row.pool_id : null,
  };
}

// ---------------------------------------------------------------------------
// Upstream candidates.
// ---------------------------------------------------------------------------

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function resolveUpstreamBaseUrl(request: Request): string {
  const override = request.headers.get(TEST_BASE_URL_HEADER);
  if (!override) return UPSTREAM_BASE_URL;
  if (Deno.env.get('POPCORNPACT_ENV') === 'production') return UPSTREAM_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    return UPSTREAM_BASE_URL;
  }

  if (!isLoopbackHost(parsed.hostname)) return UPSTREAM_BASE_URL;
  return override.replace(/\/+$/, '');
}

function upstreamUrl(baseUrl: string, path: string, providerIds: number[] | null): URL {
  const url = new URL(`${baseUrl}${path}`);
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('sort_by', 'popularity.desc');

  if (providerIds !== null && providerIds.length > 0) {
    // TMDB applies this itself, which is why a candidate that comes back
    // carrying no provider information is trusted below rather than dropped.
    url.searchParams.set('with_watch_providers', providerIds.join('|'));
    url.searchParams.set('watch_region', TMDB_WATCH_REGION);
  }

  return url;
}

function isRecord(value: unknown): value is RawCandidate {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// One discover call. TMDB's discover endpoints are per-media-type and their rows
// carry no media_type of their own, so the endpoint that produced a row is what
// says what it is. An explicit media_type on the row still wins -- a candidate
// feed that labels its own rows is telling the truth about them.
async function fetchDiscover(
  baseUrl: string,
  endpoint: MediaEndpoint,
  providerIds: number[] | null
): Promise<RawCandidate[]> {
  const url = upstreamUrl(baseUrl, endpoint.path, providerIds);
  const headers: HeadersInit = { accept: 'application/json' };
  if (TMDB_ACCESS_TOKEN) headers.authorization = `Bearer ${TMDB_ACCESS_TOKEN}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (cause) {
    // Dev-seam fallback: this function runs inside the local edge-runtime
    // container, where a loopback address is the container itself rather than
    // the developer's machine. The CLI maps the host as host.docker.internal,
    // so a loopback mock is retried there before giving up. Only reachable
    // through the loopback-gated test header above.
    const retried = await retryViaContainerHost(url, headers);
    if (retried) response = retried;
    else throw new UpstreamError(`${endpoint.mediaType} unreachable: ${(cause as Error).message}`);
  }

  if (!response.ok) {
    throw new UpstreamError(`${endpoint.mediaType} responded ${response.status}`);
  }

  const payload = (await response.json()) as { results?: unknown };
  if (!Array.isArray(payload.results)) return [];

  return payload.results
    .filter(isRecord)
    .map((row) => ({ media_type: endpoint.mediaType, ...row }));
}

// Movies and TV are two calls, merged into one finite candidate set.
//
// A single endpoint failing is deliberately NOT fatal: a movies-only pool is a
// perfectly good pool, and refusing to build one because TMDB's tv endpoint was
// rate-limited would leave the group with nothing rather than with something.
// Only when every call fails is there genuinely no upstream to speak of, and
// that is what upstream_unavailable means. A partial failure is logged, because
// silently returning half the catalogue should still be visible in the logs.
async function fetchCandidates(
  baseUrl: string,
  providerIds: number[] | null
): Promise<RawCandidate[]> {
  const settled = await Promise.allSettled(
    MEDIA_ENDPOINTS.map((endpoint) => fetchDiscover(baseUrl, endpoint, providerIds))
  );

  const merged: RawCandidate[] = [];
  let failed = 0;

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      merged.push(...result.value);
      return;
    }

    failed += 1;
    console.error(`generate-pool ${MEDIA_ENDPOINTS[index].mediaType} discover failed`, result.reason);
  });

  if (failed === MEDIA_ENDPOINTS.length) {
    throw new UpstreamError('every discover call failed');
  }

  return merged;
}

async function retryViaContainerHost(url: URL, headers: HeadersInit): Promise<Response | null> {
  if (!isLoopbackHost(url.hostname)) return null;

  const hostUrl = new URL(url);
  hostUrl.hostname = 'host.docker.internal';

  // Several attempts over ~2s, because Docker's host gateway does not forward a
  // host port the instant it is bound: a mock server started moments earlier is
  // briefly unreachable ("network is unreachable", not "refused"), and clears on
  // its own. Production never reaches this branch -- it requires a loopback base
  // URL, which only the test header can supply -- so the wait costs nothing
  // outside local development.
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300));

    try {
      return await fetch(hostUrl, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (cause) {
      console.error(`generate-pool container-host retry ${attempt} failed`, cause);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Candidate selection.
//
// Malformed candidates are dropped rather than failing the request: the upstream
// is a third party, and one bad row in a page of forty is not a reason to leave
// the group with nothing.
// ---------------------------------------------------------------------------

function normaliseTitle(candidate: RawCandidate): PoolTitle | null {
  const rawId = candidate.tmdb_id ?? candidate.id;
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) return null;

  // fetchDiscover stamps every row with the media type of the endpoint that
  // produced it, so this is normally already set. The fallback keeps the
  // function total if a row arrives with a non-string media_type.
  const mediaType = typeof candidate.media_type === 'string' ? candidate.media_type : 'movie';
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;

  return { tmdb_id: rawId, media_type: mediaType };
}

function isEligible(candidate: RawCandidate, providerIds: number[] | null): boolean {
  if (providerIds === null) return true;

  const declared = Array.isArray(candidate.provider_ids)
    ? candidate.provider_ids.filter((id): id is number => typeof id === 'number')
    : null;

  // Nothing declared means the upstream query already carried the provider
  // constraint, so this candidate is as filtered as it is going to get. A
  // candidate that DOES declare its providers is held to them.
  if (declared === null) return true;
  return declared.some((id) => providerIds.includes(id));
}

function selectTitles(candidates: RawCandidate[], providerIds: number[] | null): PoolTitle[] {
  const seen = new Set<string>();
  const titles: PoolTitle[] = [];

  for (const candidate of candidates) {
    if (titles.length >= MAX_POOL_TITLES) break;
    if (!isEligible(candidate, providerIds)) continue;

    const title = normaliseTitle(candidate);
    if (!title) continue;

    // movie 123 and tv 123 are different titles, so the identity includes both.
    const key = `${title.media_type}:${title.tmdb_id}`;
    if (seen.has(key)) continue;

    seen.add(key);
    titles.push(title);
  }

  return titles;
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

Deno.serve(async (request: Request): Promise<Response> => {
  // The preflight itself carries no auth and expects no body -- answered
  // before anything else here even looks at the request.
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return respond('invalid_request', null, 405);

  try {
    const token = bearerToken(request);
    if (!token) return respond('unauthenticated', null, 401);

    const body = await parseRequest(request);
    if (!body) return respond('invalid_request', null, 400);

    const userId = await resolveUserId(token);
    if (!userId) return respond('unauthenticated', null, 401);

    const state = await readGroupState(token, body.groupId);
    if (state === null) return respond('not_a_member', null);
    if (state !== 'active') return respond('group_in_grace', null);

    // An explicit empty provider list means no provider is eligible, so no
    // title can be. Answered without calling the upstream at all.
    if (body.effectiveProviderIds !== null && body.effectiveProviderIds.length === 0) {
      return respond('no_candidates', null);
    }

    let candidates: RawCandidate[];
    try {
      candidates = await fetchCandidates(
        resolveUpstreamBaseUrl(request),
        body.effectiveProviderIds
      );
    } catch (cause) {
      console.error('generate-pool upstream failure', cause);
      return respond('upstream_unavailable', null, 503);
    }

    const titles = selectTitles(candidates, body.effectiveProviderIds);
    if (titles.length === 0) return respond('no_candidates', null);

    const result = await createGeneratedPool(token, body.groupId, titles);

    switch (result.status) {
      case 'created':
        return respond('created', result.pool_id);
      // Re-reported rather than trusted from the earlier read: membership or
      // access state can change between the check above and the write.
      case 'not_a_member':
        return respond('not_a_member', null);
      case 'group_in_grace':
        return respond('group_in_grace', null);
      case 'no_candidates':
        return respond('no_candidates', null);
      default:
        throw new Error(`unexpected create_generated_pool status: ${result.status}`);
    }
  } catch (cause) {
    console.error('generate-pool failed', cause);
    return respond('error', null, 500);
  }
});
