import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import PoolScreen from '@/app/(authenticated)/pool/[poolId]';
import type { GroupSummary } from '@/lib/group';

type MockGroupValue = {
  status: 'ready';
  currentGroup: GroupSummary | null;
  partner: GroupSummary['members'][number] | null;
};

let mockGroupValue: MockGroupValue;
let mockSearchParams: Record<string, string | string[] | undefined>;
const mockRouterPush = jest.fn();
const mockLoadPoolLifecycle = jest.fn<
  Promise<{
    poolId: string;
    status: 'active' | 'completed';
    createdBy: string | null;
    plannedFor: string | null;
    winnerMediaId: string | null;
    finalizedAt: string | null;
    winner: { id: string; mediaType: 'movie' | 'tv'; title: string; posterUrl: string | null } | null;
  } | null>,
  [string]
>();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockRouterPush }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/lib/group', () => ({
  useGroups: () => mockGroupValue,
}));

jest.mock('@/lib/pool', () => ({
  loadPoolLifecycle: (...args: [string]) => mockLoadPoolLifecycle(...args),
}));

// The deck's own loading/posters/swipe/undo behavior is covered by
// tests/component/swipe-deck.test.tsx. Here only the route -> prop wiring
// matters, so SwipeDeck is stubbed to surface the prop it actually received.
jest.mock('@/components/swipe-deck', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return {
    SwipeDeck: ({ poolId }: { poolId: string }) => <Text>{`SwipeDeck poolId:${poolId}`}</Text>,
  };
});

function group(overrides: Partial<GroupSummary> = {}): GroupSummary {
  return {
    id: overrides.id ?? 'group-1',
    ownerId: overrides.ownerId ?? 'user-1',
    isOwner: overrides.isOwner ?? true,
    accessState: overrides.accessState ?? 'active',
    memberCount: overrides.memberCount ?? 2,
    memberLimit: overrides.memberLimit ?? 2,
    members: overrides.members ?? [
      { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:00:00.000Z' },
      { userId: 'user-2', displayName: 'Partner', joinedAt: '2026-08-11T00:01:00.000Z' },
    ],
    invite: overrides.invite ?? null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGroupValue = {
    status: 'ready',
    currentGroup: group(),
    partner: { userId: 'user-2', displayName: 'Partner', joinedAt: '2026-08-11T00:01:00.000Z' },
  };
  mockSearchParams = { poolId: 'pool-abc' };
  mockLoadPoolLifecycle.mockResolvedValue({
    poolId: 'pool-abc',
    status: 'active',
    createdBy: 'user-1',
    plannedFor: null,
    winnerMediaId: null,
    finalizedAt: null,
    winner: null,
  });
});

describe('PoolScreen route wiring', () => {
  test('passes the resolved poolId from the route into SwipeDeck', async () => {
    const screen = await render(<PoolScreen />);

    expect(screen.getByText('SwipeDeck poolId:pool-abc')).toBeTruthy();
  });

  test('a missing poolId param shows a fallback instead of crashing', async () => {
    mockSearchParams = {};

    const screen = await render(<PoolScreen />);

    expect(screen.getByText('Pool not found')).toBeTruthy();
    expect(screen.queryByText(/^SwipeDeck poolId:/)).toBeNull();
  });

  test('an empty poolId param shows a fallback instead of crashing', async () => {
    mockSearchParams = { poolId: '' };

    const screen = await render(<PoolScreen />);

    expect(screen.getByText('Pool not found')).toBeTruthy();
    expect(screen.queryByText(/^SwipeDeck poolId:/)).toBeNull();
  });

  test('an array-form poolId param normalizes to its first value', async () => {
    mockSearchParams = { poolId: ['pool-first', 'pool-second'] };

    const screen = await render(<PoolScreen />);

    expect(screen.getByText('SwipeDeck poolId:pool-first')).toBeTruthy();
  });

  test('exposes a Matches action for the current pool', async () => {
    const screen = await render(<PoolScreen />);

    expect(screen.getByText('Matches')).toBeTruthy();
  });

  // The Home action moved out of this screen and into the native Stack header
  // configured for the route in `(authenticated)/_layout.tsx`; its visibility
  // and its replace('/') target are asserted in tests/component/routing.test.tsx.
  // What this screen still owes is the absence of a competing one -- two
  // headers fighting for the same edge is what the native header replaced.
  test('draws no header chrome of its own, in any pool lifecycle state', async () => {
    const active = await render(<PoolScreen />);

    await waitFor(() => expect(mockLoadPoolLifecycle).toHaveBeenCalledWith('pool-abc'));
    expect(active.queryByText('Home')).toBeNull();
    expect(active.queryByLabelText('Home')).toBeNull();

    mockLoadPoolLifecycle.mockResolvedValueOnce({
      poolId: 'pool-abc',
      status: 'completed',
      createdBy: 'user-1',
      plannedFor: null,
      winnerMediaId: 'media-2',
      finalizedAt: '2026-08-13T21:00:00.000Z',
      winner: { id: 'media-2', mediaType: 'movie', title: 'Moonlight', posterUrl: null },
    });

    const completed = await render(<PoolScreen />);

    await waitFor(() => expect(completed.getByText(/completed/i)).toBeTruthy());
    expect(completed.queryByText('Home')).toBeNull();
  });

  test('a broken pool link still renders its fallback below the route header', async () => {
    mockSearchParams = {};

    const screen = await render(<PoolScreen />);

    expect(screen.getByText('Pool not found')).toBeTruthy();
    expect(screen.queryByText('Home')).toBeNull();
  });

  test('pressing Matches navigates to the pool-specific matches route', async () => {
    const screen = await render(<PoolScreen />);

    await fireEvent.press(screen.getByText('Matches'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/pool/[poolId]/matches',
      params: { poolId: 'pool-abc' },
    });
  });

  test('shows planned watch time summary when the pool has one', async () => {
    mockLoadPoolLifecycle.mockResolvedValueOnce({
      poolId: 'pool-abc',
      status: 'active',
      createdBy: 'user-1',
      plannedFor: '2026-08-15T20:30:00.000Z',
      winnerMediaId: null,
      finalizedAt: null,
      winner: null,
    });

    const screen = await render(<PoolScreen />);

    await waitFor(() => expect(screen.getByText(/planned/i)).toBeTruthy());
    expect(screen.getByText(/2026|Aug|15|8:30|20:30/i)).toBeTruthy();
    expect(screen.getByText('SwipeDeck poolId:pool-abc')).toBeTruthy();
  });

  test('absent planned watch time keeps the pool screen uncluttered', async () => {
    const screen = await render(<PoolScreen />);

    await waitFor(() => expect(mockLoadPoolLifecycle).toHaveBeenCalledWith('pool-abc'));
    expect(screen.queryByText(/planned/i)).toBeNull();
    expect(screen.getByText('SwipeDeck poolId:pool-abc')).toBeTruthy();
  });

  test('completed pool summary shows winner and no swipe deck action', async () => {
    mockLoadPoolLifecycle.mockResolvedValueOnce({
      poolId: 'pool-abc',
      status: 'completed',
      createdBy: 'user-1',
      plannedFor: '2026-08-15T20:30:00.000Z',
      winnerMediaId: 'media-2',
      finalizedAt: '2026-08-13T21:00:00.000Z',
      winner: {
        id: 'media-2',
        mediaType: 'movie',
        title: 'Moonlight',
        posterUrl: null,
      },
    });

    const screen = await render(<PoolScreen />);

    await waitFor(() => expect(screen.getByText(/completed/i)).toBeTruthy());
    expect(screen.getByText('Moonlight')).toBeTruthy();
    expect(screen.getByText(/planned/i)).toBeTruthy();
    expect(screen.queryByText(/^SwipeDeck poolId:/)).toBeNull();
    expect(screen.getByText('Matches')).toBeTruthy();
  });

});
