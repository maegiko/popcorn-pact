import { FunctionsHttpError } from '@supabase/supabase-js';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { useGeneratePool, type GeneratePoolState } from '@/lib/pool';
import { supabase } from '@/lib/supabase';

type ObservedPool = ReturnType<typeof useGeneratePool>;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: jest.fn() },
  },
}));

const mockInvoke = (supabase as unknown as { functions: { invoke: jest.Mock } }).functions.invoke;

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

beforeEach(() => {
  jest.clearAllMocks();
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
