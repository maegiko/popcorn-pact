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
import { useGeneratePool, type GeneratePoolState } from '@/lib/pool';

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
          ? 'Find something to watch together.'
          : 'Share your code, or start a pool while you wait.'}
      </ThemedText>

      {currentGroup && <PoolSection groupId={currentGroup.id} />}

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

/**
 * generate-pool's status vocabulary, worded for the person tapping the button.
 * 'idle'/'generating'/'created' have no message of their own here -- idle and
 * generating are silent, and 'created' gets its own success view instead.
 */
function poolMessage(state: GeneratePoolState): string | null {
  switch (state) {
    case 'idle':
    case 'generating':
    case 'created':
      return null;
    case 'not_a_member':
      return "You're no longer in this group.";
    case 'group_in_grace':
      return 'This group is paused until its owner upgrades.';
    case 'no_candidates':
      return "We couldn't find anything to show right now. Try again in a bit.";
    case 'filter_unsupported':
      return "We can't narrow by your streaming services right now. Try a pool from anywhere.";
    case 'upstream_unavailable':
      return "We couldn't reach the movie database. Try again.";
    case 'error':
      return 'Something went wrong. Try again.';
  }
}

/**
 * Quick Start requests a generated pool immediately; Fine Tune is a named entry
 * point for filters the product does not have yet (runtime, genre, mood), so it
 * surfaces a "coming soon" message rather than inventing settings.
 *
 * `useGeneratePool` is keyed on `groupId`, so if the group changes underneath
 * this screen (leaving, switching), any in-flight request for the old group is
 * dropped rather than landing here.
 */
function PoolSection({ groupId }: { groupId: string }) {
  const theme = useTheme();
  const router = useRouter();
  const { state, poolId, generate, reset } = useGeneratePool(groupId);
  const [fineTuneMessage, setFineTuneMessage] = useState<string | null>(null);
  const busy = state === 'generating';

  if (state === 'created') {
    return (
      <ThemedView type="backgroundElement" style={styles.poolCard}>
        <ThemedText type="smallBold">Your pool is ready</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          Swipe through it together to find something to watch.
        </ThemedText>

        {poolId && (
          <Pressable
            onPress={() => router.push({ pathname: '/pool/[poolId]', params: { poolId } })}
            style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type="smallBold">Start swiping</ThemedText>
          </Pressable>
        )}

        <Pressable onPress={reset} style={styles.switchButton}>
          <ThemedText type="small" themeColor="textSecondary">
            Make a new pool
          </ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  const message = poolMessage(state) ?? fineTuneMessage;

  return (
    <ThemedView type="backgroundElement" style={styles.poolCard}>
      <Pressable
        onPress={() => {
          setFineTuneMessage(null);
          generate();
        }}
        disabled={busy}
        style={[
          styles.button,
          { backgroundColor: theme.backgroundSelected, opacity: busy ? 0.5 : 1 },
        ]}>
        <ThemedText type="smallBold">{busy ? 'Finding titles…' : 'Quick Start'}</ThemedText>
      </Pressable>

      <Pressable
        onPress={() => setFineTuneMessage('Fine-tuning options are coming soon.')}
        disabled={busy}
        style={styles.switchButton}>
        <ThemedText type="small" themeColor="textSecondary">
          Fine Tune
        </ThemedText>
      </Pressable>

      {message && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          {message}
        </ThemedText>
      )}
    </ThemedView>
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
  poolCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
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
  message: {
    textAlign: 'center',
  },
});
