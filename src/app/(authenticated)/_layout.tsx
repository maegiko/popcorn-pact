import { Stack, useRouter } from 'expo-router';
import { Pressable } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { GroupProvider } from '@/lib/group';

/**
 * The authenticated shell.
 *
 * Group state is provided here rather than at the root so it only loads for a
 * fully onboarded user, and unmounts cleanly on sign-out.
 *
 * The gate on group membership is deliberately *not* here. Account-level
 * surfaces — profile, subscription, billing, settings, notifications, account
 * management — must work for someone who is not in a group, so only the screens
 * that need a partner wrap themselves in <GroupRequired />.
 *
 * The Stack exists so `pair` can be presented over the tabs rather than
 * becoming one. `pool/[poolId]` is the same idea for the swipe deck: a
 * detail-style push outside the tab bar, not a tab of its own.
 * `pool/[poolId]/matches` is a further push from there, the pool-specific
 * match history rather than a tab or a modal. `group/[groupId]/pools` is the
 * same kind of push from Home -- a group's full pool history, one level
 * below the three-pool preview a group section shows there.
 */
export default function AuthenticatedLayout() {
  const theme = useTheme();

  return (
    <GroupProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pair" options={{ presentation: 'modal' }} />

        {/*
          The one route in this stack with a header, and deliberately so. The
          swipe deck is a full-bleed poster, so it is the screen that most needs
          something between it and the device's top chrome. Handing that to the
          native header means the platform measures the notch/Dynamic Island
          inset itself -- this app owns no top offset for the pool route at all,
          on any device. It also puts the Home control in native header chrome
          rather than in app-drawn content, which is where an in-screen version
          of it repeatedly failed to appear on a real iOS client.

          Configured here rather than inside the screen so the header does not
          depend on what the screen renders: it is present for a pool that is
          loading, completed, gated behind <GroupRequired />, or missing its id
          entirely.
        */}
        <Stack.Screen
          name="pool/[poolId]"
          options={{
            headerShown: true,
            // No title: a pool has no name a member would recognise, and its id
            // is an implementation detail. The Home action is the point.
            title: '',
            headerStyle: { backgroundColor: theme.background },
            headerTintColor: theme.text,
            headerRight: () => <PoolHomeAction />,
          }}
        />

        {/*
          Matches keeps the stack's default headerless treatment. It is reached
          from the pool screen and returned from by the platform's own back
          gesture/button, and it draws its own top spacing; adding a header --
          let alone a second Home control one push deeper -- would give it two
          top insets and two ways out of the same screen.
        */}
        <Stack.Screen name="pool/[poolId]/matches" />
        <Stack.Screen name="group/[groupId]/pools" />
      </Stack>
    </GroupProvider>
  );
}

/**
 * The pool header's Home control.
 *
 * `replace`, not `back`: Home is a destination rather than "wherever I came
 * from". A pool opened by deep link has nothing behind it to go back to, and
 * after going Home from a pool, pressing back must not drop the member into
 * the pool they just left.
 *
 * Plain text rather than an icon -- expo-symbols' SymbolView proved invisible
 * on the device this was tested against, and text has no native-module
 * dependency to fail. `headerTintColor` above keeps it legible in both schemes.
 */
function PoolHomeAction() {
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Home"
      hitSlop={Spacing.two}
      onPress={() => router.replace('/')}>
      <ThemedText type="smallBold">Home</ThemedText>
    </Pressable>
  );
}
