type MatchMedia = {
  id: string;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl: string | null;
};

type PoolLifecycle = {
  poolId: string;
  status: 'active' | 'completed';
  createdBy: string | null;
  plannedFor: string | null;
  winnerMediaId: string | null;
  finalizedAt: string | null;
  winner: MatchMedia | null;
};

type PlannedStatus = 'updated' | 'not_creator' | 'not_a_member' | 'pool_not_found' | 'error';
type FinalizeStatus =
  | 'finalized'
  | 'already_completed'
  | 'no_matches'
  | 'not_creator'
  | 'not_a_member'
  | 'media_not_matched'
  | 'group_in_grace'
  | 'error';

type QueryResponse = { data: unknown; error: unknown };
type RpcResponse = { data: unknown; error: unknown };

type Query = {
  select: jest.Mock<Query, [string]>;
  eq: jest.Mock<Query, [string, string]>;
  maybeSingle: jest.Mock<Promise<QueryResponse>, []>;
};

let queryResponses: QueryResponse[] = [];
const queries: Array<{ table: string; query: Query }> = [];
const mockRpc = jest.fn<Promise<RpcResponse>, [string, Record<string, unknown>]>();
const mockFrom = jest.fn((table: string) => {
  const query = {} as Query;

  Object.assign(query, {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    maybeSingle: jest.fn(async () => {
      const next = queryResponses.shift();
      if (!next) throw new Error(`No mocked ${table} response queued.`);
      return next;
    }),
  });

  queries.push({ table, query });
  return query;
});

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: (...args: [string, Record<string, unknown>]) => mockRpc(...args),
  },
}));

function poolModule(): {
  loadPoolLifecycle?: (poolId: string) => Promise<PoolLifecycle | null>;
  setPoolPlannedFor?: (poolId: string, plannedFor: string | null) => Promise<{ status: PlannedStatus }>;
  finalizePool?: (poolId: string, mediaId: string) => Promise<{ status: FinalizeStatus; mediaId: string | null }>;
  finalizePoolRandom?: (poolId: string) => Promise<{ status: FinalizeStatus; mediaId: string | null }>;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/pool');
}

function loadPoolLifecycle(poolId: string): Promise<PoolLifecycle | null> {
  const fn = poolModule().loadPoolLifecycle;
  return typeof fn === 'function' ? fn(poolId) : Promise.resolve(null);
}

function setPoolPlannedFor(poolId: string, plannedFor: string | null): Promise<{ status: PlannedStatus }> {
  const fn = poolModule().setPoolPlannedFor;
  return typeof fn === 'function' ? fn(poolId, plannedFor) : Promise.resolve({ status: '__missing_function__' as PlannedStatus });
}

function finalizePool(poolId: string, mediaId: string): Promise<{ status: FinalizeStatus; mediaId: string | null }> {
  const fn = poolModule().finalizePool;
  return typeof fn === 'function' ? fn(poolId, mediaId) : Promise.resolve({ status: '__missing_function__' as FinalizeStatus, mediaId: null });
}

function finalizePoolRandom(poolId: string): Promise<{ status: FinalizeStatus; mediaId: string | null }> {
  const fn = poolModule().finalizePoolRandom;
  return typeof fn === 'function' ? fn(poolId) : Promise.resolve({ status: '__missing_function__' as FinalizeStatus, mediaId: null });
}

beforeEach(() => {
  jest.clearAllMocks();
  queryResponses = [];
  queries.length = 0;
});

describe('loadPoolLifecycle', () => {
  test('loads active pool state with planned time and ownership fields', async () => {
    queryResponses = [
      {
        data: {
          id: 'pool-1',
          status: 'active',
          created_by: 'user-1',
          planned_for: '2026-08-15T20:00:00.000Z',
          winner_media_id: null,
          finalized_at: null,
        },
        error: null,
      },
    ];

    await expect(loadPoolLifecycle('pool-1')).resolves.toEqual({
      poolId: 'pool-1',
      status: 'active',
      createdBy: 'user-1',
      plannedFor: '2026-08-15T20:00:00.000Z',
      winnerMediaId: null,
      finalizedAt: null,
      winner: null,
    });

    expect(mockFrom).toHaveBeenCalledWith('pools');
    expect(queries[0]?.query.select).toHaveBeenCalledWith(
      'id, status, created_by, planned_for, winner_media_id, finalized_at'
    );
    expect(queries[0]?.query.eq).toHaveBeenCalledWith('id', 'pool-1');
  });

  test('loads winner media when a pool is completed', async () => {
    queryResponses = [
      {
        data: {
          id: 'pool-1',
          status: 'completed',
          created_by: 'user-1',
          planned_for: '2026-08-15T20:00:00.000Z',
          winner_media_id: 'media-2',
          finalized_at: '2026-08-13T21:00:00.000Z',
        },
        error: null,
      },
      {
        data: {
          id: 'media-2',
          media_type: 'movie',
          title: 'Moonlight',
          poster_url: 'https://cdn.example.test/moonlight.jpg',
        },
        error: null,
      },
    ];

    await expect(loadPoolLifecycle('pool-1')).resolves.toMatchObject({
      status: 'completed',
      winnerMediaId: 'media-2',
      finalizedAt: '2026-08-13T21:00:00.000Z',
      winner: {
        id: 'media-2',
        mediaType: 'movie',
        title: 'Moonlight',
        posterUrl: 'https://cdn.example.test/moonlight.jpg',
      },
    });

    expect(mockFrom).toHaveBeenNthCalledWith(2, 'media');
    expect(queries[1]?.query.select).toHaveBeenCalledWith('id, media_type, title, poster_url');
    expect(queries[1]?.query.eq).toHaveBeenCalledWith('id', 'media-2');
  });

  test('empty RLS-scoped result maps to null', async () => {
    queryResponses = [{ data: null, error: null }];

    await expect(loadPoolLifecycle('pool-hidden')).resolves.toBeNull();
  });

  test('Supabase read errors are surfaced to the screen boundary', async () => {
    queryResponses = [{ data: null, error: { message: 'permission denied' } }];

    await expect(loadPoolLifecycle('pool-1')).rejects.toBeTruthy();
  });
});

describe('pool planned time actions', () => {
  test('setPoolPlannedFor sends exact pool id and timestamp to the RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ status: 'updated' }], error: null });

    await expect(setPoolPlannedFor('pool-1', '2026-08-15T20:00:00.000Z')).resolves.toEqual({
      status: 'updated',
    });
    expect(mockRpc).toHaveBeenCalledWith('set_pool_planned_for', {
      p_pool_id: 'pool-1',
      p_planned_for: '2026-08-15T20:00:00.000Z',
    });
  });

  test('setPoolPlannedFor can clear planned time with null', async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ status: 'updated' }], error: null });

    await expect(setPoolPlannedFor('pool-1', null)).resolves.toEqual({ status: 'updated' });
    expect(mockRpc).toHaveBeenCalledWith('set_pool_planned_for', {
      p_pool_id: 'pool-1',
      p_planned_for: null,
    });
  });

  test.each(['not_creator', 'not_a_member', 'pool_not_found'] as const)(
    'setPoolPlannedFor preserves %s',
    async (status) => {
      mockRpc.mockResolvedValueOnce({ data: [{ status }], error: null });

      await expect(setPoolPlannedFor('pool-1', '2026-08-15T20:00:00.000Z')).resolves.toEqual({
        status,
      });
    }
  );
});

describe('pool finalization actions', () => {
  test('manual finalization sends exact pool id and matched media id', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'finalized', media_id: 'media-1' }],
      error: null,
    });

    await expect(finalizePool('pool-1', 'media-1')).resolves.toEqual({
      status: 'finalized',
      mediaId: 'media-1',
    });
    expect(mockRpc).toHaveBeenCalledWith('finalize_pool', {
      p_pool_id: 'pool-1',
      p_media_id: 'media-1',
    });
  });

  test('random finalization delegates selection to the server', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'finalized', media_id: 'media-backend-picked' }],
      error: null,
    });

    await expect(finalizePoolRandom('pool-1')).resolves.toEqual({
      status: 'finalized',
      mediaId: 'media-backend-picked',
    });
    expect(mockRpc).toHaveBeenCalledWith('finalize_pool_random', { p_pool_id: 'pool-1' });
  });

  test.each([
    'already_completed',
    'no_matches',
    'not_creator',
    'not_a_member',
    'media_not_matched',
    'group_in_grace',
  ] as const)('manual finalization preserves %s', async (status) => {
    mockRpc.mockResolvedValueOnce({ data: [{ status, media_id: null }], error: null });

    await expect(finalizePool('pool-1', 'media-1')).resolves.toEqual({ status, mediaId: null });
  });

  test('transport errors reject rather than falsely finalizing', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });

    await expect(finalizePoolRandom('pool-1')).rejects.toBeTruthy();
  });
});
