import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

/**
 * The web-only tab shell (Metro resolves this over app-tabs.tsx on web
 * builds). Imported by its literal `.web` filename below so Jest resolves
 * this exact file rather than the native one.
 *
 * expo-router/ui's Tabs/TabList/TabTrigger/TabSlot are mocked as thin
 * pass-throughs -- this suite is not re-testing the library's own tab/
 * navigation behavior, only that this file's own JSX declares the tab
 * Popcorn Pact actually has (Home, not the removed Explore) and still renders
 * the routed tab content. The overlap bug this file fixed was a real-layout
 * (flex/position) concern Jest's tree has no layout engine to verify, so
 * that is deliberately not pixel-tested here.
 */
jest.mock('expo-router/ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    Tabs: ({ children }: { children: ReactNode }) => <>{children}</>,
    TabList: ({ children }: { children: ReactNode }) => <>{children}</>,
    TabTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    TabSlot: () => <View testID="tab-slot" />,
  };
});

// eslint-disable-next-line import/no-unresolved
import AppTabs from '@/components/app-tabs.web';

describe('web tab shell', () => {
  test('declares only the Home tab, not the removed Explore tab', async () => {
    const screen = await render(<AppTabs />);

    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.queryByText('Explore')).toBeNull();
  });

  test('renders the routed tab content alongside the tab list', async () => {
    const screen = await render(<AppTabs />);

    expect(screen.getByTestId('tab-slot')).toBeTruthy();
  });
});
