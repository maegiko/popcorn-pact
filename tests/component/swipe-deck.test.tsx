import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

type MediaRecord = {
  id: string;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl: string | null;
};

type SwipeRow = {
  poolId: string;
  mediaId: string;
  decision: 'like' | 'pass';
  undoable: boolean;
};

type PoolDeck = {
  media: MediaRecord[];
  swipes: SwipeRow[];
};

type RecordSwipeStatus =
  | 'recorded'
  | 'already_recorded'
  | 'like_final'
  | 'pass_must_be_undone'
  | 'not_a_member'
  | 'media_not_in_pool'
  | 'invalid_decision'
  | 'group_in_grace'
  | 'error';

type UndoStatus = 'undone' | 'nothing_to_undo' | 'not_a_member' | 'group_in_grace' | 'error';

type SwipeDeckProps = { poolId: string };

const mockLoadPoolDeck = jest.fn<Promise<PoolDeck>, [string]>();
const mockRecordSwipe = jest.fn<
  Promise<{ status: RecordSwipeStatus }>,
  [string, string, 'like' | 'pass']
>();
const mockUndoLastPass = jest.fn<Promise<{ status: UndoStatus; mediaId: string | null }>, [string]>();

jest.mock('../../src/lib/swipe', () => ({
  loadPoolDeck: (...args: [string]) => mockLoadPoolDeck(...args),
  recordSwipe: (...args: [string, string, 'like' | 'pass']) => mockRecordSwipe(...args),
  undoLastPass: (...args: [string]) => mockUndoLastPass(...args),
}));

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

let SwipeDeck: React.ComponentType<SwipeDeckProps>;
let missingSwipeDeck = false;
let swipeDecisionThreshold = 0;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const swipeDeckModule = require('@/components/swipe-deck');
  SwipeDeck = swipeDeckModule.SwipeDeck as React.ComponentType<SwipeDeckProps>;
  swipeDecisionThreshold = swipeDeckModule.SWIPE_DECISION_THRESHOLD as number;
} catch {
  missingSwipeDeck = true;
  SwipeDeck = function MissingSwipeDeck() {
    return <Text>SwipeDeck is not implemented yet.</Text>;
  };
}

function title(id: string, titleText: string, posterUrl: string | null = null): MediaRecord {
  return { id, title: titleText, mediaType: 'movie', posterUrl };
}

const MOVIE_A = title('media-a', 'Arrival', 'https://cdn.example.test/arrival.jpg');
const MOVIE_B = title('media-b', 'Moonlight', null);
const MOVIE_C = title('media-c', 'The Matrix', 'https://cdn.example.test/matrix.jpg');

function deck(media: MediaRecord[] = [MOVIE_A, MOVIE_B], swipes: SwipeRow[] = []): PoolDeck {
  return { media, swipes };
}

function swipe(
  poolId: string,
  mediaId: string,
  decision: 'like' | 'pass',
  undoable = false
): SwipeRow {
  return { poolId, mediaId, decision, undoable };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function renderDeck(poolId = 'pool-1') {
  const screen = render(<SwipeDeck poolId={poolId} />);
  if (missingSwipeDeck) {
    throw new Error('SwipeDeck is not implemented yet.');
  }
  await waitFor(() => expect(mockLoadPoolDeck).toHaveBeenCalledWith(poolId));
  return screen;
}

async function renderLoadedDeck(pool: PoolDeck = deck(), poolId = 'pool-1') {
  mockLoadPoolDeck.mockResolvedValueOnce(pool);
  const screen = await renderDeck(poolId);
  await waitFor(() => expect(screen.getByText(firstUnresolvedTitle(pool, poolId))).toBeTruthy());
  return screen;
}

function firstUnresolvedTitle(pool: PoolDeck, poolId: string): string {
  const resolved = new Set(
    pool.swipes.filter((row) => row.poolId === poolId).map((row) => row.mediaId)
  );
  const media = pool.media.find((item) => !resolved.has(item.id));
  return media?.title ?? "You're done with this pool.";
}

/**
 * Drives the card's real Gesture.Pan via react-native-gesture-handler's own
 * jest utilities, ending the gesture at `translationX`. This exercises the
 * production `.onEnd` handler (and therefore resolveSwipeGesture and the
 * exact onPass/onLike callbacks the buttons use) rather than a hand-rolled
 * stand-in for the gesture library.
 */
async function swipeCard(translationX: number) {
  await act(() => {
    fireGestureHandler(getByGestureTestId('swipe-card-gesture'), [{ translationX }]);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SwipeDeck loading behavior', () => {
  test('loads the supplied pool and immediately shows the first unresolved title', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]), 'pool-1');

    expect(mockLoadPoolDeck).toHaveBeenCalledWith('pool-1');
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByText('Moonlight')).toBeNull();
  });

  test('filters out titles already liked in this pool', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B], [swipe('pool-1', MOVIE_A.id, 'like')]));

    expect(screen.queryByText('Arrival')).toBeNull();
    expect(screen.getByText('Moonlight')).toBeTruthy();
  });

  test('filters out titles already passed in this pool', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B], [swipe('pool-1', MOVIE_A.id, 'pass')]));

    expect(screen.queryByText('Arrival')).toBeNull();
    expect(screen.getByText('Moonlight')).toBeTruthy();
  });

  test('does not filter the same media merely because it was swiped in another pool', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_A], [swipe('other-pool', MOVIE_A.id, 'pass')]));

    expect(screen.getByText('Arrival')).toBeTruthy();
  });

  test('shows the exhausted state when every title is resolved in this pool', async () => {
    mockLoadPoolDeck.mockResolvedValueOnce(
      deck([MOVIE_A, MOVIE_B], [swipe('pool-1', MOVIE_A.id, 'like'), swipe('pool-1', MOVIE_B.id, 'pass')])
    );

    const screen = await renderDeck('pool-1');

    await waitFor(() => expect(screen.getByText("You're done with this pool.")).toBeTruthy());
  });
});

describe('SwipeDeck current card behavior', () => {
  test('surfaces exactly the current title as the active choice with pass and like actions', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByText('Moonlight')).toBeNull();
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText('Like')).toBeTruthy();
  });

  test('renders the poster image for media carrying a canonical posterUrl', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_A]));

    const poster = screen.getByLabelText('Poster for Arrival');
    expect(poster.props.source).toEqual({ uri: MOVIE_A.posterUrl });
  });

  test('renders a card without crashing when posterUrl is null', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_B]));

    expect(screen.getByText('Moonlight')).toBeTruthy();
  });
});

describe('SwipeDeck pass behavior', () => {
  test('records a pass for the current card and waits for success before advancing', async () => {
    const pending = deferred<{ status: RecordSwipeStatus }>();
    mockRecordSwipe.mockReturnValueOnce(pending.promise);
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Pass'));

    expect(mockRecordSwipe).toHaveBeenCalledWith('pool-1', MOVIE_A.id, 'pass');
    expect(screen.getByText('Arrival')).toBeTruthy();

    pending.resolve({ status: 'recorded' });

    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.getByText('Undo')).toBeTruthy();
  });

  test('treats duplicate pass as harmless success', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'already_recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Pass'));

    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.queryByText('Arrival')).toBeNull();
    expect(screen.getByText('Undo')).toBeTruthy();
  });

  test('keeps the current title visible and surfaces an error when pass fails', async () => {
    mockRecordSwipe.mockRejectedValueOnce(new Error('offline'));
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Pass'));

    await waitFor(() => expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy());
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByText('Moonlight')).toBeNull();
  });
});

describe('SwipeDeck like behavior', () => {
  test('records a like and advances without exposing undo', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Like'));

    expect(mockRecordSwipe).toHaveBeenCalledWith('pool-1', MOVIE_A.id, 'like');
    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.queryByText('Undo')).toBeNull();
  });

  test('does not end the pool early merely because a title was liked', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Like'));

    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.queryByText("You're done with this pool.")).toBeNull();
  });

  test('treats duplicate like as harmless success', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'already_recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Like'));

    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.queryByText('Undo')).toBeNull();
  });

  test('keeps the current title visible and surfaces an error when like fails', async () => {
    mockRecordSwipe.mockRejectedValueOnce(new Error('offline'));
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Like'));

    await waitFor(() => expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy());
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByText('Moonlight')).toBeNull();
  });
});

describe('SwipeDeck conflict statuses', () => {
  test.each(['like_final', 'pass_must_be_undone'] as const)(
    'keeps the current card visible when recordSwipe returns %s',
    async (status) => {
      mockRecordSwipe.mockResolvedValueOnce({ status });
      const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

      fireEvent.press(screen.getByText('Pass'));

      await waitFor(() => expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy());
      expect(screen.getByText('Arrival')).toBeTruthy();
      expect(screen.queryByText('Moonlight')).toBeNull();
    }
  );
});

describe('SwipeDeck undo behavior', () => {
  test('pass A then undo restores A and hides undo', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    mockUndoLastPass.mockResolvedValueOnce({ status: 'undone', mediaId: MOVIE_A.id });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Pass'));
    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());

    fireEvent.press(screen.getByText('Undo'));

    expect(mockUndoLastPass).toHaveBeenCalledWith('pool-1');
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());
    expect(screen.queryByText('Undo')).toBeNull();
  });

  test('pass A then pass B leaves only B undoable', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    mockUndoLastPass.mockResolvedValueOnce({ status: 'undone', mediaId: MOVIE_B.id });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B, MOVIE_C]));

    fireEvent.press(screen.getByText('Pass'));
    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());

    fireEvent.press(screen.getByText('Pass'));
    await waitFor(() => expect(screen.getByText('The Matrix')).toBeTruthy());

    fireEvent.press(screen.getByText('Undo'));

    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.queryByText('Arrival')).toBeNull();
    expect(screen.queryByText('Undo')).toBeNull();
  });

  test('pass A then like B consumes the undo opportunity for A', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B, MOVIE_C]));

    fireEvent.press(screen.getByText('Pass'));
    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.getByText('Undo')).toBeTruthy();

    fireEvent.press(screen.getByText('Like'));

    await waitFor(() => expect(screen.getByText('The Matrix')).toBeTruthy());
    expect(screen.queryByText('Undo')).toBeNull();
  });
});

describe('SwipeDeck reload behavior', () => {
  test('remount reconstructs the unresolved deck from fresh loaded server state', async () => {
    mockLoadPoolDeck.mockResolvedValueOnce(deck([MOVIE_A, MOVIE_B]));
    const first = await renderDeck('pool-1');
    await waitFor(() => expect(first.getByText('Arrival')).toBeTruthy());
    await first.unmount();

    mockLoadPoolDeck.mockResolvedValueOnce(
      deck([MOVIE_A, MOVIE_B], [swipe('pool-1', MOVIE_A.id, 'like')])
    );

    const second = await renderDeck('pool-1');

    await waitFor(() => expect(second.getByText('Moonlight')).toBeTruthy());
    expect(second.queryByText('Arrival')).toBeNull();
    expect(second.queryByText('Undo')).toBeNull();
  });

  test('remount exposes Undo immediately when the persisted swipe is undoable', async () => {
    mockUndoLastPass.mockResolvedValueOnce({ status: 'undone', mediaId: MOVIE_A.id });

    const screen = await renderLoadedDeck(
      deck([MOVIE_A, MOVIE_B], [swipe('pool-1', MOVIE_A.id, 'pass', true)])
    );

    expect(screen.getByText('Moonlight')).toBeTruthy();
    expect(screen.getByText('Undo')).toBeTruthy();

    fireEvent.press(screen.getByText('Undo'));

    expect(mockUndoLastPass).toHaveBeenCalledWith('pool-1');
    await waitFor(() => expect(screen.getByText('Arrival')).toBeTruthy());
    expect(screen.queryByText('Undo')).toBeNull();
  });

  test('remount hides Undo when the persisted swipe is settled', async () => {
    const screen = await renderLoadedDeck(
      deck([MOVIE_A, MOVIE_B], [swipe('pool-1', MOVIE_A.id, 'pass', false)])
    );

    expect(screen.getByText('Moonlight')).toBeTruthy();
    expect(screen.queryByText('Undo')).toBeNull();
  });
});

describe('SwipeDeck exhaustion behavior', () => {
  test('shows exhausted state after the last unresolved title is liked', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A]));

    fireEvent.press(screen.getByText('Like'));

    await waitFor(() => expect(screen.getByText("You're done with this pool.")).toBeTruthy());
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  test('shows exhausted state after the last unresolved title is passed', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A]));

    fireEvent.press(screen.getByText('Pass'));

    await waitFor(() => expect(screen.getByText("You're done with this pool.")).toBeTruthy());
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});

describe('SwipeDeck gesture behavior', () => {
  test('a left swipe past the threshold records a pass, the same as the Pass button', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(-swipeDecisionThreshold - 40);

    expect(mockRecordSwipe).toHaveBeenCalledWith('pool-1', MOVIE_A.id, 'pass');
    // Let the mutation settle before the test ends, so nothing is still in
    // flight when the next test unmounts/mounts its own deck.
    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
  });

  test('a right swipe past the threshold records a like, the same as the Like button', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(swipeDecisionThreshold + 40);

    expect(mockRecordSwipe).toHaveBeenCalledWith('pool-1', MOVIE_A.id, 'like');
    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
  });

  test('releasing below the threshold records no swipe and leaves the card in place', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(swipeDecisionThreshold - 40);

    expect(mockRecordSwipe).not.toHaveBeenCalled();
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByText('Moonlight')).toBeNull();
  });

  test('a below-threshold swipe in either direction records nothing', async () => {
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(-(swipeDecisionThreshold - 40));

    expect(mockRecordSwipe).not.toHaveBeenCalled();
    expect(screen.getByText('Arrival')).toBeTruthy();
  });

  test('a successful left-swipe pass advances the deck and exposes Undo', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(-swipeDecisionThreshold - 40);

    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.getByText('Undo')).toBeTruthy();
  });

  test('a successful right-swipe like advances the deck without exposing Undo', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(swipeDecisionThreshold + 40);

    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
    expect(screen.queryByText('Undo')).toBeNull();
  });

  test('a gesture-triggered mutation failure keeps the current card and shows the error state', async () => {
    mockRecordSwipe.mockRejectedValueOnce(new Error('offline'));
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(-swipeDecisionThreshold - 40);

    await waitFor(() => expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy());
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByText('Moonlight')).toBeNull();
  });

  test('a gesture-triggered conflict status keeps the current card and shows the error state', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'pass_must_be_undone' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(-swipeDecisionThreshold - 40);

    await waitFor(() => expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy());
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByText('Moonlight')).toBeNull();
  });

  test('a swipe cannot submit another decision while a mutation is pending', async () => {
    const pending = deferred<{ status: RecordSwipeStatus }>();
    mockRecordSwipe.mockReturnValueOnce(pending.promise);
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    await swipeCard(-swipeDecisionThreshold - 40);
    expect(mockRecordSwipe).toHaveBeenCalledTimes(1);

    await swipeCard(-swipeDecisionThreshold - 40);
    expect(mockRecordSwipe).toHaveBeenCalledTimes(1);

    pending.resolve({ status: 'recorded' });
    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
  });

  test('the Pass and Like buttons remain fully functional alongside gestures', async () => {
    mockRecordSwipe.mockResolvedValueOnce({ status: 'recorded' });
    const screen = await renderLoadedDeck(deck([MOVIE_A, MOVIE_B]));

    fireEvent.press(screen.getByText('Like'));

    expect(mockRecordSwipe).toHaveBeenCalledWith('pool-1', MOVIE_A.id, 'like');
    await waitFor(() => expect(screen.getByText('Moonlight')).toBeTruthy());
  });
});
