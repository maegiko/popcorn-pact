import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GroupRequired } from '@/components/group-required';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/auth';
import { useGroups } from '@/lib/group';

/**
 * The shared watching surface. The swipe deck lands inside <GroupRequired /> in
 * Phase 4.
 *
 * Sign out sits deliberately *outside* the gate: account-level actions must work
 * for someone who is not in a group. It lives here only until there is a
 * settings tab to own it, along with subscription, billing and notifications.
 */
export default function HomeScreen() {
  return (
    <ThemedView style={styles.container}>
      <View style={styles.gated}>
        <GroupRequired>
          <PairedHome />
        </GroupRequired>
      </View>

      <AccountActions />
    </ThemedView>
  );
}

function PairedHome() {
  const theme = useTheme();
  const router = useRouter();
  const { currentGroup, partner } = useGroups();

  return (
    <SafeAreaView style={styles.safeArea}>
      <ThemedText type="subtitle">
        {partner ? `You and ${partner.displayName ?? 'your partner'}` : 'Waiting for them'}
      </ThemedText>

      <ThemedText type="small" themeColor="textSecondary">
        {partner
          ? 'Your shared pile lands here next.'
          : 'Share your code and you can start swiping together.'}
      </ThemedText>

      {/*
        Unconditional on purpose. /pair owns leaving the group, so hiding this
        once a partner joins would strand the only exit and make pairing with
        the wrong person unrecoverable.
      */}
      <Pressable
        onPress={() => router.push('/pair')}
        style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold">{partner ? 'Group settings' : 'Show invite code'}</ThemedText>
      </Pressable>

      {currentGroup && (
        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="small" themeColor="textSecondary">
            Members
          </ThemedText>
          <ThemedText type="default">
            {currentGroup.memberCount} of {currentGroup.memberLimit}
          </ThemedText>
        </ThemedView>
      )}
    </SafeAreaView>
  );
}

function AccountActions() {
  const { signOut } = useSession();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    await signOut();
    setBusy(false);
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.account}>
      <Pressable onPress={handleSignOut} disabled={busy} style={styles.switchButton}>
        <ThemedText type="small" themeColor="textSecondary">
          {busy ? 'Signing out…' : 'Sign out'}
        </ThemedText>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  gated: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  account: {
    paddingBottom: BottomTabInset + Spacing.three,
    alignItems: 'center',
  },
  switchButton: {
    alignItems: 'center',
  },
});
