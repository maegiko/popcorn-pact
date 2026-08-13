import { fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import HomeScreen from '@/app/(authenticated)/(tabs)/index';
import type { GroupSummary } from '@/lib/group';
import type { GeneratePoolState, LatestActivePoolStatus } from '@/lib/pool';

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

type MockActivePoolValue = {
  status: LatestActivePoolStatus;
  poolId: string | null;
};

let mockAuthValue: MockAuthValue;
let mockGroupValue: MockGroupValue;
let mockPoolValue: MockPoolValue;
let mockActivePoolValue: MockActivePoolValue;
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
  useLatestActivePool: () => mockActivePoolValue,
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
  mockActivePoolValue = {
    status: 'none',
    poolId: null,
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

describe('HomeScreen pool recovery', () => {
  test('no active pool falls back to the beginner Quick Start UI', async () => {
    mockActivePoolValue = { status: 'none', poolId: null };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Quick Start')).toBeTruthy();
    expect(screen.queryByText('Continue swiping')).toBeNull();
  });

  test('an active pool shows the recovery state with Continue swiping', async () => {
    mockActivePoolValue = { status: 'found', poolId: 'pool-77' };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Continue swiping')).toBeTruthy();
    expect(screen.queryByText('Quick Start')).toBeNull();
  });

  test('pressing Continue swiping navigates with the exact recovered pool id', async () => {
    mockActivePoolValue = { status: 'found', poolId: 'pool-77' };

    const screen = await render(<HomeScreen />);
    fireEvent.press(screen.getByText('Continue swiping'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/pool/[poolId]',
      params: { poolId: 'pool-77' },
    });
  });

  // The boundary query (group_id + status = 'active', newest first) already
  // excludes completed pools, so a group whose entire history is completed
  // reports the same 'none' result as a group with no pools at all -- Home
  // does not need to know the difference.
  test('completed-only pool history behaves the same as having no active pool', async () => {
    mockActivePoolValue = { status: 'none', poolId: null };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Quick Start')).toBeTruthy();
    expect(screen.queryByText('Continue swiping')).toBeNull();
  });

  // Simulates the boundary having already applied ORDER BY created_at DESC
  // LIMIT 1 over active-only rows: a newer completed pool never reaches this
  // component, and the older active one is what gets surfaced and navigated
  // to.
  test('an older active pool is surfaced when a newer completed pool is excluded by the boundary', async () => {
    mockActivePoolValue = { status: 'found', poolId: 'pool-older-active' };

    const screen = await render(<HomeScreen />);
    fireEvent.press(screen.getByText('Continue swiping'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/pool/[poolId]',
      params: { poolId: 'pool-older-active' },
    });
  });

  test('Make new pool still requests a generated pool from the recovery state', async () => {
    mockActivePoolValue = { status: 'found', poolId: 'pool-77' };

    const screen = await render(<HomeScreen />);
    fireEvent.press(screen.getByText('Make new pool'));

    expect(mockPoolValue.generate).toHaveBeenCalledTimes(1);
  });

  test('a newly generated pool is surfaced over a stale recovered pool', async () => {
    mockActivePoolValue = { status: 'found', poolId: 'pool-old' };
    mockPoolValue = { ...mockPoolValue, state: 'created', poolId: 'pool-new' };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Start swiping')).toBeTruthy();
    expect(screen.queryByText('Continue swiping')).toBeNull();

    fireEvent.press(screen.getByText('Start swiping'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/pool/[poolId]',
      params: { poolId: 'pool-new' },
    });
  });

  test('a recovery lookup failure falls back to Quick Start without crashing', async () => {
    mockActivePoolValue = { status: 'error', poolId: null };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Quick Start')).toBeTruthy();
    expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy();
  });

  test('a still-loading recovery lookup shows neither the beginner UI nor the recovery state', async () => {
    mockActivePoolValue = { status: 'loading', poolId: null };

    const screen = await render(<HomeScreen />);

    expect(screen.queryByText('Quick Start')).toBeNull();
    expect(screen.queryByText('Continue swiping')).toBeNull();
  });
});
