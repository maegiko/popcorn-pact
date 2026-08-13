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
 * becoming one. `pool/[poolId]` is the same idea for the swipe deck: a
 * detail-style push outside the tab bar, not a tab of its own.
 * `pool/[poolId]/matches` is a further push from there, the pool-specific
 * match history rather than a tab or a modal.
 */
export default function AuthenticatedLayout() {
  return (
    <GroupProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pair" options={{ presentation: 'modal' }} />
        <Stack.Screen name="pool/[poolId]" />
        <Stack.Screen name="pool/[poolId]/matches" />
      </Stack>
    </GroupProvider>
  );
}
