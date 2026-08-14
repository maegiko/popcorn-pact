type PoolStatus = 'active' | 'completed';

type DashboardPool = {
  id: string;
  status: PoolStatus;
  plannedFor: string | null;
  createdAt: string;
  winner: {
    id: string;
    mediaType: 'movie' | 'tv';
    title: string;
    posterUrl: string | null;
    overview: string | null;
    releaseYear: number | null;
  } | null;
};

type DashboardGroup = {
  id: string;
  name: string;
  pools: DashboardPool[];
};

type QueryResponse = { data: unknown; error: unknown };

type Query = {
  select: jest.Mock<Query, [string]>;
  eq: jest.Mock<Query, [string, string | number]>;
  lte: jest.Mock<Query, [string, number]>;
  or: jest.Mock<Query, [string]>;
  order: jest.Mock<Promise<QueryResponse> | Query, [string, { ascending: boolean }]>;
};

let queryResponses: QueryResponse[] = [];
let lastQuery: Query | null = null;

const mockFrom = jest.fn((table: string) => {
  const query = {} as Query;

  Object.assign(query, {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    lte: jest.fn(() => query),
    or: jest.fn(() => query),
    order: jest.fn((column: string) => {
      if (column === 'pool_created_at') {
        const next = queryResponses.shift();
        if (!next) throw new Error(`No mocked ${table} response queued.`);
        return Promise.resolve(next);
      }
      return query;
    }),
  });

  lastQuery = query;
  return query;
});

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
  },
}));

async function loadHomeGroups(): Promise<DashboardGroup[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('@/lib/pool') as {
    loadHomeGroups?: () => Promise<DashboardGroup[]>;
  };
  if (typeof module.loadHomeGroups === 'function') return module.loadHomeGroups();
  return [{ id: '__missing_load_home_groups__', name: '', pools: [] }];
}

async function loadGroupPoolHistory(groupId: string): Promise<DashboardPool[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('@/lib/pool') as {
    loadGroupPoolHistory?: (groupId: string) => Promise<DashboardPool[]>;
  };
  if (typeof module.loadGroupPoolHistory === 'function') return module.loadGroupPoolHistory(groupId);
  return [
    {
      id: '__missing_load_group_pool_history__',
      status: 'active',
      plannedFor: null,
      createdAt: '',
      winner: null,
    },
  ];
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    group_id: 'group-1',
    group_name: 'Friday Night',
    pool_id: 'pool-1',
    pool_status: 'active',
    pool_planned_for: null,
    pool_created_at: '2026-08-14T10:00:00.000Z',
    winner_media_id: null,
    winner_media_type: null,
    winner_title: null,
    winner_poster_url: null,
    winner_overview: null,
    winner_release_year: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryResponses = [];
  lastQuery = null;
});

describe('loadHomeGroups', () => {
  test('loads zero groups as an empty dashboard', async () => {
    queryResponses = [{ data: [], error: null }];

    await expect(loadHomeGroups()).resolves.toEqual([]);
  });

  test('groups rows into one group with active and completed pools newest first', async () => {
    queryResponses = [
      {
        data: [
          row({
            pool_id: 'pool-new-completed',
            pool_status: 'completed',
            pool_created_at: '2026-08-14T12:00:00.000Z',
            winner_media_id: 'media-1',
            winner_media_type: 'movie',
            winner_title: 'Arrival',
            winner_poster_url: 'https://cdn.example.test/arrival.jpg',
            winner_overview: 'A linguist meets visitors from elsewhere.',
            winner_release_year: 2016,
          }),
          row({
            pool_id: 'pool-old-active',
            pool_status: 'active',
            pool_created_at: '2026-08-14T11:00:00.000Z',
            pool_planned_for: '2026-08-15T20:30:00.000Z',
          }),
        ],
        error: null,
      },
    ];

    await expect(loadHomeGroups()).resolves.toEqual([
      {
        id: 'group-1',
        name: 'Friday Night',
        pools: [
          {
            id: 'pool-new-completed',
            status: 'completed',
            plannedFor: null,
            createdAt: '2026-08-14T12:00:00.000Z',
            winner: {
              id: 'media-1',
              mediaType: 'movie',
              title: 'Arrival',
              posterUrl: 'https://cdn.example.test/arrival.jpg',
              overview: 'A linguist meets visitors from elsewhere.',
              releaseYear: 2016,
            },
          },
          {
            id: 'pool-old-active',
            status: 'active',
            plannedFor: '2026-08-15T20:30:00.000Z',
            createdAt: '2026-08-14T11:00:00.000Z',
            winner: null,
          },
        ],
      },
    ]);
  });

  test('keeps multiple groups isolated and caps the Home preview at three pools per group', async () => {
    queryResponses = [
      {
        data: [
          row({ group_id: 'group-a', group_name: 'A', pool_id: 'a-1', home_rank: 1 }),
          row({ group_id: 'group-a', group_name: 'A', pool_id: 'a-2', home_rank: 2 }),
          row({ group_id: 'group-a', group_name: 'A', pool_id: 'a-3', home_rank: 3 }),
          row({ group_id: 'group-b', group_name: 'B', pool_id: 'b-1', home_rank: 1 }),
        ],
        error: null,
      },
    ];

    const groups = await loadHomeGroups();

    expect(groups.map((group) => group.id)).toEqual(['group-a', 'group-b']);
    expect(groups[0].pools.map((pool) => pool.id)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(groups[1].pools.map((pool) => pool.id)).toEqual(['b-1']);
    expect(JSON.stringify(groups[0])).not.toContain('b-1');
    // Not a plain .lte: PostgREST's lte (like SQL's own <=) excludes NULL,
    // and a zero-pool group's placeholder row has a NULL home_rank by
    // design. The OR is what keeps that group from silently vanishing.
    expect(lastQuery?.or).toHaveBeenCalledWith('home_rank.lte.3,home_rank.is.null');
  });

  test('a pool-less row folds its group in with an empty pool list, not a null-shaped pool', async () => {
    queryResponses = [
      {
        data: [
          row({
            group_id: 'group-solo',
            group_name: 'Waiting for them',
            home_rank: null,
            pool_id: null,
            pool_status: null,
            pool_created_at: null,
          }),
        ],
        error: null,
      },
    ];

    await expect(loadHomeGroups()).resolves.toEqual([
      { id: 'group-solo', name: 'Waiting for them', pools: [] },
    ]);
  });

  test('uses a stable direct-read dashboard view with provider-independent winner fields', async () => {
    queryResponses = [{ data: [], error: null }];

    await loadHomeGroups();

    expect(mockFrom).toHaveBeenCalledWith('home_group_pool_dashboard');
    expect(lastQuery?.select).toHaveBeenCalledWith(
      'group_id, group_name, group_joined_at, home_rank, pool_id, pool_status, pool_planned_for, pool_created_at, winner_media_id, winner_media_type, winner_title, winner_poster_url, winner_overview, winner_release_year'
    );
    expect(lastQuery?.order).toHaveBeenCalledWith('group_joined_at', { ascending: true });
    expect(lastQuery?.order).toHaveBeenCalledWith('pool_created_at', { ascending: false });
  });

  test('read failures are surfaced instead of pretending there are no groups', async () => {
    queryResponses = [{ data: null, error: { message: 'permission denied' } }];

    await expect(loadHomeGroups()).rejects.toBeTruthy();
  });
});

describe('loadGroupPoolHistory', () => {
  test('loads all pools for one group, newest first, without the Home cap', async () => {
    queryResponses = [
      {
        data: [
          row({ pool_id: 'pool-4', pool_created_at: '2026-08-14T14:00:00.000Z' }),
          row({ pool_id: 'pool-3', pool_created_at: '2026-08-14T13:00:00.000Z' }),
          row({ pool_id: 'pool-2', pool_created_at: '2026-08-14T12:00:00.000Z' }),
          row({ pool_id: 'pool-1', pool_created_at: '2026-08-14T11:00:00.000Z' }),
        ],
        error: null,
      },
    ];

    await expect(loadGroupPoolHistory('group-1')).resolves.toHaveLength(4);
    expect(lastQuery?.eq).toHaveBeenCalledWith('group_id', 'group-1');
    expect(lastQuery?.lte).not.toHaveBeenCalled();
  });

  test('history maps completed winner overview and leaves active winners null', async () => {
    queryResponses = [
      {
        data: [
          row({
            pool_id: 'completed',
            pool_status: 'completed',
            winner_media_id: 'media-2',
            winner_media_type: 'tv',
            winner_title: 'Station Eleven',
            winner_poster_url: null,
            winner_overview: null,
            winner_release_year: 2024,
          }),
          row({ pool_id: 'active', pool_status: 'active' }),
        ],
        error: null,
      },
    ];

    await expect(loadGroupPoolHistory('group-1')).resolves.toEqual([
      {
        id: 'completed',
        status: 'completed',
        plannedFor: null,
        createdAt: '2026-08-14T10:00:00.000Z',
        winner: {
          id: 'media-2',
          mediaType: 'tv',
          title: 'Station Eleven',
          posterUrl: null,
          overview: null,
          releaseYear: 2024,
        },
      },
      {
        id: 'active',
        status: 'active',
        plannedFor: null,
        createdAt: '2026-08-14T10:00:00.000Z',
        winner: null,
      },
    ]);
  });

  test('empty or RLS-hidden history maps to an empty list', async () => {
    queryResponses = [{ data: [], error: null }];

    await expect(loadGroupPoolHistory('unknown-or-hidden-group')).resolves.toEqual([]);
  });

  test('a pool-less group placeholder row maps to an empty list, not a null-shaped pool', async () => {
    queryResponses = [
      {
        data: [
          row({ home_rank: null, pool_id: null, pool_status: null, pool_created_at: null }),
        ],
        error: null,
      },
    ];

    await expect(loadGroupPoolHistory('group-1')).resolves.toEqual([]);
  });

  test('history read failures are surfaced to the screen boundary', async () => {
    queryResponses = [{ data: null, error: { message: 'network' } }];

    await expect(loadGroupPoolHistory('group-1')).rejects.toBeTruthy();
  });
});
