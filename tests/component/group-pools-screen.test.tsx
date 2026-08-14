import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Text } from 'react-native';

type HistoryPool = {
  id: string;
  status: 'active' | 'completed';
  plannedFor: string | null;
  createdAt: string;
  winner: {
    id: string;
    mediaType: 'movie' | 'tv';
    title: string;
    posterUrl: string | null;
    overview: string | null;
  } | null;
};

let mockSearchParams: Record<string, string | string[] | undefined>;
const mockRouterPush = jest.fn();
const mockLoadGroupPoolHistory = jest.fn<Promise<HistoryPool[]>, [string]>();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockRouterPush }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/lib/pool', () => ({
  loadGroupPoolHistory: (...args: [string]) => mockLoadGroupPoolHistory(...args),
}));

let GroupPoolsScreen: React.ComponentType;
let missingGroupPoolsScreen = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  GroupPoolsScreen = require('@/app/(authenticated)/group/[groupId]/pools').default;
} catch {
  missingGroupPoolsScreen = true;
  GroupPoolsScreen = function MissingGroupPoolsScreen() {
    return <Text>Group pool history screen is not implemented yet.</Text>;
  };
}

function pool(overrides: Partial<HistoryPool> = {}): HistoryPool {
  return {
    id: overrides.id ?? 'pool-active',
    status: overrides.status ?? 'active',
    plannedFor: overrides.plannedFor ?? null,
    createdAt: overrides.createdAt ?? '2026-08-14T10:00:00.000Z',
    winner: overrides.winner ?? null,
  };
}

function completedPool(overrides: Partial<HistoryPool> = {}): HistoryPool {
  return pool({
    id: overrides.id ?? 'pool-completed',
    status: 'completed',
    createdAt: overrides.createdAt ?? '2026-08-14T11:00:00.000Z',
    winner: overrides.winner ?? {
      id: 'media-1',
      mediaType: 'movie',
      title: 'Arrival',
      posterUrl: 'https://cdn.example.test/arrival.jpg',
      overview: 'A linguist meets visitors from elsewhere.',
    },
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = { groupId: 'group-abc' };
  mockLoadGroupPoolHistory.mockResolvedValue([pool()]);
});

async function renderHistory() {
  const screen = await render(<GroupPoolsScreen />);
  if (missingGroupPoolsScreen) {
    throw new Error('Group pool history screen is not implemented yet.');
  }
  return screen;
}

describe('GroupPoolsScreen route states', () => {
  test('safe missing groupId shows a fallback and does not load', async () => {
    mockSearchParams = {};

    const screen = await renderHistory();

    expect(screen.getByText('Group not found')).toBeTruthy();
    expect(mockLoadGroupPoolHistory).not.toHaveBeenCalled();
  });

  test('empty groupId shows the same safe fallback', async () => {
    mockSearchParams = { groupId: '' };

    const screen = await renderHistory();

    expect(screen.getByText('Group not found')).toBeTruthy();
    expect(mockLoadGroupPoolHistory).not.toHaveBeenCalled();
  });

  test('array-form groupId normalizes to its first value', async () => {
    mockSearchParams = { groupId: ['group-first', 'group-second'] };
    mockLoadGroupPoolHistory.mockResolvedValueOnce([pool({ id: 'pool-first' })]);

    const screen = await renderHistory();

    await waitFor(() => expect(screen.getByText('pool-first')).toBeTruthy());
    expect(mockLoadGroupPoolHistory).toHaveBeenCalledWith('group-first');
  });

  test('loading state is visible while history is loading', async () => {
    let resolve!: (value: HistoryPool[]) => void;
    mockLoadGroupPoolHistory.mockReturnValueOnce(
      new Promise((res) => {
        resolve = res;
      })
    );

    const screen = await renderHistory();

    expect(screen.getByText('Loading pools')).toBeTruthy();
    resolve([pool()]);
  });

  test('error state is safe and retryable-looking when the boundary fails', async () => {
    mockLoadGroupPoolHistory.mockRejectedValueOnce(new Error('network'));

    const screen = await renderHistory();

    await waitFor(() => expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy());
  });

  test('empty history is distinct from loading and error', async () => {
    mockLoadGroupPoolHistory.mockResolvedValueOnce([]);

    const screen = await renderHistory();

    await waitFor(() => expect(screen.getByText('No pools yet')).toBeTruthy());
  });
});

describe('GroupPoolsScreen pool list', () => {
  test('renders all active and completed pools newest first with no three-pool cap', async () => {
    mockLoadGroupPoolHistory.mockResolvedValueOnce([
      completedPool({ id: 'pool-4', createdAt: '2026-08-14T14:00:00.000Z' }),
      pool({ id: 'pool-3', createdAt: '2026-08-14T13:00:00.000Z' }),
      pool({ id: 'pool-2', createdAt: '2026-08-14T12:00:00.000Z' }),
      completedPool({ id: 'pool-1', createdAt: '2026-08-14T11:00:00.000Z', winner: { id: 'media-2', mediaType: 'tv', title: 'Station Eleven', posterUrl: null, overview: null } }),
    ]);

    const screen = await renderHistory();

    await waitFor(() => expect(screen.getByText('pool-4')).toBeTruthy());
    expect(screen.getByText('pool-3')).toBeTruthy();
    expect(screen.getByText('pool-2')).toBeTruthy();
    expect(screen.getByText('pool-1')).toBeTruthy();
  });

  test('active pool card has Continue swiping and no winner metadata', async () => {
    mockLoadGroupPoolHistory.mockResolvedValueOnce([
      pool({ id: 'active-pool', plannedFor: '2026-08-15T20:30:00.000Z' }),
    ]);

    const screen = await renderHistory();

    await waitFor(() => expect(screen.getByText('active-pool')).toBeTruthy());
    expect(screen.getByText('Continue swiping')).toBeTruthy();
    expect(screen.getByText(/2026|Aug|15|8:30|20:30/i)).toBeTruthy();
    expect(screen.queryByText(/linguist/i)).toBeNull();
  });

  test('completed pool card renders provider-independent winner metadata', async () => {
    mockLoadGroupPoolHistory.mockResolvedValueOnce([completedPool()]);

    const screen = await renderHistory();

    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());
    expect(screen.getByText('A linguist meets visitors from elsewhere.')).toBeTruthy();
    expect(screen.getByLabelText('Poster for Arrival')).toBeTruthy();
    expect(screen.queryByText('Continue swiping')).toBeNull();
    expect(screen.queryByText('Matches')).toBeNull();
  });

  test('nullable overview and poster render safely without provider-specific copy', async () => {
    mockLoadGroupPoolHistory.mockResolvedValueOnce([
      completedPool({
        winner: { id: 'media-3', mediaType: 'movie', title: 'Moonlight', posterUrl: null, overview: null },
      }),
    ]);

    const screen = await renderHistory();

    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.queryByText(/tvdb|tmdb|streaming availability|synopsis|description/i)).toBeNull();
  });

  test('tapping a pool card or active primary action opens the exact pool route', async () => {
    mockLoadGroupPoolHistory.mockResolvedValueOnce([pool({ id: 'active-pool' })]);

    const screen = await renderHistory();
    await waitFor(() => expect(screen.getByText('active-pool')).toBeTruthy());

    await fireEvent.press(screen.getByText('active-pool'));
    await fireEvent.press(screen.getByText('Continue swiping'));

    expect(mockRouterPush).toHaveBeenNthCalledWith(1, {
      pathname: '/pool/[poolId]',
      params: { poolId: 'active-pool' },
    });
    expect(mockRouterPush).toHaveBeenNthCalledWith(2, {
      pathname: '/pool/[poolId]',
      params: { poolId: 'active-pool' },
    });
  });
});
