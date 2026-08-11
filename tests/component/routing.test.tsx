import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

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

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(),
}));

jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');

  function Stack({ children }: { children: ReactNode }) {
    return <>{children}</>;
  }

  Stack.Protected = ({ guard, children }: { guard: boolean; children: ReactNode }) =>
    guard ? <>{children}</> : null;
  Stack.Screen = ({ name }: { name: string; options?: object }) => (
    <Text>{`stack:${name}`}</Text>
  );

  return {
    DarkTheme: {},
    DefaultTheme: {},
    Link: ({ children }: { children: ReactNode }) => <>{children}</>,
    Stack,
    ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useRouter: () => ({ push: mockRouterPush }),
  };
});

jest.mock('expo-router/unstable-native-tabs', () => {
  const React = require('react');
  const { Text } = require('react-native');

  const Trigger = Object.assign(
    ({ name, children }: { name: string; children: ReactNode }) => (
      <>
        <Text>{`tab:${name}`}</Text>
        {children}
      </>
    ),
    {
      Label: ({ children }: { children: ReactNode }) => <Text>{children}</Text>,
      Icon: () => null,
    }
  );

  const NativeTabs = Object.assign(
    ({ children }: { children: ReactNode }) => {
      return <>{children}</>;
    },
    { Trigger }
  );

  return { NativeTabs };
});

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@/components/animated-icon', () => ({
  AnimatedSplashOverlay: () => null,
}));

jest.mock('@/components/auth-loading', () => ({
  AuthLoading: () => null,
}));

jest.mock('@/components/profile-load-error', () => ({
  ProfileLoadError: () => null,
}));

jest.mock('@/lib/auth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSession: () => mockAuthValue,
}));

jest.mock('@/lib/group', () => ({
  GroupProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useGroups: () => mockGroupValue,
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

  test('/ and /explore still resolve through (tabs)', async () => {
    const screen = await render(<TabsLayout />);

    expect(screen.getByText('tab:index')).toBeTruthy();
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText('tab:explore')).toBeTruthy();
    expect(screen.getByText('Explore')).toBeTruthy();
  });

  test('/pair is reachable outside the tab navigator', async () => {
    const screen = await render(<AuthenticatedLayout />);

    expect(screen.getByText('stack:(tabs)')).toBeTruthy();
    expect(screen.getByText('stack:pair')).toBeTruthy();
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
