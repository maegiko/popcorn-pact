import { fireEvent, render, waitFor } from '@testing-library/react-native';

import MatchesScreen from '@/app/(authenticated)/pool/[poolId]/matches';
import { formatPlannedFor } from '@/lib/format';

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

type PoolLifecycle = {
  poolId: string;
  status: 'active' | 'completed';
  createdBy: string | null;
  plannedFor: string | null;
  winnerMediaId: string | null;
  finalizedAt: string | null;
  winner: MatchMedia | null;
};

let mockSearchParams: Record<string, string | string[] | undefined>;
let mockUserId: string | null;
const mockLoadPoolMatches = jest.fn<Promise<PoolMatch[]>, [string]>();
const mockLoadPoolLifecycle = jest.fn<Promise<PoolLifecycle | null>, [string]>();
const mockSetPoolPlannedFor = jest.fn<Promise<{ status: string }>, [string, string | null]>();
const mockFinalizePool = jest.fn<Promise<{ status: string; mediaId: string | null }>, [string, string]>();
const mockFinalizePoolRandom = jest.fn<Promise<{ status: string; mediaId: string | null }>, [string]>();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('@/lib/auth', () => ({
  useSession: () => ({
    session: mockUserId ? { user: { id: mockUserId } } : null,
  }),
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

jest.mock('@/lib/pool', () => ({
  loadPoolLifecycle: (...args: [string]) => mockLoadPoolLifecycle(...args),
  setPoolPlannedFor: (...args: [string, string | null]) => mockSetPoolPlannedFor(...args),
  finalizePool: (...args: [string, string]) => mockFinalizePool(...args),
  finalizePoolRandom: (...args: [string]) => mockFinalizePoolRandom(...args),
}));

/** The exact moment the mock picker below "selects" when pressed. */
const PICKED_DATE = '2026-08-20T15:45:00.000Z';

// The real <PlannedTimePicker /> wraps @expo/ui's native SwiftUI/Jetpack
// Compose date+time controls, which have nothing to interact with under
// Jest. This stub renders the current value as text (so tests can assert on
// what the editor was initialized with) and a single button that reports a
// fixed, known date -- enough to exercise the screen's own save/cancel/clear
// wiring without depending on a real platform picker.
jest.mock('@/components/planned-time-picker', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    PlannedTimePicker: ({ value, onChange }: { value: Date; onChange: (next: Date) => void }) => (
      <Pressable onPress={() => onChange(new Date(PICKED_DATE))}>
        <Text>{`Picker value: ${value.toISOString()}`}</Text>
      </Pressable>
    ),
  };
});

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

function media(id: string, title: string): MatchMedia {
  return {
    id,
    mediaType: 'movie',
    title,
    posterUrl: null,
  };
}

function lifecycle(overrides: Partial<PoolLifecycle> = {}): PoolLifecycle {
  return {
    poolId: overrides.poolId ?? 'pool-abc',
    status: overrides.status ?? 'active',
    createdBy: overrides.createdBy ?? 'user-owner',
    plannedFor: overrides.plannedFor ?? null,
    winnerMediaId: overrides.winnerMediaId ?? null,
    finalizedAt: overrides.finalizedAt ?? null,
    winner: overrides.winner ?? null,
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
  mockUserId = 'user-owner';
  mockLoadPoolLifecycle.mockResolvedValue(lifecycle());
});

describe('MatchesScreen', () => {
  test('shows a loading state while pool matches are loading', async () => {
    const pending = deferred<PoolMatch[]>();
    mockLoadPoolMatches.mockReturnValueOnce(pending.promise);
    mockLoadPoolLifecycle.mockReturnValueOnce(pending.promise.then(() => lifecycle()));

    const screen = await render(<MatchesScreen />);

    expect(mockLoadPoolMatches).toHaveBeenCalledWith('pool-abc');
    expect(mockLoadPoolLifecycle).toHaveBeenCalledWith('pool-abc');
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

  test('shows planned watch time when present without brittle locale formatting', async () => {
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({ plannedFor: '2026-08-15T20:30:00.000Z' })
    );
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText(/planned/i)).toBeTruthy());
    expect(screen.getByText(/2026|Aug|15|8:30|20:30/i)).toBeTruthy();
  });

  test('owner can open the planned-time editor', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Add planned time'));

    expect(screen.getByText('Save planned time')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.getByText('Clear planned time')).toBeTruthy();
  });

  test('an existing planned time initializes the editor with that value', async () => {
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({ plannedFor: '2026-08-15T20:30:00.000Z' })
    );
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit planned time'));

    expect(screen.getByText('Picker value: 2026-08-15T20:30:00.000Z')).toBeTruthy();
  });

  test('a fresh planned time initializes the editor with a sensible upcoming default, not an empty value', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Add planned time'));

    const pickerText = screen.getByText(/^Picker value: /);
    const isoValue = String(pickerText.props.children).replace('Picker value: ', '');
    expect(new Date(isoValue).getTime()).toBeGreaterThan(Date.now());
  });

  test('selecting a date/time and saving sends that exact timestamp to the boundary', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);
    mockSetPoolPlannedFor.mockResolvedValueOnce({ status: 'updated' });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Add planned time'));
    await fireEvent.press(screen.getByText(/^Picker value: /));
    await fireEvent.press(screen.getByText('Save planned time'));

    expect(mockSetPoolPlannedFor).toHaveBeenCalledWith('pool-abc', PICKED_DATE);
  });

  test('canceling the editor does not save and leaves the persisted value unchanged', async () => {
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({ plannedFor: '2026-08-15T20:30:00.000Z' })
    );
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit planned time'));
    await fireEvent.press(screen.getByText(/^Picker value: /));
    await fireEvent.press(screen.getByText('Cancel'));

    expect(mockSetPoolPlannedFor).not.toHaveBeenCalled();
    expect(screen.getByText(/2026|Aug|15|8:30|20:30/i)).toBeTruthy();
    expect(screen.getByText('Edit planned time')).toBeTruthy();
  });

  test('owner can edit and clear planned time', async () => {
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({ plannedFor: '2026-08-15T20:30:00.000Z' })
    );
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);
    mockSetPoolPlannedFor.mockResolvedValueOnce({ status: 'updated' });
    mockSetPoolPlannedFor.mockResolvedValueOnce({ status: 'updated' });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit planned time'));
    await fireEvent.press(screen.getByText(/^Picker value: /));
    await fireEvent.press(screen.getByText('Save planned time'));
    await fireEvent.press(screen.getByText('Clear planned time'));

    expect(mockSetPoolPlannedFor).toHaveBeenNthCalledWith(1, 'pool-abc', PICKED_DATE);
    expect(mockSetPoolPlannedFor).toHaveBeenNthCalledWith(2, 'pool-abc', null);
  });

  test('non-owner sees planned time but no edit controls', async () => {
    mockUserId = 'user-partner';
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({ plannedFor: '2026-08-15T20:30:00.000Z' })
    );
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText(/planned/i)).toBeTruthy());
    expect(screen.queryByText('Add planned time')).toBeNull();
    expect(screen.queryByText('Edit planned time')).toBeNull();
    expect(screen.queryByText('Clear planned time')).toBeNull();
  });

  test('planned-time errors do not silently update the persisted display value', async () => {
    const originalPlannedFor = '2026-08-15T20:30:00.000Z';
    mockLoadPoolLifecycle.mockResolvedValueOnce(lifecycle({ plannedFor: originalPlannedFor }));
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);
    mockSetPoolPlannedFor.mockResolvedValueOnce({ status: 'not_creator' });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit planned time'));
    await fireEvent.press(screen.getByText(/^Picker value: /));
    await fireEvent.press(screen.getByText('Save planned time'));

    expect(screen.queryByText(/completed/i)).toBeNull();

    // The rejected save must not have committed: closing the editor (without
    // it having been re-opened to a fresh value) has to reveal the original
    // persisted time, not the one that failed to save.
    await fireEvent.press(screen.getByText('Cancel'));

    expect(screen.getByText(formatPlannedFor(originalPlannedFor))).toBeTruthy();
    expect(screen.queryByText(formatPlannedFor(PICKED_DATE))).toBeNull();
  });

  test('shows an empty state when the pool has no matches', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText('No matches yet')).toBeTruthy());
    expect(screen.queryByText('Pick for us')).toBeNull();
    expect(screen.queryByText('Choose manually')).toBeNull();
    expect(screen.queryByText('Finalize match')).toBeNull();
  });

  test('shows an error state without crashing when the boundary fails', async () => {
    mockLoadPoolMatches.mockRejectedValueOnce(new Error('network'));

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy());
  });

  test('shows an error state without crashing when lifecycle loading fails', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);
    mockLoadPoolLifecycle.mockRejectedValueOnce(new Error('network'));

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

  test('one-match active pool exposes one obvious finalization action', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);
    mockFinalizePool.mockResolvedValueOnce({ status: 'finalized', mediaId: 'media-1' });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    expect(screen.getByText('Finalize match')).toBeTruthy();
    expect(screen.queryByText('Pick for us')).toBeNull();
    expect(screen.queryByText('Choose manually')).toBeNull();

    // Queued now, not before the initial render: it is the pool-screen's
    // post-finalize refresh call that should observe the completed pool, not
    // the mount-time load, which must still see the pool as active so the
    // finalize action above is reachable at all.
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({
        status: 'completed',
        winnerMediaId: 'media-1',
        finalizedAt: '2026-08-13T21:00:00.000Z',
        winner: media('media-1', 'Arrival'),
      })
    );

    await fireEvent.press(screen.getByText('Finalize match'));

    expect(mockFinalizePool).toHaveBeenCalledWith('pool-abc', 'media-1');
    await waitFor(() => expect(screen.getByText(/completed/i)).toBeTruthy());
    expect(screen.getByText('Arrival')).toBeTruthy();
  });

  test('multiple-match active pool lets the owner pick randomly or manually', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([
      match('pool-abc', 'media-1', 'Arrival'),
      match('pool-abc', 'media-2', 'Moonlight'),
    ]);
    mockFinalizePoolRandom.mockResolvedValueOnce({ status: 'finalized', mediaId: 'media-2' });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    expect(screen.getByText('Pick for us')).toBeTruthy();
    expect(screen.getByText('Choose manually')).toBeTruthy();

    // See the one-match test above for why this is queued after the initial
    // render rather than before it.
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({
        status: 'completed',
        winnerMediaId: 'media-2',
        finalizedAt: '2026-08-13T21:00:00.000Z',
        winner: media('media-2', 'Moonlight'),
      })
    );

    await fireEvent.press(screen.getByText('Pick for us'));

    expect(mockFinalizePoolRandom).toHaveBeenCalledWith('pool-abc');
    await waitFor(() => expect(screen.getByText(/completed/i)).toBeTruthy());
    expect(screen.getByText('Moonlight')).toBeTruthy();
  });

  test('manual selection finalizes exactly the selected pool match', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([
      match('pool-abc', 'media-1', 'Arrival'),
      match('pool-abc', 'media-2', 'Moonlight'),
    ]);
    mockFinalizePool.mockResolvedValueOnce({ status: 'finalized', mediaId: 'media-2' });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Choose manually'));
    await fireEvent.press(screen.getByText('Choose Moonlight'));

    expect(mockFinalizePool).toHaveBeenCalledWith('pool-abc', 'media-2');
    expect(screen.queryByText('Choose Other Pool Match')).toBeNull();
  });

  test('non-owner sees matches but no finalization controls', async () => {
    mockUserId = 'user-partner';
    mockLoadPoolMatches.mockResolvedValueOnce([
      match('pool-abc', 'media-1', 'Arrival'),
      match('pool-abc', 'media-2', 'Moonlight'),
    ]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());
    expect(screen.queryByText('Finalize match')).toBeNull();
    expect(screen.queryByText('Pick for us')).toBeNull();
    expect(screen.queryByText('Choose manually')).toBeNull();
  });

  test('completed pool shows winner, planned time, and no re-finalization controls', async () => {
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({
        status: 'completed',
        plannedFor: '2026-08-15T20:30:00.000Z',
        winnerMediaId: 'media-2',
        finalizedAt: '2026-08-13T21:00:00.000Z',
        winner: media('media-2', 'Moonlight'),
      })
    );
    mockLoadPoolMatches.mockResolvedValueOnce([
      match('pool-abc', 'media-1', 'Arrival'),
      match('pool-abc', 'media-2', 'Moonlight'),
    ]);

    const screen = await render(<MatchesScreen />);

    await waitFor(() => expect(screen.getByText(/completed/i)).toBeTruthy());
    expect(screen.getByText('Moonlight')).toBeTruthy();
    expect(screen.getByText(/planned/i)).toBeTruthy();
    expect(screen.queryByText('Finalize match')).toBeNull();
    expect(screen.queryByText('Pick for us')).toBeNull();
    expect(screen.queryByText('Choose manually')).toBeNull();
    expect(screen.getByText('Edit planned time')).toBeTruthy();
    expect(screen.queryByText(/swipe/i)).toBeNull();
  });

  test('owner can reschedule planned time after completion without changing winner', async () => {
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({
        status: 'completed',
        plannedFor: '2026-08-15T20:30:00.000Z',
        winnerMediaId: 'media-2',
        finalizedAt: '2026-08-13T21:00:00.000Z',
        winner: media('media-2', 'Moonlight'),
      })
    );
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-2', 'Moonlight')]);
    mockSetPoolPlannedFor.mockResolvedValueOnce({ status: 'updated' });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText(/completed/i)).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit planned time'));
    await fireEvent.press(screen.getByText(/^Picker value: /));
    await fireEvent.press(screen.getByText('Save planned time'));

    expect(mockSetPoolPlannedFor).toHaveBeenCalledWith('pool-abc', PICKED_DATE);
    expect(screen.getByText('Moonlight')).toBeTruthy();
  });

  test('finalization failure does not show completed state', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);
    mockFinalizePool.mockResolvedValueOnce({ status: 'no_matches', mediaId: null });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    await fireEvent.press(screen.getByText('Finalize match'));

    expect(screen.queryByText(/completed/i)).toBeNull();
    expect(screen.getByText(/Something went wrong|Try again|No matches/i)).toBeTruthy();
  });

  test('already_completed response refreshes into completed read state', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([match('pool-abc', 'media-1', 'Arrival')]);
    mockFinalizePool.mockResolvedValueOnce({ status: 'already_completed', mediaId: null });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    // See the one-match test above for why this is queued after the initial
    // render rather than before it.
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({
        status: 'completed',
        winnerMediaId: 'media-1',
        finalizedAt: '2026-08-13T21:00:00.000Z',
        winner: media('media-1', 'Arrival'),
      })
    );

    await fireEvent.press(screen.getByText('Finalize match'));

    await waitFor(() => expect(screen.getByText(/completed/i)).toBeTruthy());
    expect(screen.getByText('Arrival')).toBeTruthy();
  });

  test('random winner reveal uses the backend-returned winner, not the first client-side candidate', async () => {
    mockLoadPoolMatches.mockResolvedValueOnce([
      match('pool-abc', 'media-client-first', 'Arrival'),
      match('pool-abc', 'media-backend-picked', 'Moonlight'),
    ]);
    mockFinalizePoolRandom.mockResolvedValueOnce({ status: 'finalized', mediaId: 'media-backend-picked' });

    const screen = await render(<MatchesScreen />);
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());

    // See the one-match test above for why this is queued after the initial
    // render rather than before it.
    mockLoadPoolLifecycle.mockResolvedValueOnce(
      lifecycle({
        status: 'completed',
        winnerMediaId: 'media-backend-picked',
        finalizedAt: '2026-08-13T21:00:00.000Z',
        winner: media('media-backend-picked', 'Moonlight'),
      })
    );

    await fireEvent.press(screen.getByText('Pick for us'));

    await waitFor(() => expect(screen.getByText(/completed/i)).toBeTruthy());
    expect(screen.getByText('Moonlight')).toBeTruthy();
  });
});
