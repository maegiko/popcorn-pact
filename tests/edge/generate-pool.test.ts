import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The generate-pool contract: membership, grace, snapshot semantics, validation,
// deduplication and service filtering, driven through the TMDB adapter because
// its mock is the simplest one to state candidates in.
//
// This suite runs against TMDB whatever MEDIA_PROVIDER says -- see the pinned
// header in invokeGeneratePool. Whether those behaviours survive a change of
// provider is a separate question, asked in generate-pool-providers.test.ts.

type GenerateStatus =
  | 'created'
  | 'not_a_member'
  | 'group_in_grace'
  | 'no_candidates'
  | 'upstream_unavailable';

type GenerateResponse = {
  status: GenerateStatus;
  poolId: string | null;
};

type Candidate = {
  tmdb_id?: number;
  media_type?: 'movie' | 'tv' | string;
  provider_ids?: number[];
};

type TestUser = {
  id: string;
  email: string;
  token: string;
  client: SupabaseClient;
};

type MockUpstream =
  | { status: 'ok'; candidates: Candidate[] }
  | { status: 'failure' };

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const TEST_PASSWORD = 'password-for-generated-pool-tests';

let admin: SupabaseClient;
let mockServer: Server;
let mockServerUrl: string;
let mockUpstream: MockUpstream = { status: 'ok', candidates: [] };
const createdUserIds: string[] = [];
let nextUserNumber = 500;

function requireTestEnv() {
  if (!SUPABASE_ANON_KEY) {
    throw new Error('Set SUPABASE_TEST_ANON_KEY or EXPO_PUBLIC_SUPABASE_KEY for edge tests.');
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Set SUPABASE_TEST_SERVICE_ROLE_KEY for edge tests.');
  }
}

beforeAll(async () => {
  requireTestEnv();

  admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  mockServer = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (mockUpstream.status === 'failure') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'tmdb unavailable' }));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: mockUpstream.candidates }));
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', resolve);
  });

  const address = mockServer.address() as AddressInfo;
  mockServerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await Promise.all(
    createdUserIds.map((userId) => admin.auth.admin.deleteUser(userId).catch(() => null))
  );

  await new Promise<void>((resolve, reject) => {
    mockServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

beforeEach(() => {
  mockUpstream = { status: 'ok', candidates: [] };
});

async function createUser(displayName: string): Promise<TestUser> {
  const id = nextUserNumber++;
  const email = `generated-pool-${id}@example.test`;

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

  return {
    id: signedIn.data.user.id,
    email,
    token: signedIn.data.session.access_token,
    client,
  };
}

async function createGroup(owner: TestUser, partner?: TestUser): Promise<string> {
  const created = await owner.client.rpc('create_group');
  if (created.error) throw created.error;

  const group = firstRow<{ status: string; group_id: string; invite_code: string }>(created.data);
  if (!group || group.status !== 'created') {
    throw new Error(`Expected created group, got ${JSON.stringify(group)}.`);
  }

  if (partner) {
    const joined = await partner.client.rpc('join_group_with_invite', {
      p_code: group.invite_code,
    });
    if (joined.error) throw joined.error;

    const joinResult = firstRow<{ status: string }>(joined.data);
    if (joinResult?.status !== 'joined') {
      throw new Error(`Expected partner to join group, got ${JSON.stringify(joinResult)}.`);
    }
  }

  return group.group_id;
}

async function createGraceGroup(): Promise<{ groupId: string; owner: TestUser }> {
  const [owner, memberA, memberB] = await Promise.all([
    createUser('Grace Owner'),
    createUser('Grace Member A'),
    createUser('Grace Member B'),
  ]);
  const groupId = crypto.randomUUID();

  const group = await admin.from('groups').insert({ id: groupId, created_by: owner.id });
  if (group.error) throw group.error;

  const members = await admin.from('group_members').insert([
    { group_id: groupId, user_id: owner.id },
    { group_id: groupId, user_id: memberA.id },
    { group_id: groupId, user_id: memberB.id },
  ]);
  if (members.error) throw members.error;

  return { groupId, owner };
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return (data as T | null) ?? null;
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
      // Test harness only: the public contract is the Edge Function endpoint.
      // These supply a mocked upstream boundary without mocking database
      // behavior.
      //
      // The provider is pinned rather than inherited from MEDIA_PROVIDER. The
      // mock below answers with TMDB-shaped rows, so a developer whose stack is
      // configured for TVDB would otherwise be running this suite against an
      // adapter that cannot read them -- and the service-filter cases would
      // correctly come back filter_unsupported, failing for a reason that has
      // nothing to do with what they assert. Provider-independent behaviour is
      // covered by generate-pool-providers.test.ts.
      'x-popcornpact-test-media-base-url': mockServerUrl,
      'x-popcornpact-test-media-provider': 'tmdb',
    },
    body: JSON.stringify(body),
  });

  return (await response.json()) as GenerateResponse;
}

async function poolCountForGroup(groupId: string): Promise<number> {
  const result = await admin.from('pools').select('id', { count: 'exact', head: true }).eq('group_id', groupId);
  if (result.error) throw result.error;
  return result.count ?? 0;
}

/**
 * The titles in a pool, named by the provider that supplied them.
 *
 * Pools store canonical media ids, so "which titles are in this pool" is a
 * question about identity mapping now rather than a column read. Resolving back
 * through media_external_ids is what keeps these assertions readable, and it
 * also proves the mapping was written: a pool title with no identity under the
 * expected provider is a failure rather than a silently missing row.
 */
async function titlesForPool(
  poolId: string,
  provider = 'tmdb'
): Promise<{ tmdb_id: number; media_type: string }[]> {
  const titles = await admin.from('pool_titles').select('media_id').eq('pool_id', poolId);
  if (titles.error) throw titles.error;

  const mediaIds = (titles.data ?? []).map((row) => row.media_id as string);
  if (mediaIds.length === 0) return [];

  const mapped = await admin
    .from('media_external_ids')
    .select('media_id, media_type, external_id')
    .eq('provider', provider)
    .in('media_id', mediaIds);
  if (mapped.error) throw mapped.error;

  const byMediaId = new Map(mapped.data!.map((row) => [row.media_id as string, row]));

  return mediaIds
    .map((mediaId) => {
      const row = byMediaId.get(mediaId);
      if (!row) throw new Error(`Pool title ${mediaId} carries no ${provider} identity.`);
      return { tmdb_id: Number(row.external_id), media_type: row.media_type as string };
    })
    .sort((a, b) => a.tmdb_id - b.tmdb_id || a.media_type.localeCompare(b.media_type));
}

describe('generate-pool Edge Function contract', () => {
  test('any current group member may request a generated pool', async () => {
    const [owner, partner] = await Promise.all([
      createUser('Pool Owner'),
      createUser('Pool Partner'),
    ]);
    const groupId = await createGroup(owner, partner);
    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 101, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'tv', provider_ids: [8] },
      ],
    };

    const result = await invokeGeneratePool(partner, { groupId, effectiveProviderIds: [8] });

    expect(result).toMatchObject({ status: 'created' });
    expect(result.poolId).toEqual(expect.any(String));

    const pool = await admin
      .from('pools')
      .select('group_id, created_by, mode')
      .eq('id', result.poolId)
      .single();

    expect(pool.error).toBeNull();
    expect(pool.data).toEqual({
      group_id: groupId,
      created_by: partner.id,
      mode: 'generated',
    });
    expect(await titlesForPool(result.poolId!)).toEqual([
      { tmdb_id: 101, media_type: 'movie' },
      { tmdb_id: 202, media_type: 'tv' },
    ]);
  });

  test('non-member may not generate a pool for another group', async () => {
    const [owner, stranger] = await Promise.all([
      createUser('Pool Owner'),
      createUser('Pool Stranger'),
    ]);
    const groupId = await createGroup(owner);
    const beforeCount = await poolCountForGroup(groupId);
    mockUpstream = {
      status: 'ok',
      candidates: [{ tmdb_id: 101, media_type: 'movie', provider_ids: [8] }],
    };

    const result = await invokeGeneratePool(stranger, { groupId, effectiveProviderIds: [8] });

    expect(result).toEqual({ status: 'not_a_member', poolId: null });
    expect(await poolCountForGroup(groupId)).toBe(beforeCount);
  });

  test('group in grace may not generate or populate a pool', async () => {
    const { groupId, owner } = await createGraceGroup();
    mockUpstream = {
      status: 'ok',
      candidates: [{ tmdb_id: 101, media_type: 'movie', provider_ids: [8] }],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(result).toEqual({ status: 'group_in_grace', poolId: null });
    expect(await poolCountForGroup(groupId)).toBe(0);
  });

  test('generated pool is a finite snapshot rather than a live feed', async () => {
    const owner = await createUser('Pool Owner');
    const groupId = await createGroup(owner);
    mockUpstream = {
      status: 'ok',
      candidates: [{ tmdb_id: 101, media_type: 'movie', provider_ids: [8] }],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });
    expect(result.status).toBe('created');

    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 101, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'movie', provider_ids: [8] },
      ],
    };

    expect(await titlesForPool(result.poolId!)).toEqual([{ tmdb_id: 101, media_type: 'movie' }]);
  });

  test('duplicate candidate titles appear once while movie and tv identities remain distinct', async () => {
    const owner = await createUser('Pool Owner');
    const groupId = await createGroup(owner);
    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 123, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 123, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 123, media_type: 'tv', provider_ids: [8] },
      ],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(result.status).toBe('created');
    expect(await titlesForPool(result.poolId!)).toEqual([
      { tmdb_id: 123, media_type: 'movie' },
      { tmdb_id: 123, media_type: 'tv' },
    ]);
  });

  test('regenerating creates a new pool and leaves the previous pool intact', async () => {
    const owner = await createUser('Pool Owner');
    const groupId = await createGroup(owner);
    mockUpstream = {
      status: 'ok',
      candidates: [{ tmdb_id: 101, media_type: 'movie', provider_ids: [8] }],
    };

    const first = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });
    expect(first.status).toBe('created');

    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 101, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'tv', provider_ids: [8] },
      ],
    };

    const second = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(second.status).toBe('created');
    expect(second.poolId).not.toBe(first.poolId);
    expect(await titlesForPool(first.poolId!)).toEqual([{ tmdb_id: 101, media_type: 'movie' }]);
    expect(await titlesForPool(second.poolId!)).toEqual([
      { tmdb_id: 101, media_type: 'movie' },
      { tmdb_id: 202, media_type: 'tv' },
    ]);
  });

  test('all members with no selected services generate without a provider filter', async () => {
    const [owner, partner] = await Promise.all([
      createUser('Pool Owner'),
      createUser('Pool Partner'),
    ]);
    const groupId = await createGroup(owner, partner);
    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 101, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'movie', provider_ids: [384] },
      ],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: null });

    expect(result.status).toBe('created');
    expect(await titlesForPool(result.poolId!)).toEqual([
      { tmdb_id: 101, media_type: 'movie' },
      { tmdb_id: 202, media_type: 'movie' },
    ]);
  });

  test('a member with no selected services contributes no provider constraint', async () => {
    const [owner, partner] = await Promise.all([
      createUser('Pool Owner'),
      createUser('Pool Partner'),
    ]);
    const groupId = await createGroup(owner, partner);
    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 101, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'movie', provider_ids: [384] },
        { tmdb_id: 303, media_type: 'movie', provider_ids: [337] },
      ],
    };

    const result = await invokeGeneratePool(owner, {
      groupId,
      effectiveProviderIds: [8, 384],
    });

    expect(result.status).toBe('created');
    expect(await titlesForPool(result.poolId!)).toEqual([
      { tmdb_id: 101, media_type: 'movie' },
      { tmdb_id: 202, media_type: 'movie' },
    ]);
  });

  test('members with selected services generate from their common providers', async () => {
    const [owner, partner] = await Promise.all([
      createUser('Pool Owner'),
      createUser('Pool Partner'),
    ]);
    const groupId = await createGroup(owner, partner);
    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 101, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'movie', provider_ids: [384] },
      ],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(result.status).toBe('created');
    expect(await titlesForPool(result.poolId!)).toEqual([{ tmdb_id: 101, media_type: 'movie' }]);
  });

  test('no common selected provider creates no pool and returns no_candidates', async () => {
    const [owner, partner] = await Promise.all([
      createUser('Pool Owner'),
      createUser('Pool Partner'),
    ]);
    const groupId = await createGroup(owner, partner);
    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 101, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'movie', provider_ids: [384] },
      ],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [] });

    expect(result).toEqual({ status: 'no_candidates', poolId: null });
    expect(await poolCountForGroup(groupId)).toBe(0);
  });

  test('malformed candidates are ignored and generation succeeds if a valid candidate remains', async () => {
    const owner = await createUser('Pool Owner');
    const groupId = await createGroup(owner);
    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: -1, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'podcast', provider_ids: [8] },
        { tmdb_id: 303, media_type: 'tv', provider_ids: [8] },
      ],
    };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(result.status).toBe('created');
    expect(await titlesForPool(result.poolId!)).toEqual([{ tmdb_id: 303, media_type: 'tv' }]);
  });

  test('empty or fully malformed upstream results create no pool and return no_candidates', async () => {
    const owner = await createUser('Pool Owner');
    const groupId = await createGroup(owner);
    mockUpstream = {
      status: 'ok',
      candidates: [
        { tmdb_id: 0, media_type: 'movie', provider_ids: [8] },
        { tmdb_id: 202, media_type: 'podcast', provider_ids: [8] },
      ],
    };

    const malformed = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });
    mockUpstream = { status: 'ok', candidates: [] };
    const empty = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(malformed).toEqual({ status: 'no_candidates', poolId: null });
    expect(empty).toEqual({ status: 'no_candidates', poolId: null });
    expect(await poolCountForGroup(groupId)).toBe(0);
  });

  test('upstream failure leaves no partial pool or titles', async () => {
    const owner = await createUser('Pool Owner');
    const groupId = await createGroup(owner);
    mockUpstream = { status: 'failure' };

    const result = await invokeGeneratePool(owner, { groupId, effectiveProviderIds: [8] });

    expect(result).toEqual({ status: 'upstream_unavailable', poolId: null });
    expect(await poolCountForGroup(groupId)).toBe(0);
  });
});
