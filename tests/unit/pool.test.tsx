import { FunctionsHttpError } from '@supabase/supabase-js';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { loadLatestActivePool, useGeneratePool, useLatestActivePool, type GeneratePoolState } from '@/lib/pool';
import { supabase } from '@/lib/supabase';

type ObservedPool = ReturnType<typeof useGeneratePool>;
type ObservedActivePool = ReturnType<typeof useLatestActivePool>;

type PoolsQueryResponse = { data: { id: string } | null; error: { message: string } | null };
type PoolsQuery = {
  select: jest.Mock<PoolsQuery, unknown[]>;
  eq: jest.Mock<PoolsQuery, unknown[]>;
  order: jest.Mock<PoolsQuery, unknown[]>;
  limit: jest.Mock<PoolsQuery, unknown[]>;
  maybeSingle: jest.Mock<Promise<PoolsQueryResponse>, []>;
};

let mockPoolsResponses: (PoolsQueryResponse | Promise<PoolsQueryResponse>)[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: jest.fn() },
    from: jest.fn(() => mockCreatePoolsQuery()),
  },
}));

function mockCreatePoolsQuery(): PoolsQuery {
  const query = {} as PoolsQuery;

  Object.assign(query, {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    order: jest.fn(() => query),
    limit: jest.fn(() => query),
    maybeSingle: jest.fn(async () => {
      const next = mockPoolsResponses.shift();
      if (!next) throw new Error('No mocked pools response queued.');
      return next;
    }),
  });

  return query;
}

const mockInvoke = (supabase as unknown as { functions: { invoke: jest.Mock } }).functions.invoke;
const mockFrom = (supabase as unknown as { from: jest.Mock }).from;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Probe({
  groupId,
  onChange,
}: {
  groupId: string | null;
  onChange: (value: ObservedPool) => void;
}) {
  const value = useGeneratePool(groupId);

  useEffect(() => {
    onChange(value);
  }, [value, onChange]);

  return null;
}

async function renderPool(groupId: string | null) {
  const observed: ObservedPool[] = [];
  const onChange = (value: ObservedPool) => observed.push(value);
  const result = await render(<Probe groupId={groupId} onChange={onChange} />);

  return {
    ...result,
    observed,
    onChange,
    current: () => {
      const item = observed.at(-1);
      if (!item) throw new Error('Expected at least one observed pool value.');
      return item;
    },
  };
}

function ActivePoolProbe({
  groupId,
  onChange,
}: {
  groupId: string | null;
  onChange: (value: ObservedActivePool) => void;
}) {
  const value = useLatestActivePool(groupId);

  useEffect(() => {
    onChange(value);
  }, [value, onChange]);

  return null;
}

async function renderActivePool(groupId: string | null) {
  const observed: ObservedActivePool[] = [];
  const onChange = (value: ObservedActivePool) => observed.push(value);
  const result = await render(<ActivePoolProbe groupId={groupId} onChange={onChange} />);

  return {
    ...result,
    observed,
    onChange,
    current: () => {
      const item = observed.at(-1);
      if (!item) throw new Error('Expected at least one observed active-pool value.');
      return item;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolsResponses = [];
});

afterEach(() => {
  cleanup();
});

async function expectState(current: () => ObservedPool, state: GeneratePoolState) {
  await waitFor(() => expect(current().state).toBe(state));
}

describe('useGeneratePool', () => {
  test('a created response carries the new pool id', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { status: 'created', poolId: 'pool-1' },
      error: null,
    });
    const { current } = await renderPool('group-1');

    await act(async () => {
      await current().generate();
    });

    await expectState(current, 'created');
    expect(current().poolId).toBe('pool-1');
    expect(mockInvoke).toHaveBeenCalledWith('generate-pool', {
      body: { groupId: 'group-1', effectiveProviderIds: null },
    });
  });

  test('a second tap while a request is in flight does not send a duplicate request', async () => {
    const first = deferred<{ data: unknown; error: null }>();
    mockInvoke.mockReturnValueOnce(first.promise);
    const { current } = await renderPool('group-1');

    let firstCall: Promise<void>;
    let secondCall: Promise<void>;
    await act(async () => {
      firstCall = current().generate();
      secondCall = current().generate();
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ data: { status: 'created', poolId: 'pool-1' }, error: null });
      await firstCall;
      await secondCall;
    });

    await expectState(current, 'created');
  });

  test('a response for a group the caller has since left is discarded', async () => {
    const pending = deferred<{ data: unknown; error: null }>();
    mockInvoke.mockReturnValueOnce(pending.promise);
    const { current, rerender, onChange } = await renderPool('group-1');

    let inFlight: Promise<void>;
    await act(async () => {
      inFlight = current().generate();
      await Promise.resolve();
    });
    await expectState(current, 'generating');

    await act(async () => {
      await rerender(<Probe groupId="group-2" onChange={onChange} />);
    });

    // Switching groups resets immediately, without waiting on the network.
    expect(current().state).toBe('idle');

    await act(async () => {
      pending.resolve({ data: { status: 'created', poolId: 'pool-1' }, error: null });
      await inFlight;
    });

    // The late result for the old group must not resurrect a stale success.
    expect(current().state).toBe('idle');
    expect(current().poolId).toBeNull();
  });

  test('upstream_unavailable is read from the 503 error body', async () => {
    const response = { json: async () => ({ status: 'upstream_unavailable', poolId: null }) };
    mockInvoke.mockResolvedValueOnce({
      data: null,
      error: new FunctionsHttpError(response),
    });
    const { current } = await renderPool('group-1');

    await act(async () => {
      await current().generate();
    });

    await expectState(current, 'upstream_unavailable');
    expect(current().poolId).toBeNull();
  });

  // The server can decline to narrow by streaming service -- not every media
  // provider has availability data. The client has to be able to say so without
  // learning anything about which upstream is configured.
  test('filter_unsupported is surfaced as its own outcome rather than an error', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { status: 'filter_unsupported', poolId: null },
      error: null,
    });
    const { current } = await renderPool('group-1');

    await act(async () => {
      await current().generate();
    });

    await expectState(current, 'filter_unsupported');
    expect(current().poolId).toBeNull();
  });

  test('an unrecognised response collapses to error rather than crashing', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { status: 'something_new' }, error: null });
    const { current } = await renderPool('group-1');

    await act(async () => {
      await current().generate();
    });

    await expectState(current, 'error');
  });

  test('reset returns to idle and clears the pool id', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { status: 'created', poolId: 'pool-1' },
      error: null,
    });
    const { current } = await renderPool('group-1');

    await act(async () => {
      await current().generate();
    });
    await expectState(current, 'created');

    await act(async () => {
      current().reset();
    });

    expect(current().state).toBe('idle');
    expect(current().poolId).toBeNull();
  });
});

describe('loadLatestActivePool', () => {
  test('surfaces the id the boundary returns for an active pool', async () => {
    mockPoolsResponses = [{ data: { id: 'pool-9' }, error: null }];

    await expect(loadLatestActivePool('group-1')).resolves.toBe('pool-9');
    expect(mockFrom).toHaveBeenCalledWith('pools');
  });

  // The where group_id/status = 'active' order by created_at desc limit 1
  // query returns no row once every pool for the group is completed. That is
  // mocked directly at the boundary here rather than re-derived client-side --
  // this function does no filtering of its own.
  test('a completed-only pool history reads as no active pool', async () => {
    mockPoolsResponses = [{ data: null, error: null }];

    await expect(loadLatestActivePool('group-1')).resolves.toBeNull();
  });

  // The boundary's own ORDER BY created_at DESC LIMIT 1 already excludes a
  // newer completed pool before a row ever reaches this function -- there is
  // nothing left to re-filter, so the older active pool is trusted as-is.
  test('an older active pool is surfaced when a newer completed pool is excluded by the boundary', async () => {
    mockPoolsResponses = [{ data: { id: 'pool-older-active' }, error: null }];

    await expect(loadLatestActivePool('group-1')).resolves.toBe('pool-older-active');
  });

  test('a lookup failure throws rather than silently reporting no pool', async () => {
    mockPoolsResponses = [{ data: null, error: { message: 'Network unavailable' } }];

    await expect(loadLatestActivePool('group-1')).rejects.toBeTruthy();
  });
});

describe('useLatestActivePool', () => {
  test('reports the newest active pool the boundary returns', async () => {
    mockPoolsResponses = [{ data: { id: 'pool-1' }, error: null }];
    const { current } = await renderActivePool('group-1');

    await waitFor(() => expect(current().status).toBe('found'));
    expect(current().poolId).toBe('pool-1');
  });

  test('reports none when the boundary finds no active pool', async () => {
    mockPoolsResponses = [{ data: null, error: null }];
    const { current } = await renderActivePool('group-1');

    await waitFor(() => expect(current().status).toBe('none'));
    expect(current().poolId).toBeNull();
  });

  test('a lookup failure is reported as an error status rather than thrown', async () => {
    mockPoolsResponses = [{ data: null, error: { message: 'Network unavailable' } }];
    const { current } = await renderActivePool('group-1');

    await waitFor(() => expect(current().status).toBe('error'));
    expect(current().poolId).toBeNull();
  });

  test('a response for a group the caller has since switched away from is discarded', async () => {
    const pendingGroup1 = deferred<PoolsQueryResponse>();
    mockPoolsResponses = [pendingGroup1.promise as unknown as PoolsQueryResponse];
    const { current, rerender, onChange } = await renderActivePool('group-1');

    expect(current().status).toBe('loading');

    // Queue group-2's response before switching -- its effect fires
    // synchronously inside the rerender below.
    mockPoolsResponses.push({ data: { id: 'pool-2' }, error: null });

    await act(async () => {
      await rerender(<ActivePoolProbe groupId="group-2" onChange={onChange} />);
    });

    await waitFor(() => expect(current().status).toBe('found'));
    expect(current().poolId).toBe('pool-2');

    // The still-pending group-1 lookup resolving afterwards must not
    // overwrite group-2's already-adopted result.
    await act(async () => {
      pendingGroup1.resolve({ data: { id: 'pool-1' }, error: null });
    });

    expect(current().status).toBe('found');
    expect(current().poolId).toBe('pool-2');
  });
});
