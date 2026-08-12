import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Provider portability.
//
// The other two edge suites drive generation through the default (TMDB) adapter.
// This one drives the same public endpoint through three upstreams whose
// responses have nothing in common -- TMDB's `results` of `id`/`poster_path`,
// TVDB's login-then-`data` of `name`/`image`, Streaming Availability's `shows`
// of `showType`/`imageSet` -- and asserts that what comes out the other side is
// the same contract and the same canonical model every time.
//
// Everything here is observed through the endpoint and the database. Nothing
// asserts how an adapter is written.

type GenerateResponse = {
  status: string;
  poolId: string | null;
};

type ProviderName = 'tmdb' | 'tvdb' | 'streaming-availability';

type UpstreamState = {
  failing: boolean;
  tmdb: Record<'movie' | 'tv', unknown[]>;
  tvdb: Record<'movie' | 'tv', unknown[]>;
  streamingAvailability: Record<'movie' | 'tv', unknown[]>;
};

type CanonicalTitle = {
  media_type: string;
  title: string | null;
  release_year: number | null;
  poster_url: string | null;
  external: Record<string, string>;
};

type TestUser = { id: string; token: string; client: SupabaseClient };

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const TEST_PASSWORD = 'password-for-provider-portability-tests';

let admin: SupabaseClient;
let mockServer: Server;
let mockServerUrl: string;
let upstream: UpstreamState;
let requestedPaths: string[] = [];
const createdUserIds: string[] = [];
let nextUserNumber = 900;

function emptyUpstream(): UpstreamState {
  return {
    failing: false,
    tmdb: { movie: [], tv: [] },
    tvdb: { movie: [], tv: [] },
    streamingAvailability: { movie: [], tv: [] },
  };
}

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

  // One server standing in for three different APIs, routed by the paths each
  // provider actually calls. Which routes get hit is itself evidence: an adapter
  // that fetched TMDB paths while configured as TVDB would fail here.
  mockServer = createServer((request, response) => {
    const url = request.url ?? '';
    requestedPaths.push(url);

    const path = url.split('?')[0];
    const query = new URLSearchParams(url.split('?')[1] ?? '');

    if (upstream.failing) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'upstream unavailable' }));
      return;
    }

    const send = (payload: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (path === '/login') return send({ status: 'success', data: { token: 'tvdb-test-token' } });
    if (path === '/movies') return send({ data: upstream.tvdb.movie });
    if (path === '/series') return send({ data: upstream.tvdb.tv });

    if (path === '/discover/movie') return send({ results: upstream.tmdb.movie });
    if (path === '/discover/tv') return send({ results: upstream.tmdb.tv });

    if (path === '/shows/search/filters') {
      const shows =
        query.get('show_type') === 'series'
          ? upstream.streamingAvailability.tv
          : upstream.streamingAvailability.movie;
      return send({ shows });
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `unrouted path ${path}` }));
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
  upstream = emptyUpstream();
  requestedPaths = [];
});

async function createUser(displayName: string): Promise<TestUser> {
  const email = `generate-pool-providers-${nextUserNumber++}@example.test`;

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

/**
 * The public contract, plus the provider this deployment should behave as.
 *
 * Both headers are test-only seams gated to loopback addresses. The request body
 * is unchanged from what the app sends: the client never names a provider.
 */
async function invokeGeneratePool(
  user: TestUser,
  body: { groupId: string; effectiveProviderIds?: (number | string)[] | null },
  provider: ProviderName
): Promise<GenerateResponse> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-pool`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY!,
      authorization: `Bearer ${user.token}`,
      'content-type': 'application/json',
      'x-popcornpact-test-media-base-url': mockServerUrl,
      'x-popcornpact-test-media-provider': provider,
    },
    body: JSON.stringify(body),
  });

  return (await response.json()) as GenerateResponse;
}

/** Every pool title as the canonical record it resolved to. */
async function canonicalTitles(poolId: string): Promise<CanonicalTitle[]> {
  const titles = await admin.from('pool_titles').select('media_id').eq('pool_id', poolId);
  if (titles.error) throw titles.error;

  const mediaIds = (titles.data ?? []).map((row) => row.media_id as string);
  if (mediaIds.length === 0) return [];

  const media = await admin
    .from('media')
    .select('id, media_type, title, release_year, poster_url')
    .in('id', mediaIds);
  if (media.error) throw media.error;

  const external = await admin
    .from('media_external_ids')
    .select('media_id, provider, external_id')
    .in('media_id', mediaIds);
  if (external.error) throw external.error;

  return (media.data ?? [])
    .map((row) => ({
      media_type: row.media_type as string,
      title: (row.title as string | null) ?? null,
      release_year: (row.release_year as number | null) ?? null,
      poster_url: (row.poster_url as string | null) ?? null,
      external: Object.fromEntries(
        (external.data ?? [])
          .filter((mapping) => mapping.media_id === row.id)
          .map((mapping) => [mapping.provider as string, mapping.external_id as string])
      ),
    }))
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
}

async function mediaIdsForPool(poolId: string): Promise<string[]> {
  const titles = await admin.from('pool_titles').select('media_id').eq('pool_id', poolId);
  if (titles.error) throw titles.error;
  return (titles.data ?? []).map((row) => row.media_id as string).sort();
}

async function poolCountForGroup(groupId: string): Promise<number> {
  const result = await admin
    .from('pools')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId);

  if (result.error) throw result.error;
  return result.count ?? 0;
}

describe('generate-pool is independent of any one media provider', () => {
  test('a TVDB-shaped upstream produces the same contract as a TMDB-shaped one', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.tvdb.movie = [
      { id: 1001, name: 'A TVDB Film', year: '1994', image: '/banners/movies/1001.jpg' },
    ];
    upstream.tvdb.tv = [{ id: 2002, name: 'A TVDB Series', year: '2016', image: null }];

    const result = await invokeGeneratePool(owner, { groupId }, 'tvdb');

    expect(result.status).toBe('created');
    expect(result.poolId).toEqual(expect.any(String));
    expect(await canonicalTitles(result.poolId!)).toEqual([
      {
        media_type: 'movie',
        title: 'A TVDB Film',
        release_year: 1994,
        // A bare provider path is resolved against that provider's image host,
        // so what the app reads is always a usable URL.
        poster_url: 'https://artworks.thetvdb.com/banners/movies/1001.jpg',
        external: { tvdb: '1001' },
      },
      {
        media_type: 'tv',
        title: 'A TVDB Series',
        release_year: 2016,
        poster_url: null,
        external: { tvdb: '2002' },
      },
    ]);
  });

  test('a Streaming Availability upstream normalises into the same canonical model', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.streamingAvailability.movie = [
      {
        id: 'sa-3003',
        showType: 'movie',
        title: 'An Available Film',
        releaseYear: 2001,
        imdbId: 'tt3003',
        // Namespaced by this API, and unwrapped so it matches what TMDB writes.
        tmdbId: 'movie/3003',
        imageSet: { verticalPoster: { w480: 'https://cdn.example.test/p/3003.jpg' } },
      },
    ];

    const result = await invokeGeneratePool(owner, { groupId }, 'streaming-availability');

    expect(result.status).toBe('created');
    expect(await canonicalTitles(result.poolId!)).toEqual([
      {
        media_type: 'movie',
        title: 'An Available Film',
        release_year: 2001,
        poster_url: 'https://cdn.example.test/p/3003.jpg',
        external: { 'streaming-availability': 'sa-3003', imdb: 'tt3003', tmdb: '3003' },
      },
    ]);
  });

  test('the response never differs by provider, and never names one', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.tmdb.movie = [{ id: 4001, title: 'Via TMDB' }];
    upstream.tvdb.movie = [{ id: 4002, name: 'Via TVDB' }];
    upstream.streamingAvailability.movie = [
      { id: 'sa-4003', showType: 'movie', title: 'Via SA' },
    ];

    const responses = await Promise.all(
      (['tmdb', 'tvdb', 'streaming-availability'] as ProviderName[]).map((provider) =>
        invokeGeneratePool(owner, { groupId }, provider)
      )
    );

    for (const response of responses) {
      expect(Object.keys(response).sort()).toEqual(['poolId', 'status']);
      expect(response.status).toBe('created');
      expect(response.poolId).toEqual(expect.any(String));
      expect(JSON.stringify(response)).not.toMatch(/tmdb|tvdb|streaming-availability/i);
    }
  });

  test('the same number from two providers stays two different titles', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.tmdb.movie = [{ id: 5000, title: 'TMDB Five Thousand' }];
    upstream.tvdb.movie = [{ id: 5000, name: 'TVDB Five Thousand' }];

    const viaTmdb = await invokeGeneratePool(owner, { groupId }, 'tmdb');
    const viaTvdb = await invokeGeneratePool(owner, { groupId }, 'tvdb');

    const tmdbMedia = await mediaIdsForPool(viaTmdb.poolId!);
    const tvdbMedia = await mediaIdsForPool(viaTvdb.poolId!);

    expect(tmdbMedia).toHaveLength(1);
    expect(tvdbMedia).toHaveLength(1);
    expect(tmdbMedia).not.toEqual(tvdbMedia);
  });

  test('a title recognised across providers resolves to one canonical record', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.streamingAvailability.movie = [
      { id: 'sa-6006', showType: 'movie', title: 'Shared Title', tmdbId: 'movie/6006' },
    ];
    upstream.tmdb.movie = [{ id: 6006, title: 'Shared Title' }];

    const first = await invokeGeneratePool(owner, { groupId }, 'streaming-availability');
    const second = await invokeGeneratePool(owner, { groupId }, 'tmdb');

    // Two pools, two snapshots -- but the same title, because both providers
    // named it with a TMDB id and the mapping outlived the provider switch.
    expect(second.poolId).not.toBe(first.poolId);
    expect(await mediaIdsForPool(second.poolId!)).toEqual(await mediaIdsForPool(first.poolId!));
  });

  test('movie and tv stay distinct within a provider that reuses ids', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.tvdb.movie = [{ id: 900, name: 'Nine Hundred The Film' }];
    upstream.tvdb.tv = [{ id: 900, name: 'Nine Hundred The Series' }];

    const result = await invokeGeneratePool(owner, { groupId }, 'tvdb');

    expect(result.status).toBe('created');
    expect(await canonicalTitles(result.poolId!)).toEqual([
      {
        media_type: 'movie',
        title: 'Nine Hundred The Film',
        release_year: null,
        poster_url: null,
        external: { tvdb: '900' },
      },
      {
        media_type: 'tv',
        title: 'Nine Hundred The Series',
        release_year: null,
        poster_url: null,
        external: { tvdb: '900' },
      },
    ]);
  });

  test('a provider without availability data refuses a service filter rather than ignoring it', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.tvdb.movie = [{ id: 7007, name: 'Would Have Been Included' }];

    const filtered = await invokeGeneratePool(
      owner,
      { groupId, effectiveProviderIds: [8] },
      'tvdb'
    );

    expect(filtered).toEqual({ status: 'filter_unsupported', poolId: null });
    expect(await poolCountForGroup(groupId)).toBe(0);

    // The same provider is still perfectly usable for an unfiltered pool, which
    // is the whole point of availability being optional.
    const unfiltered = await invokeGeneratePool(owner, { groupId }, 'tvdb');

    expect(unfiltered.status).toBe('created');
    expect(await poolCountForGroup(groupId)).toBe(1);
  });

  test('a provider with availability data applies the service filter upstream', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.streamingAvailability.movie = [
      { id: 'sa-8008', showType: 'movie', title: 'On Netflix' },
    ];

    const result = await invokeGeneratePool(
      owner,
      { groupId, effectiveProviderIds: ['netflix', 'prime.subscription'] },
      'streaming-availability'
    );

    expect(result.status).toBe('created');
    const searches = requestedPaths.filter((path) => path.startsWith('/shows/search/filters'));
    expect(searches).toHaveLength(2);
    for (const search of searches) {
      expect(search).toContain('catalogs=netflix%2Cprime.subscription');
    }
  });

  test('an unreachable provider creates nothing, whichever provider it is', async () => {
    const owner = await createUser('Portability Owner');
    const groupId = await createGroup(owner);
    upstream.failing = true;

    for (const provider of ['tvdb', 'streaming-availability'] as ProviderName[]) {
      const result = await invokeGeneratePool(owner, { groupId }, provider);
      expect(result).toEqual({ status: 'upstream_unavailable', poolId: null });
    }

    expect(await poolCountForGroup(groupId)).toBe(0);
  });

  test('a group in grace is refused before any upstream is consulted', async () => {
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

    upstream.tvdb.movie = [{ id: 9009, name: 'Never Reached' }];

    const result = await invokeGeneratePool(owner, { groupId }, 'tvdb');

    expect(result).toEqual({ status: 'group_in_grace', poolId: null });
    expect(await poolCountForGroup(groupId)).toBe(0);
    expect(requestedPaths).toEqual([]);
  });
});
