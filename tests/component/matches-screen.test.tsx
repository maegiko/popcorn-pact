import { render, waitFor } from '@testing-library/react-native';

import MatchesScreen from '@/app/(authenticated)/pool/[poolId]/matches';

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

let mockSearchParams: Record<string, string | string[] | undefined>;
const mockLoadPoolMatches = jest.fn<Promise<PoolMatch[]>, [string]>();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// The boundary's own query/mapping is covered by tests/unit/match.test.tsx.
// Here only the screen's loading/populated/empty/error/route wiring matters,
// so loadPoolMatches is stubbed directly -- the same discipline
// pool-screen.test.tsx uses for <SwipeDeck />.
jest.mock('@/lib/match', () => ({
  loadPoolMatches: (...args: [string]) => mockLoadPoolMatches(...args),
}));

function match(poolId: string, id: string, title: string, posterUrl: string | null = null): PoolMatch {
  return {
    poolId,
    media: {
      id,
      mediaType: 'movie',
      title,
      posterUrl,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = { poolId: 'pool-abc' };
});

describe('MatchesScreen', () => {
  test('shows a loading state while pool matches are loading', async () => {
    const pending = deferred<PoolMatch[]>();
    mockLoadPoolMatches.mockReturnValueOnce(pending.promise);

    const screen = await render(<MatchesScreen />);

    expect(mockLoadPoolMatches).toHaveBeenCalledWith('pool-abc');
    expect(screen.getByText('Loading matches')).toBeTruthy();
  });

  test('shows matched media for the current pool without raw swipe details', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([
      match('pool-abc', 'media-1', 'Arrival', 'https://cdn.example.test/arrival.jpg'),
      match('pool-abc', 'media-2', 'Moonlight'),
    ]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());
    expect(screen.getByText('Moonlight')).toBeTruthy();
    expect(screen.getByLabelText('Poster for Arrival')).toBeTruthy();
    expect(screen.queryByText(/liked by/i)).toBeNull();
    expect(screen.queryByText(/passed/i)).toBeNull();
    expect(screen.queryByText(/watched/i)).toBeNull();
  });

  test('shows an empty state when the pool has no matches', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText('No matches yet')).toBeTruthy());
  });

  test('shows an error state without crashing when the boundary fails', async () => {
    mockLoadPoolMatches.mockRejectedValueOnce(new Error('network'));

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy());
  });

  test('missing poolId shows the same safe fallback shape as the pool screen', async () => {
    mockSearchParams = {};

    const screen = await render(<MatchesScreen />);

    expect(screen.getByText('Pool not found')).toBeTruthy();
    expect(mockLoadPoolMatches).not.toHaveBeenCalled();
  });

  test('empty poolId shows the safe fallback instead of loading', async () => {
    mockSearchParams = { poolId: '' };

    const screen = await render(<MatchesScreen />);

    expect(screen.getByText('Pool not found')).toBeTruthy();
    expect(mockLoadPoolMatches).not.toHaveBeenCalled();
  });

  test('an array-form poolId normalizes to its first value', async () => {
    mockSearchParams = { poolId: ['pool-first', 'pool-second'] };
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-first', 'media-1', 'Arrival')]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());
    expect(mockLoadPoolMatches).toHaveBeenCalledWith('pool-first');
  });

  test('the list is scoped to the pool boundary result', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());
    expect(screen.queryByText('Other Pool Match')).toBeNull();
    expect(mockLoadPoolMatches).toHaveBeenCalledWith('pool-abc');
  });
});
