import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import HomeScreen from '@/app/(authenticated)/(tabs)/index';
import type { GroupSummary } from '@/lib/group';
import type { GeneratePoolState, LatestActivePoolStatus } from '@/lib/pool';

type DashboardPool = {
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

type DashboardGroup = {
  id: string;
  name: string;
  pools: DashboardPool[];
};

type DashboardState =
  | { status: 'loading'; groups: [] }
  | { status: 'error'; groups: [] }
  | { status: 'ready'; groups: DashboardGroup[] };

type MockAuthValue = {
  status: 'ready';
  session: { user: { id: string } };
  signOut: jest.Mock;
};

type MockGroupValue = {
  status: 'ready';
  groups: GroupSummary[];
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
let mockDashboard: DashboardState;
let mockPoolValue: MockPoolValue;
let mockActivePoolValue: MockActivePoolValue;
const mockGenerateByGroup = new Map<string, MockPoolValue>();
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
  useGeneratePool: (groupId: string | null) => mockGenerateByGroup.get(groupId ?? '') ?? mockPoolValue,
  useHomeDashboard: () => mockDashboard,
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

function pool(overrides: Partial<DashboardPool> = {}): DashboardPool {
  return {
    id: overrides.id ?? 'pool-1',
    status: overrides.status ?? 'active',
    plannedFor: overrides.plannedFor ?? null,
    createdAt: overrides.createdAt ?? '2026-08-14T10:00:00.000Z',
    winner: overrides.winner ?? null,
  };
}

function completedPool(overrides: Partial<DashboardPool> = {}): DashboardPool {
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

function dashboardGroup(overrides: Partial<DashboardGroup> = {}): DashboardGroup {
  return {
    id: overrides.id ?? 'group-1',
    name: overrides.name ?? 'Friday Night',
    pools: overrides.pools ?? [pool({ id: 'pool-active' })],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateByGroup.clear();
  mockAuthValue = {
    status: 'ready',
    session: { user: { id: 'user-1' } },
    signOut: jest.fn(),
  };
  mockGroupValue = {
    status: 'ready',
    groups: [group()],
    currentGroup: group(),
    partner: { userId: 'user-2', displayName: 'Partner', joinedAt: '2026-08-11T00:01:00.000Z' },
  };
  mockDashboard = { status: 'ready', groups: [dashboardGroup()] };
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

describe('HomeScreen group dashboard', () => {
  test('renders every group section from the dashboard boundary', async () => {
    mockDashboard = {
      status: 'ready',
      groups: [
        dashboardGroup({ id: 'group-a', name: 'Friday Night' }),
        dashboardGroup({ id: 'group-b', name: 'Sunday Couch' }),
      ],
    };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Friday Night')).toBeTruthy();
    expect(screen.getByText('Sunday Couch')).toBeTruthy();
  });

  test('group headers expose accessible Invite and Group settings actions', async () => {
    mockDashboard = { status: 'ready', groups: [dashboardGroup({ name: 'Friday Night' })] };

    const screen = await render(<HomeScreen />);

    expect(screen.getByLabelText('Invite Friday Night')).toBeTruthy();
    expect(screen.getByLabelText('Group settings for Friday Night')).toBeTruthy();
  });

  test('tapping a group header opens the full group pool history route', async () => {
    mockDashboard = { status: 'ready', groups: [dashboardGroup({ id: 'group-a', name: 'Friday Night' })] };

    const screen = await render(<HomeScreen />);
    await fireEvent.press(screen.getByText('Friday Night'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/group/[groupId]/pools',
      params: { groupId: 'group-a' },
    });
  });

  test('Invite and settings actions target the existing pairing route with exact group identity', async () => {
    mockDashboard = { status: 'ready', groups: [dashboardGroup({ id: 'group-a', name: 'Friday Night' })] };

    const screen = await render(<HomeScreen />);
    await fireEvent.press(screen.getByLabelText('Invite Friday Night'));
    await fireEvent.press(screen.getByLabelText('Group settings for Friday Night'));

    expect(mockRouterPush).toHaveBeenNthCalledWith(1, {
      pathname: '/pair',
      params: { groupId: 'group-a', mode: 'invite' },
    });
    expect(mockRouterPush).toHaveBeenNthCalledWith(2, {
      pathname: '/pair',
      params: { groupId: 'group-a', mode: 'settings' },
    });
  });

  test('Home shows at most three pools per group, newest first', async () => {
    mockDashboard = {
      status: 'ready',
      groups: [
        dashboardGroup({
          pools: [
            pool({ id: 'pool-4', createdAt: '2026-08-14T14:00:00.000Z' }),
            pool({ id: 'pool-3', createdAt: '2026-08-14T13:00:00.000Z' }),
            completedPool({ id: 'pool-2', createdAt: '2026-08-14T12:00:00.000Z' }),
          ],
        }),
      ],
    };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('pool-4')).toBeTruthy();
    expect(screen.getByText('pool-3')).toBeTruthy();
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByText('pool-1')).toBeNull();
  });

  test('Make new pool exists at group level even when active pools already exist', async () => {
    const groupGenerate = { ...mockPoolValue, generate: jest.fn() };
    mockGenerateByGroup.set('group-1', groupGenerate);
    mockDashboard = {
      status: 'ready',
      groups: [dashboardGroup({ id: 'group-1', pools: [pool({ id: 'active-a' }), pool({ id: 'active-b' })] })],
    };

    const screen = await render(<HomeScreen />);
    await fireEvent.press(screen.getByText('Make new pool'));

    expect(groupGenerate.generate).toHaveBeenCalledTimes(1);
  });

  test('a newly generated pool becomes the newest visible pool without completing older active pools', async () => {
    mockGenerateByGroup.set('group-1', { ...mockPoolValue, state: 'created', poolId: 'pool-new' });
    mockDashboard = {
      status: 'ready',
      groups: [
        dashboardGroup({
          id: 'group-1',
          pools: [
            pool({ id: 'pool-new', createdAt: '2026-08-14T15:00:00.000Z' }),
            pool({ id: 'active-a', createdAt: '2026-08-14T14:00:00.000Z' }),
          ],
        }),
      ],
    };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('pool-new')).toBeTruthy();
    expect(screen.getByText('active-a')).toBeTruthy();
    expect(screen.getAllByText('Continue swiping')).toHaveLength(2);
  });
});

describe('HomeScreen pool cards', () => {
  test('active pool card shows planned time and Continue swiping, with no winner metadata or Matches shortcut', async () => {
    mockDashboard = {
      status: 'ready',
      groups: [
        dashboardGroup({
          pools: [pool({ id: 'pool-active', plannedFor: '2026-08-15T20:30:00.000Z' })],
        }),
      ],
    };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Continue swiping')).toBeTruthy();
    expect(screen.getByText(/2026|Aug|15|8:30|20:30/i)).toBeTruthy();
    expect(screen.queryByText('Arrival')).toBeNull();
    expect(screen.queryByText(/linguist/i)).toBeNull();
    expect(screen.queryByLabelText(/poster/i)).toBeNull();
    expect(screen.queryByText('Matches')).toBeNull();
  });

  test('active pool card and its primary action navigate to the exact pool', async () => {
    mockDashboard = { status: 'ready', groups: [dashboardGroup({ pools: [pool({ id: 'pool-active' })] })] };

    const screen = await render(<HomeScreen />);
    await fireEvent.press(screen.getByText('pool-active'));
    await fireEvent.press(screen.getByText('Continue swiping'));

    expect(mockRouterPush).toHaveBeenNthCalledWith(1, {
      pathname: '/pool/[poolId]',
      params: { poolId: 'pool-active' },
    });
    expect(mockRouterPush).toHaveBeenNthCalledWith(2, {
      pathname: '/pool/[poolId]',
      params: { poolId: 'pool-active' },
    });
  });

  test('completed pool card shows canonical winner poster, title, overview, and planned time', async () => {
    mockDashboard = {
      status: 'ready',
      groups: [
        dashboardGroup({
          pools: [completedPool({ plannedFor: '2026-08-15T20:30:00.000Z' })],
        }),
      ],
    };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.getByText('A linguist meets visitors from elsewhere.')).toBeTruthy();
    expect(screen.getByLabelText('Poster for Arrival')).toBeTruthy();
    expect(screen.getByText(/2026|Aug|15|8:30|20:30/i)).toBeTruthy();
    expect(screen.queryByText('Continue swiping')).toBeNull();
    expect(screen.queryByText('Matches')).toBeNull();
  });

  test('completed pool with nullable canonical overview renders safely without provider-specific fallback', async () => {
    mockDashboard = {
      status: 'ready',
      groups: [
        dashboardGroup({
          pools: [completedPool({ winner: { id: 'media-2', mediaType: 'tv', title: 'Station Eleven', posterUrl: null, overview: null } })],
        }),
      ],
    };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Station Eleven')).toBeTruthy();
    expect(screen.queryByText(/tvdb|tmdb|streaming availability|synopsis|description/i)).toBeNull();
  });

  test('completed pool card opens the exact completed pool route', async () => {
    mockDashboard = {
      status: 'ready',
      groups: [dashboardGroup({ pools: [completedPool({ id: 'pool-done' })] })],
    };

    const screen = await render(<HomeScreen />);
    await fireEvent.press(screen.getByText('Arrival'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/pool/[poolId]',
      params: { poolId: 'pool-done' },
    });
  });

  test('Home never exposes finalization or match-confirmation controls', async () => {
    mockDashboard = {
      status: 'ready',
      groups: [dashboardGroup({ pools: [pool({ id: 'active' }), completedPool()] })],
    };

    const screen = await render(<HomeScreen />);

    expect(screen.queryByText('Pick for us')).toBeNull();
    expect(screen.queryByText('Choose manually')).toBeNull();
    expect(screen.queryByText('I want to watch this!')).toBeNull();
  });
});

describe('HomeScreen dashboard loading states', () => {
  test('empty dashboard shows a safe no-groups state while keeping account actions available', async () => {
    mockGroupValue = { ...mockGroupValue, currentGroup: null, groups: [], partner: null };
    mockDashboard = { status: 'ready', groups: [] };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Pair up to start swiping')).toBeTruthy();
    expect(screen.getByText('Sign out')).toBeTruthy();
  });

  test('loading dashboard does not show beginner Quick Start or stale pool recovery UI', async () => {
    mockDashboard = { status: 'loading', groups: [] };

    const screen = await render(<HomeScreen />);

    expect(screen.queryByText('Quick Start')).toBeNull();
    expect(screen.queryByText('Pick up where you left off')).toBeNull();
  });

  test('dashboard load failure shows a safe retryable error rather than pretending there are no pools', async () => {
    mockDashboard = { status: 'error', groups: [] };

    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy();
  });

  test('stale async results from another group do not leak into the rendered dashboard', async () => {
    mockDashboard = {
      status: 'ready',
      groups: [dashboardGroup({ id: 'group-current', name: 'Current Group', pools: [pool({ id: 'current-pool' })] })],
    };

    const screen = await render(<HomeScreen />);

    await waitFor(() => expect(screen.getByText('Current Group')).toBeTruthy());
    expect(screen.queryByText('Old Group')).toBeNull();
    expect(screen.queryByText('old-pool')).toBeNull();
  });
});
