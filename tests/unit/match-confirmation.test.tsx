type ConfirmMatchStatus =
  | 'confirmed'
  | 'already_confirmed'
  | 'pool_completed'
  | 'not_a_member'
  | 'match_not_found'
  | 'group_in_grace'
  | 'error';

type ConfirmMatchResult = {
  status: ConfirmMatchStatus;
  finalized: boolean;
  mediaId: string | null;
};

type RpcResponse = {
  data: unknown;
  error: unknown;
};

type ConfirmationQueryResponse = {
  data: unknown;
  error: unknown;
};

type ConfirmationQuery = {
  select: jest.Mock<ConfirmationQuery, [string]>;
  eq: jest.Mock<Promise<ConfirmationQueryResponse>, [string, string]>;
};

const mockRpc = jest.fn<Promise<RpcResponse>, [string, Record<string, unknown>]>();
let mockConfirmationResponses: ConfirmationQueryResponse[] = [];
let lastConfirmationQuery: ConfirmationQuery | null = null;

const mockFrom = jest.fn((table: string) => {
  const query = {} as ConfirmationQuery;

  Object.assign(query, {
    select: jest.fn(() => query),
    eq: jest.fn(async () => {
      const next = mockConfirmationResponses.shift();
      if (!next) throw new Error(`No mocked ${table} response queued.`);
      return next;
    }),
  });

  lastConfirmationQuery = query;
  return query;
});

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, params: Record<string, unknown>) => mockRpc(fn, params),
    from: (table: string) => mockFrom(table),
  },
}));

async function confirmMatch(poolId: string, mediaId: string): Promise<ConfirmMatchResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('@/lib/match') as {
    confirmMatch?: (poolId: string, mediaId: string) => Promise<ConfirmMatchResult>;
  };

  if (typeof module.confirmMatch === 'function') return module.confirmMatch(poolId, mediaId);

  return { status: 'error', finalized: false, mediaId: '__missing_confirm_match_export__' };
}

async function loadMyMatchConfirmations(poolId: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('@/lib/match') as {
    loadMyMatchConfirmations?: (poolId: string) => Promise<string[]>;
  };

  if (typeof module.loadMyMatchConfirmations === 'function') {
    return module.loadMyMatchConfirmations(poolId);
  }

  return ['__missing_load_my_match_confirmations_export__'];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmationResponses = [];
  lastConfirmationQuery = null;
});

describe('confirmMatch', () => {
  test('calls the trusted confirm_match RPC with exact pool/media params', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'confirmed', finalized: false, media_id: null }],
      error: null,
    });

    await expect(confirmMatch('pool-1', 'media-1')).resolves.toEqual({
      status: 'confirmed',
      finalized: false,
      mediaId: null,
    });

    expect(mockRpc).toHaveBeenCalledWith('confirm_match', {
      p_pool_id: 'pool-1',
      p_media_id: 'media-1',
    });
  });

  test('maps an idempotent duplicate confirmation response', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'already_confirmed', finalized: false, media_id: null }],
      error: null,
    });

    await expect(confirmMatch('pool-1', 'media-1')).resolves.toEqual({
      status: 'already_confirmed',
      finalized: false,
      mediaId: null,
    });
  });

  test('maps finalized confirmation results with the winning media id', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'confirmed', finalized: true, media_id: 'media-winner' }],
      error: null,
    });

    await expect(confirmMatch('pool-1', 'media-winner')).resolves.toEqual({
      status: 'confirmed',
      finalized: true,
      mediaId: 'media-winner',
    });
  });

  test.each([
    'pool_completed',
    'not_a_member',
    'match_not_found',
    'group_in_grace',
  ] as const)('maps %s without pretending the pool finalized', async (status) => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status, finalized: false, media_id: null }],
      error: null,
    });

    await expect(confirmMatch('pool-1', 'media-1')).resolves.toEqual({
      status,
      finalized: false,
      mediaId: null,
    });
  });

  test('surfaces Supabase RPC errors to the caller', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });

    await expect(confirmMatch('pool-1', 'media-1')).rejects.toBeTruthy();
  });
});

describe('loadMyMatchConfirmations', () => {
  test('reads only the current user confirmation state for one pool', async () => {
    mockConfirmationResponses = [
      {
        data: [{ media_id: 'media-1' }, { media_id: 'media-2' }],
        error: null,
      },
    ];

    await expect(loadMyMatchConfirmations('pool-1')).resolves.toEqual(['media-1', 'media-2']);

    expect(mockFrom).toHaveBeenCalledWith('match_confirmations');
    expect(lastConfirmationQuery?.select).toHaveBeenCalledWith('media_id');
    expect(lastConfirmationQuery?.eq).toHaveBeenCalledWith('pool_id', 'pool-1');
  });

  test('empty confirmation state maps to an empty list', async () => {
    mockConfirmationResponses = [{ data: [], error: null }];

    await expect(loadMyMatchConfirmations('pool-empty')).resolves.toEqual([]);
  });

  test('confirmation read errors are surfaced to the screen boundary', async () => {
    mockConfirmationResponses = [{ data: null, error: { message: 'permission denied' } }];

    await expect(loadMyMatchConfirmations('pool-1')).rejects.toBeTruthy();
  });
});
