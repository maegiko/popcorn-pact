import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Text } from 'react-native';

import TabsLayout from '@/app/(authenticated)/(tabs)/_layout';
import HomeScreen from '@/app/(authenticated)/(tabs)/index';
import AuthenticatedLayout from '@/app/(authenticated)/_layout';
import RootLayout from '@/app/_layout';
import { GroupRequired } from '@/components/group-required';
import type { GroupSummary } from '@/lib/group';

type MockAuthValue = {
  status: 'loading' | 'error' | 'signedOut' | 'needsDisplayName' | 'ready';
  session: { user: { id: string } } | null;
  signOut: jest.Mock;
};

type MockGroupValue = {
  status: 'loading' | 'error' | 'ready';
  groups: GroupSummary[];
  currentGroup: GroupSummary | null;
  partner: GroupSummary['members'][number] | null;
  retryLoad: jest.Mock;
  leaveGroup: jest.Mock;
};

let mockAuthValue: MockAuthValue;
let mockGroupValue: MockGroupValue;
const mockRouterPush = jest.fn();

function MockStackBase({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function MockStackProtected({ guard, children }: { guard: boolean; children: ReactNode }) {
  return guard ? <>{children}</> : null;
}

function MockStackScreen({ name }: { name: string; options?: object }) {
  return <Text>{`stack:${name}`}</Text>;
}

function MockLink({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function MockThemeProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function MockNativeTabsTriggerBase({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <Text>{`tab:${name}`}</Text>
      {children}
    </>
  );
}

function MockNativeTabsTriggerLabel({ children }: { children: ReactNode }) {
  return <Text>{children}</Text>;
}

function MockNativeTabsTriggerIcon() {
  return null;
}

function MockNativeTabsBase({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function MockSafeAreaView({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function MockAnimatedSplashOverlay() {
  return null;
}

function MockAuthLoading() {
  return null;
}

function MockProfileLoadError() {
  return null;
}

function MockAuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function MockGroupProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(),
}));

jest.mock('expo-router', () => ({
  DarkTheme: {},
  DefaultTheme: {},
  Link: MockLink,
  Stack: Object.assign(MockStackBase, {
    Protected: MockStackProtected,
    Screen: MockStackScreen,
  }),
  ThemeProvider: MockThemeProvider,
  useRouter: () => ({ push: mockRouterPush }),
}));

jest.mock('expo-router/unstable-native-tabs', () => ({
  NativeTabs: Object.assign(MockNativeTabsBase, {
    Trigger: Object.assign(MockNativeTabsTriggerBase, {
      Label: MockNativeTabsTriggerLabel,
      Icon: MockNativeTabsTriggerIcon,
    }),
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: MockSafeAreaView,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@/components/animated-icon', () => ({
  AnimatedSplashOverlay: MockAnimatedSplashOverlay,
}));

jest.mock('@/components/auth-loading', () => ({
  AuthLoading: MockAuthLoading,
}));

jest.mock('@/components/profile-load-error', () => ({
  ProfileLoadError: MockProfileLoadError,
}));

jest.mock('@/lib/auth', () => ({
  AuthProvider: MockAuthProvider,
  useSession: () => mockAuthValue,
}));

jest.mock('@/lib/group', () => ({
  GroupProvider: MockGroupProvider,
  useGroups: () => mockGroupValue,
}));

jest.mock('@/lib/pool', () => ({
  useGeneratePool: () => ({
    state: 'idle',
    poolId: null,
    generate: jest.fn(),
    reset: jest.fn(),
  }),
  useHomeDashboard: () => ({
    status: 'ready',
    groups: [],
  }),
  useLatestActivePool: () => ({
    status: 'none',
    poolId: null,
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthValue = {
    status: 'ready',
    session: { user: { id: 'user-1' } },
    signOut: jest.fn(),
  };
  mockGroupValue = {
    status: 'ready',
    groups: [],
    currentGroup: null,
    partner: null,
    retryLoad: jest.fn(),
    leaveGroup: jest.fn(),
  };
});

describe('routing behavior', () => {
  test('signed-out user cannot enter authenticated routes', async () => {
    mockAuthValue = { ...mockAuthValue, status: 'signedOut', session: null };

    const screen = await render(<RootLayout />);

    expect(screen.getByText('stack:sign-in')).toBeTruthy();
    expect(screen.queryByText('stack:(authenticated)')).toBeNull();
  });

  test('signed-in user without display name is routed to profile completion', async () => {
    mockAuthValue = { ...mockAuthValue, status: 'needsDisplayName' };

    const screen = await render(<RootLayout />);

    expect(screen.getByText('stack:choose-name')).toBeTruthy();
    expect(screen.queryByText('stack:(authenticated)')).toBeNull();
    expect(screen.queryByText('stack:sign-in')).toBeNull();
  });

  test('signed-in user with profile can reach account-level routes without a group', async () => {
    const screen = await render(<HomeScreen />);

    expect(screen.getByText('Sign out')).toBeTruthy();
    expect(screen.getByText('Pair up to start swiping')).toBeTruthy();
  });

  test('/ resolves through (tabs), and the removed Explore tab is gone', async () => {
    const screen = await render(<TabsLayout />);

    expect(screen.getByText('tab:index')).toBeTruthy();
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.queryByText('tab:explore')).toBeNull();
    expect(screen.queryByText('Explore')).toBeNull();
  });

  test('/pair is reachable outside the tab navigator', async () => {
    const screen = await render(<AuthenticatedLayout />);

    expect(screen.getByText('stack:(tabs)')).toBeTruthy();
    expect(screen.getByText('stack:pair')).toBeTruthy();
  });

  test('/pool/[poolId]/matches is reachable as a pool-specific detail route', async () => {
    const screen = await render(<AuthenticatedLayout />);

    expect(screen.getByText('stack:pool/[poolId]')).toBeTruthy();
    expect(screen.getByText('stack:pool/[poolId]/matches')).toBeTruthy();
  });

  test('/group/[groupId]/pools is reachable as the full group pool history route', async () => {
    const screen = await render(<AuthenticatedLayout />);

    expect(screen.getByText('stack:group/[groupId]/pools')).toBeTruthy();
  });

  test('group-required surfaces show pairing state rather than crashing when no group exists', async () => {
    const screen = await render(
      <GroupRequired>
        <></>
      </GroupRequired>
    );

    expect(screen.getByText('Pair up to start swiping')).toBeTruthy();
    expect(screen.getByText('Get started')).toBeTruthy();
  });
});
