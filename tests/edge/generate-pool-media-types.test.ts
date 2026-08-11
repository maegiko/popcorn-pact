import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Real TMDB generation draws movies and TV from two separate discover endpoints.
// The suite in generate-pool.test.ts mocks a single upstream that answers every
// path identically, which cannot tell the two apart; this one routes by path so
// the merge, the per-endpoint typing and the partial-failure behaviour are all
// observable.

type GenerateResponse = {
  status: 'created' | 'not_a_member' | 'group_in_grace' | 'no_candidates' | 'upstream_unavailable';
  poolId: string | null;
};

type Candidate = {
  tmdb_id?: number;
  id?: number;
  media_type?: string;
  provider_ids?: number[];
};

type EndpointResponse = { status: 'ok'; candidates: Candidate[] } | { status: 'failure' };

type TestUser = { id: string; token: string; client: SupabaseClient };

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const TEST_PASSWORD = 'password-for-generated-pool-media-tests';

let admin: SupabaseClient;
let mockServer: Server;
let mockServerUrl: string;
let movieResponse: EndpointResponse = { status: 'ok', candidates: [] };
let tvResponse: EndpointResponse = { status: 'ok', candidates: [] };
let requestedPaths: string[] = [];
const createdUserIds: string[] = [];
let nextUserNumber = 700;

beforeAll(async () => {
  if (!SUPABASE_ANON_KEY) {
    throw new Error('Set SUPABASE_TEST_ANON_KEY or EXPO_PUBLIC_SUPABASE_KEY for edge tests.');
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Set SUPABASE_TEST_SERVICE_ROLE_KEY for edge tests.');
  }

  admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  mockServer = createServer((request, response) => {
    const url = request.url ?? '';
    requestedPaths.push(url);

    const endpoint = url.split('?')[0].startsWith('/discover/tv') ? tvResponse : movieResponse;

    if (endpoint.status === 'failure') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'tmdb unavailable' }));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: endpoint.candidates }));
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', resolve);
  });

  const address = mockServer.address() as AddressInfo;
  mockServerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId).catch(() => null);
  }

  await new Promise<void>((resolve, reject) => {
    mockServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

beforeEach(() => {
  movieResponse = { status: 'ok', candidates: [] };
  tvResponse = { status: 'ok', candidates: [] };
  requestedPaths = [];
});

async function createUser(displayName: string): Promise<TestUser> {
  const email = `generate-pool-media-${nextUserNumber++}@example.test`;

  const created = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (created.error) throw created.error;
  if (!created.data.user) throw new Error('Expected Supabase to return created user.');

  createdUserIds.push(created.data.user.id);

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const signedIn = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (signedIn.error) throw signedIn.error;
  if (!signedIn.data.session) throw new Error('Expected Supabase to return a session.');

  return { id: signedIn.data.user.id, token: signedIn.data.session.access_token, client };
}

async function createGroup(owner: TestUser): Promise<string> {
  const created = await owner.client.rpc('create_group');
  if (created.error) throw created.error;

  const rows = created.data as { status: string; group_id: string }[] | null;
  const group = Array.isArray(rows) ? rows[0] : null;
  if (!group || group.status !== 'created') {
    throw new Error(`Expected created group, got ${JSON.stringify(group)}.`);
  }

  return group.group_id;
}

async function invokeGeneratePool(
  user: TestUser,
  body: { groupId: string; effectiveProviderIds: number[] | null }
): Promise<GenerateResponse> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-pool`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY!,
      authorization: `Bearer ${user.token}`,
      'content-type': 'application/json',
      'x-popcornpact-test-tmdb-base-url': mockServerUrl,
    },
    body: JSON.stringify(body),
  });

  return (await response.json()) as GenerateResponse;
}

async function titlesForPool(poolId: string): Promise<{ tmdb_id: number; media_type: string }[]> {
  const result = await admin
    .from('pool_titles')
    .select('tmdb_id, media_type')
    .eq('pool_id', poolId)
    .order('tmdb_id')
    .order('media_type');

  if (result.error) throw result.error;
  return result.data ?? [];
}

async function poolCountForGroup(groupId: string): Promise<number> {
  const result = await admin
    .from('pools')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId);

  if (result.error) throw result.error;
  return result.count ?? 0;
}

describe('generate-pool draws candidates from both TMDB discover endpoints', () => {
  test('a generated pool merges movies and TV into one snapshot', async () => {
    const owner = await createUser('Media Owner');
    const groupId = await createGroup(owner);
    movieResponse = {
      status: 'ok',
      candidates: [{ tmdb_id: 11, media_type: 'movie', provider_ids: [8] }],
    };
    tvResponse = {
      status: 'ok',
      candidates: [{ tmdb_id: 22, media_type: 'tv', provider_ids: [8] }],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(result.status).toBe('created');
    expect(await titlesForPool(result.poolId!)).toEqual([
      { tmdb_id: 11, media_type: 'movie' },
      { tmdb_id: 22, media_type: 'tv' },
    ]);
  });

  test('the same numeric TMDB id from each endpoint stays two distinct titles', async () => {
    const owner = await createUser('Media Owner');
    const groupId = await createGroup(owner);
    movieResponse = {
      status: 'ok',
      candidates: [{ tmdb_id: 777, media_type: 'movie', provider_ids: [8] }],
    };
    tvResponse = {
      status: 'ok',
      candidates: [{ tmdb_id: 777, media_type: 'tv', provider_ids: [8] }],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(result.status).toBe('created');
    expect(await titlesForPool(result.poolId!)).toEqual([
      { tmdb_id: 777, media_type: 'movie' },
      { tmdb_id: 777, media_type: 'tv' },
    ]);
  });

  // TMDB's discover rows carry `id` and no media_type at all: the endpoint is
  // what says whether a row is a film or a series.
  test('TMDB-shaped rows are typed by the endpoint that returned them', async () => {
    const owner = await createUser('Media Owner');
    const groupId = await createGroup(owner);
    movieResponse = { status: 'ok', candidates: [{ id: 31 }] };
    tvResponse = { status: 'ok', candidates: [{ id: 32 }] };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: null });

    expect(result.status).toBe('created');
    expect(await titlesForPool(result.poolId!)).toEqual([
      { tmdb_id: 31, media_type: 'movie' },
      { tmdb_id: 32, media_type: 'tv' },
    ]);
  });

  test('both endpoints are queried, and the provider filter reaches each of them', async () => {
    const owner = await createUser('Media Owner');
    const groupId = await createGroup(owner);
    movieResponse = { status: 'ok', candidates: [{ id: 41 }] };
    tvResponse = { status: 'ok', candidates: [{ id: 42 }] };

    await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8, 384] });

    const movieRequest = requestedPaths.find((path) => path.startsWith('/discover/movie'));
    const tvRequest = requestedPaths.find((path) => path.startsWith('/discover/tv'));

    expect(movieRequest).toBeDefined();
    expect(tvRequest).toBeDefined();
    expect(movieRequest).toContain('with_watch_providers=8%7C384');
    expect(tvRequest).toContain('with_watch_providers=8%7C384');
  });

  test('one failing endpoint still produces a pool from the other', async () => {
    const owner = await createUser('Media Owner');
    const groupId = await createGroup(owner);

    movieResponse = {
      status: 'ok',
      candidates: [{ tmdb_id: 51, media_type: 'movie', provider_ids: [8] }],
    };
    tvResponse = { status: 'failure' };

    const tvDown = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(tvDown.status).toBe('created');
    expect(await titlesForPool(tvDown.poolId!)).toEqual([{ tmdb_id: 51, media_type: 'movie' }]);

    movieResponse = { status: 'failure' };
    tvResponse = {
      status: 'ok',
      candidates: [{ tmdb_id: 52, media_type: 'tv', provider_ids: [8] }],
    };

    const movieDown = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(movieDown.status).toBe('created');
    expect(await titlesForPool(movieDown.poolId!)).toEqual([{ tmdb_id: 52, media_type: 'tv' }]);
  });

  test('both endpoints failing creates no pool at all', async () => {
    const owner = await createUser('Media Owner');
    const groupId = await createGroup(owner);
    movieResponse = { status: 'failure' };
    tvResponse = { status: 'failure' };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(result).toEqual({ status: 'upstream_unavailable', poolId: null });
    expect(await poolCountForGroup(groupId)).toBe(0);
  });
});
