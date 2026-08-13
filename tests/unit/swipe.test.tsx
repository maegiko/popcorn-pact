import { recordSwipe } from '@/lib/swipe';

type RpcResponse = {
  data: unknown;
  error: unknown;
};

const mockRpc = jest.fn<Promise<RpcResponse>, [string, Record<string, unknown>]>();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: [string, Record<string, unknown>]) => mockRpc(...args),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('recordSwipe match surfacing', () => {
  test('preserves recorded status and exposes match creation from the RPC row', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'recorded', match_created: true }],
      error: null,
    });

    await expect(recordSwipe('pool-1', 'media-1', 'like')).resolves.toEqual({
      status: 'recorded',
      matchCreated: true,
    });
    expect(mockRpc).toHaveBeenCalledWith('record_swipe', {
      p_pool_id: 'pool-1',
      p_media_id: 'media-1',
      p_decision: 'like',
    });
  });

  test('successful non-match likes are distinguishable from match-creating likes', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'recorded', match_created: false }],
      error: null,
    });

    await expect(recordSwipe('pool-1', 'media-2', 'like')).resolves.toEqual({
      status: 'recorded',
      matchCreated: false,
    });
  });

  test('duplicate likes never surface a new match moment', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'already_recorded', match_created: false }],
      error: null,
    });

    await expect(recordSwipe('pool-1', 'media-1', 'like')).resolves.toEqual({
      status: 'already_recorded',
      matchCreated: false,
    });
  });
});

describe('recordSwipe status preservation', () => {
  test('pool_completed is preserved rather than collapsing to error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'pool_completed', match_created: false }],
      error: null,
    });

    await expect(recordSwipe('pool-1', 'media-1', 'like')).resolves.toEqual({
      status: 'pool_completed',
      matchCreated: false,
    });
  });

  test('group_too_small is preserved rather than collapsing to error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ status: 'group_too_small', match_created: false }],
      error: null,
    });

    await expect(recordSwipe('pool-1', 'media-1', 'like')).resolves.toEqual({
      status: 'group_too_small',
      matchCreated: false,
    });
  });
});
