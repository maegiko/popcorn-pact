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
//   provider.discover()          canonical media records, from whichever
//                                upstream this deployment is configured for
//   select                       dedupe and cap: a pool is a finite snapshot
//   create_generated_pool()      one transaction: pool row, media rows, titles
//
// Nothing is written until the candidate list is known to be non-empty, so a
// failure anywhere above leaves no pool behind to clean up -- which matters,
// because clients hold no delete on pools and there is no cleanup path.
//
// Note what is NOT here: no discover URL, no watch-provider id, no poster path,
// no login exchange. This file has no idea whether it is talking to TMDB, TVDB
// or Streaming Availability; it asks a MediaProvider for canonical records and
// works in those terms. Everything provider-shaped lives in ../_shared/media.
//
// Outcomes are returned as a status in a 200 body, the same discriminated-union
// shape the database RPCs use. "You are not in that group" and "there was
// nothing to show you" are answers, not faults. HTTP error codes are reserved
// for genuine faults: a bad request, a missing session, an unreachable upstream.

import {
  configuredProviderName,
  createMediaProvider,
  defaultBaseUrl,
  diagnoseConfiguredTvdbOverviews,
  isProviderName,
  type ProviderName,
} from '../_shared/media/registry.ts';
import { isLoopbackHost } from '../_shared/media/http.ts';
import {
  TvdbOverviewDiagnosticError,
  type TvdbOverviewDiagnostic,
} from '../_shared/media/providers/tvdb.ts';
import {
  MEDIA_TYPES,
  MediaProviderUnavailableError,
  type MediaRecord,
  type ServiceFilter,
} from '../_shared/media/types.ts';

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

// A pool is a finite snapshot, not a feed. This cap is what makes that true
// regardless of how much the upstream returns. It is generous next to a single
// discover page (20 rows per media type), so in practice it bounds pathological
// upstreams rather than trimming ordinary ones -- which is why plain
// concatenation of the two media types cannot starve one of them here.
const MAX_POOL_TITLES = 60;
const TVDB_OVERVIEW_DIAGNOSTIC = 'tvdb-overview';

// TEST/DEVELOPMENT SEAM. Lets the test suite point generation at a mock upstream,
// and exercise a provider other than the configured one, without mocking the
// database. Neither header is production configuration and neither can be used
// as such: the base URL is honoured only when it addresses a loopback host and
// only when POPCORNPACT_ENV does not say production, and the provider header is
// honoured only once the base URL override has already been accepted. A deployed
// function therefore cannot be redirected or re-provisioned by a caller.
const TEST_BASE_URL_HEADER = 'x-popcornpact-test-media-base-url';
const TEST_PROVIDER_HEADER = 'x-popcornpact-test-media-provider';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

type GenerateStatus =
  // The contract the client depends on.
  | 'created'
  | 'not_a_member'
  | 'group_in_grace'
  | 'no_candidates'
  | 'filter_unsupported'
  | 'upstream_unavailable'
  // Faults a correct client never provokes.
  | 'invalid_request'
  | 'unauthenticated'
  | 'error';

type DiagnosticStatus =
  | 'tvdb_overview_ok'
  | 'tvdb_no_overview'
  | 'tvdb_normalization_failure'
  | 'tvdb_authentication_failure'
  | 'tvdb_network_or_rate_limit_failure'
  | 'tvdb_provider_failure'
  | 'diagnostic_forbidden';

type GenerateRequest = { kind: 'generate'; groupId: string; services: ServiceFilter };
type DiagnosticRequest = { kind: 'tvdb-overview'; groupId: string };
type FunctionRequest = GenerateRequest | DiagnosticRequest;

// One canonical media record, in the shape create_generated_pool() reads. This
// is the only place the two vocabularies meet, and it is a rename and nothing
// more -- no provider field survives into it.
type RpcTitle = {
  media_type: string;
  title: string | null;
  release_year: number | null;
  overview: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  external_ids: Record<string, string>;
};

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
  'access-control-allow-headers': [
    'authorization',
    'apikey',
    'content-type',
    'x-client-info',
    TEST_BASE_URL_HEADER,
    TEST_PROVIDER_HEADER,
  ].join(', '),
};

function respond(status: GenerateStatus, poolId: string | null, httpStatus = 200): Response {
  return new Response(JSON.stringify({ status, poolId }), {
    status: httpStatus,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function respondToDiagnostic(
  status: DiagnosticStatus,
  diagnostic: TvdbOverviewDiagnostic | null,
  httpStatus = 200
): Response {
  return new Response(JSON.stringify({ status, diagnostic }), {
    status: httpStatus,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function parseRequest(request: Request): Promise<FunctionRequest | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (typeof body !== 'object' || body === null) return null;
  const { groupId, effectiveProviderIds, diagnostic } = body as Record<string, unknown>;

  if (typeof groupId !== 'string' || groupId.trim() === '') return null;
  if (diagnostic === TVDB_OVERVIEW_DIAGNOSTIC) {
    return { kind: 'tvdb-overview', groupId };
  }
  if (diagnostic !== undefined) return null;

  // Narrowing by streaming service is optional, so an absent key means the same
  // as null: no filter. An explicit empty array does NOT -- that means "no
  // service is eligible", which is a real and different answer.
  if (effectiveProviderIds === null || effectiveProviderIds === undefined) {
    return { kind: 'generate', groupId, services: null };
  }

  if (!Array.isArray(effectiveProviderIds)) return null;

  // Numbers today, because `streaming_services` will carry TMDB watch-provider
  // ids first; strings are accepted so a provider whose catalogues are named
  // (`netflix`, `prime.subscription`) needs no contract change. Either way the
  // core treats them as opaque tokens -- only the adapter knows what they mean.
  const services: string[] = [];
  for (const entry of effectiveProviderIds) {
    if (typeof entry === 'number' && Number.isInteger(entry)) {
      services.push(String(entry));
      continue;
    }
    if (typeof entry === 'string' && entry.trim() !== '') {
      services.push(entry.trim());
      continue;
    }
    return null;
  }

  return { kind: 'generate', groupId, services };
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
async function readGroupAccess(
  token: string,
  groupId: string
): Promise<{ state: string; createdBy: string } | null> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/group_access`);
  url.searchParams.set('select', 'state,created_by');
  url.searchParams.set('group_id', `eq.${groupId}`);

  const response = await fetch(url, { headers: callerHeaders(token) });
  if (!response.ok) throw new Error(`group_access responded ${response.status}`);

  const rows = (await response.json()) as { state?: unknown; created_by?: unknown }[];
  const state = rows[0]?.state;
  const createdBy = rows[0]?.created_by;
  return typeof state === 'string' && typeof createdBy === 'string'
    ? { state, createdBy }
    : null;
}

async function createGeneratedPool(
  token: string,
  groupId: string,
  titles: RpcTitle[]
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
// Provider resolution.
// ---------------------------------------------------------------------------

function resolveProvider(request: Request) {
  const configured = configuredProviderName();
  const override = testOverrides(request);

  const name: ProviderName = override?.provider ?? configured;
  const baseUrl = override?.baseUrl ?? defaultBaseUrl(name);

  return createMediaProvider(name, baseUrl);
}

async function runTvdbOverviewDiagnostic(request: Request): Promise<Response> {
  const override = testOverrides(request);

  try {
    const diagnostic = await diagnoseConfiguredTvdbOverviews(
      MAX_POOL_TITLES,
      override?.provider === 'tvdb' ? override.baseUrl : undefined
    );

    if (
      diagnostic.normalizationDroppedCount > 0 ||
      diagnostic.movieDetails.normalizationDroppedCount > 0
    ) {
      return respondToDiagnostic('tvdb_normalization_failure', diagnostic);
    }
    const detailFailure = diagnostic.movieDetails.samples.find((item) => item.failure !== null)?.failure;
    if (detailFailure === 'authentication') {
      return respondToDiagnostic('tvdb_authentication_failure', diagnostic, 502);
    }
    if (detailFailure === 'network_or_rate_limit') {
      return respondToDiagnostic('tvdb_network_or_rate_limit_failure', diagnostic, 503);
    }
    if (detailFailure === 'provider') {
      return respondToDiagnostic('tvdb_provider_failure', diagnostic, 502);
    }
    if (
      diagnostic.rawOverviewPresentCount === 0 ||
      diagnostic.normalizedOverviewPresentCount === 0
    ) {
      return respondToDiagnostic('tvdb_no_overview', diagnostic);
    }
    return respondToDiagnostic('tvdb_overview_ok', diagnostic);
  } catch (cause) {
    if (!(cause instanceof TvdbOverviewDiagnosticError)) throw cause;

    switch (cause.failure) {
      case 'authentication':
        return respondToDiagnostic('tvdb_authentication_failure', null, 502);
      case 'network_or_rate_limit':
        return respondToDiagnostic('tvdb_network_or_rate_limit_failure', null, 503);
      case 'provider':
        return respondToDiagnostic('tvdb_provider_failure', null, 502);
    }
  }
}

/**
 * The test seam, gated so it cannot be used as a back door.
 *
 * A provider override is only read once a loopback base URL has been accepted,
 * so the worst a caller of a deployed function can do is nothing: without a
 * loopback address there is no override at all, and a loopback address is not
 * reachable from outside the machine running the function.
 */
function testOverrides(
  request: Request
): { baseUrl: string; provider: ProviderName | null } | null {
  const rawBaseUrl = request.headers.get(TEST_BASE_URL_HEADER);
  if (!rawBaseUrl) return null;
  if (Deno.env.get('POPCORNPACT_ENV') === 'production') return null;

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    return null;
  }

  if (!isLoopbackHost(parsed.hostname)) return null;

  const rawProvider = (request.headers.get(TEST_PROVIDER_HEADER) ?? '').trim().toLowerCase();

  return {
    baseUrl: rawBaseUrl.replace(/\/+$/, ''),
    provider: isProviderName(rawProvider) ? rawProvider : null,
  };
}

// ---------------------------------------------------------------------------
// Candidate selection.
//
// The provider has already dropped rows it could not understand -- one bad row
// in a page of forty is not a reason to leave the group with nothing. What is
// left to do here is provider-independent: collapse records that turn out to be
// the same title, and stop at the cap.
// ---------------------------------------------------------------------------

function selectTitles(records: MediaRecord[], limit: number): MediaRecord[] {
  const seen = new Set<string>();
  const selected: MediaRecord[] = [];

  for (const record of records) {
    if (selected.length >= limit) break;

    // A record is identified by every mapping it carries, so two records that
    // agree on any one of them are the same title -- which is how a provider
    // that returns both an imdb and a tmdb id deduplicates against itself.
    // media_type is part of each key because a film and a series can share a
    // number, and they are different titles.
    const keys = Object.entries(record.externalIds)
      .filter(([, id]) => id !== '')
      .map(([provider, id]) => `${provider}:${record.mediaType}:${id}`);

    if (keys.length === 0) continue;
    if (keys.some((key) => seen.has(key))) continue;

    keys.forEach((key) => seen.add(key));
    selected.push(record);
  }

  return selected;
}

function toRpcTitle(record: MediaRecord): RpcTitle {
  return {
    media_type: record.mediaType,
    title: record.title,
    release_year: record.releaseYear,
    overview: record.overview,
    poster_url: record.posterUrl,
    backdrop_url: record.backdropUrl,
    external_ids: record.externalIds,
  };
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

    const access = await readGroupAccess(token, body.groupId);
    if (access === null) return respond('not_a_member', null);
    if (access.state !== 'active') return respond('group_in_grace', null);

    if (body.kind === 'tvdb-overview') {
      if (access.createdBy !== userId) {
        return respondToDiagnostic('diagnostic_forbidden', null, 403);
      }
      return await runTvdbOverviewDiagnostic(request);
    }

    // An explicit empty service list means no service is eligible, so no title
    // can be. Answered without calling the upstream at all.
    if (body.services !== null && body.services.length === 0) {
      return respond('no_candidates', null);
    }

    const provider = resolveProvider(request);

    // Streaming availability is an optional capability, and a provider that
    // lacks it must say so rather than quietly widen the pool. The group chose
    // those services deliberately; handing them titles they cannot watch would
    // be a worse answer than admitting the filter cannot be applied. Nothing
    // here tells the client *which* provider is configured -- only that this
    // deployment cannot honour that constraint right now.
    if (body.services !== null && !provider.capabilities.streamingAvailability) {
      return respond('filter_unsupported', null);
    }

    let records: MediaRecord[];
    try {
      records = await provider.discover({
        mediaTypes: MEDIA_TYPES,
        services: body.services,
        limit: MAX_POOL_TITLES,
      });
    } catch (cause) {
      if (!(cause instanceof MediaProviderUnavailableError)) throw cause;
      console.error('generate-pool upstream failure', cause);
      return respond('upstream_unavailable', null, 503);
    }

    const titles = selectTitles(records, MAX_POOL_TITLES);
    if (titles.length === 0) return respond('no_candidates', null);

    const result = await createGeneratedPool(token, body.groupId, titles.map(toRpcTitle));

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
