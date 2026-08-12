import { fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import HomeScreen from '@/app/(authenticated)/(tabs)/index';
import type { GroupSummary } from '@/lib/group';
import type { GeneratePoolState } from '@/lib/pool';

type MockAuthValue = {
  status: 'ready';
  session: { user: { id: string } };
  signOut: jest.Mock;
};

type MockGroupValue = {
  status: 'ready';
  currentGroup: GroupSummary | null;
  partner: GroupSummary['members'][number] | null;
};

type MockPoolValue = {
  state: GeneratePoolState;
  poolId: string | null;
  generate: jest.Mock;
  reset: jest.Mock;
};

let mockAuthValue: MockAuthValue;
let mockGroupValue: MockGroupValue;
let mockPoolValue: MockPoolValue;
const mockRouterPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/lib/auth', () => ({
  useSession: () => mockAuthValue,
}));

jest.mock('@/lib/group', () => ({
  useGroups: () => mockGroupValue,
}));

jest.mock('@/lib/pool', () => ({
  useGeneratePool: () => mockPoolValue,
}));

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
  mockAuthValue = {
    status: 'ready',
    session: { user: { id: 'user-1' } },
    signOut: jest.fn(),
  };
  mockGroupValue = {
    status: 'ready',
    currentGroup: group(),
    partner: { userId: 'user-2', displayName: 'Partner', joinedAt: '2026-08-11T00:01:00.000Z' },
  };
  mockPoolValue = {
    state: 'idle',
    poolId: null,
    generate: jest.fn(),
    reset: jest.fn(),
  };
});

describe('HomeScreen pool CTA', () => {
  test('idle state shows Quick Start and no Start swiping CTA', async () => {
    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Quick Start')).toBeTruthy();
    expect(screen.queryByText('Start swiping')).toBeNull();
  });

  test('a successfully created pool exposes Start swiping', async () => {
    mockPoolValue = { ...mockPoolValue, state: 'created', poolId: 'pool-123' };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Your pool is ready')).toBeTruthy();
    expect(screen.getByText('Start swiping')).toBeTruthy();
  });

  test('pressing Start swiping navigates to the swipe route with the newly-created poolId', async () => {
    mockPoolValue = { ...mockPoolValue, state: 'created', poolId: 'pool-123' };

    const screen = await render(<HomeScreen />);
    fireEvent.press(screen.getByText('Start swiping'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/pool/[poolId]',
      params: { poolId: 'pool-123' },
    });
  });

  test('pressing Start swiping does not request another generated pool', async () => {
    mockPoolValue = { ...mockPoolValue, state: 'created', poolId: 'pool-123' };

    const screen = await render(<HomeScreen />);
    fireEvent.press(screen.getByText('Start swiping'));

    expect(mockPoolValue.generate).not.toHaveBeenCalled();
  });

  test('Make a new pool remains available and resets rather than navigating', async () => {
    mockPoolValue = { ...mockPoolValue, state: 'created', poolId: 'pool-123' };

    const screen = await render(<HomeScreen />);
    fireEvent.press(screen.getByText('Make a new pool'));

    expect(mockPoolValue.reset).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
