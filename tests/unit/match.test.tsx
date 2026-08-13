type MatchMedia = {
  id: string;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl: string | null;
};

type PoolMatch = {
  poolId: string;
  media: MatchMedia;
};

type MatchesResponse = {
  data: unknown;
  error: unknown;
};

type MatchesQuery = {
  select: jest.Mock<MatchesQuery, [string]>;
  eq: jest.Mock<MatchesQuery, [string, string]>;
  order: jest.Mock<Promise<MatchesResponse>, [string, { ascending: boolean }]>;
};

let mockMatchesResponses: MatchesResponse[] = [];
let lastMatchesQuery: MatchesQuery | null = null;
const mockFrom = jest.fn((table: string) => {
  const query = {} as MatchesQuery;

  Object.assign(query, {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    order: jest.fn(async () => {
      const next = mockMatchesResponses.shift();
      if (!next) throw new Error(`No mocked ${table} response queued.`);
      return next;
    }),
  });

  lastMatchesQuery = query;
  return query;
});

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
  },
}));

function loadPoolMatches(poolId: string): Promise<PoolMatch[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('@/lib/match') as { loadPoolMatches?: (poolId: string) => Promise<PoolMatch[]> };
    if (typeof module.loadPoolMatches === 'function') {
      return module.loadPoolMatches(poolId);
    }
  } catch {
    // Fall through to a failing result so the suite reports a test failure
    // rather than aborting while the client boundary does not exist yet.
  }

  return Promise.resolve([
    {
      poolId: '__missing_match_boundary__',
      media: { id: '', mediaType: 'movie', title: '', posterUrl: null },
    },
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMatchesResponses = [];
  lastMatchesQuery = null;
});

describe('loadPoolMatches', () => {
  test('reads matches for exactly one pool through RLS-backed Supabase tables', async () => {
    mockMatchesResponses = [
      {
        data: [
          {
            pool_id: 'pool-1',
            media: {
              id: 'media-1',
              media_type: 'movie',
              title: 'Arrival',
              poster_url: 'https://cdn.example.test/arrival.jpg',
            },
          },
        ],
        error: null,
      },
    ];

    const matches = await loadPoolMatches('pool-1');

    expect(mockFrom).toHaveBeenCalledWith('matches');
    expect(lastMatchesQuery?.select).toHaveBeenCalledWith(
      'pool_id, media(id, media_type, title, poster_url)'
    );
    expect(lastMatchesQuery?.eq).toHaveBeenCalledWith('pool_id', 'pool-1');
    expect(lastMatchesQuery?.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(matches).toEqual([
      {
        poolId: 'pool-1',
        media: {
          id: 'media-1',
          mediaType: 'movie',
          title: 'Arrival',
          posterUrl: 'https://cdn.example.test/arrival.jpg',
        },
      },
    ]);
  });

  test('empty match history maps to an empty list', async () => {
    mockMatchesResponses = [{ data: [], error: null }];

    await expect(loadPoolMatches('pool-empty')).resolves.toEqual([]);
  });

  test('Supabase errors are surfaced to the screen boundary', async () => {
    mockMatchesResponses = [{ data: null, error: { message: 'permission denied' } }];

    await expect(loadPoolMatches('pool-1')).rejects.toBeTruthy();
  });
});
