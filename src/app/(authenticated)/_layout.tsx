import { Stack } from 'expo-router';

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
 * becoming one.
 */
export default function AuthenticatedLayout() {
  return (
    <GroupProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pair" options={{ presentation: 'modal' }} />
      </Stack>
    </GroupProvider>
  );
}
