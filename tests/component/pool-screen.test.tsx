import { fireEvent, render } from '@testing-library/react-native';
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

  test('pressing Matches navigates to the pool-specific matches route', async () => {
    const screen = await render(<PoolScreen />);

    await fireEvent.press(screen.getByText('Matches'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/pool/[poolId]/matches',
      params: { poolId: 'pool-abc' },
    });
  });
});
