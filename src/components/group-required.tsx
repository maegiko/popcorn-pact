import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AuthLoading } from '@/components/auth-loading';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useGroups } from '@/lib/group';

/**
 * Gates a surface that needs a group behind one.
 *
 * Wrap only the shared watching experience — swiping, matches — with this.
 * Account-level surfaces must stay reachable without a group, so they simply do
 * not use it. That is what keeps the group gate partial rather than global.
 *
 * The gate reads `currentGroup` and its access state rather than a status enum,
 * so a future group switcher needs no change here.
 */
export function GroupRequired({ children }: { children: ReactNode }) {
  const { status, currentGroup } = useGroups();

  if (status === 'loading') return <AuthLoading />;
  if (status === 'error') return <GroupLoadError />;
  if (!currentGroup) return <NoGroup />;
  if (currentGroup.accessState === 'grace') return <GroupInGrace />;

  return <>{children}</>;
}

export function GroupLoadError() {
  const theme = useTheme();
  const { retryLoad } = useGroups();

  return (
    <Shell>
      <ThemedText type="subtitle">Something went wrong</ThemedText>

      <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
        We couldn&apos;t load your group. Check your connection and try again.
      </ThemedText>

      <Pressable
        onPress={retryLoad}
        style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold">Try again</ThemedText>
      </Pressable>
    </Shell>
  );
}

function NoGroup() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Shell>
      <ThemedText type="subtitle">Pair up to start swiping</ThemedText>

      <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
        Popcorn Pact finds something you both want to watch. Invite someone, or
        enter the code they sent you.
      </ThemedText>

      <Pressable
        onPress={() => router.push('/pair')}
        style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold">Get started</ThemedText>
      </Pressable>
    </Shell>
  );
}

/**
 * The group holds more members than its owner's plan allows. Reachable only
 * once premium exists — today every limit is the free-tier one — but the branch
 * is written now because it is where the Phase 6 paywall attaches.
 *
 * Both roles get a way forward: the owner can upgrade, and anyone else can
 * leave. Neither is a dead end.
 */
function GroupInGrace() {
  const theme = useTheme();
  const router = useRouter();
  const { currentGroup, partner, leaveGroup } = useGroups();
  const [busy, setBusy] = useState(false);

  if (!currentGroup) return null;

  const ownerName = currentGroup.isOwner
    ? null
    : (currentGroup.members.find((member) => member.userId === currentGroup.ownerId)?.displayName ??
      partner?.displayName ??
      'the group owner');

  async function handleLeave() {
    if (!currentGroup) return;
    setBusy(true);
    await leaveGroup(currentGroup.id);
    setBusy(false);
  }

  return (
    <Shell>
      <ThemedText type="subtitle">This group is paused</ThemedText>

      <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
        {currentGroup.isOwner
          ? `Your group has ${currentGroup.memberCount} members, and your plan covers ${currentGroup.memberLimit}. Upgrade to keep watching together.`
          : `This group has ${currentGroup.memberCount} members, and ${ownerName}'s plan covers ${currentGroup.memberLimit}. Ask them to upgrade to keep watching together.`}
      </ThemedText>

      {currentGroup.isOwner ? (
        <Pressable
          onPress={() => router.push('/pair')}
          style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText type="smallBold">See options</ThemedText>
        </Pressable>
      ) : (
        <Pressable onPress={handleLeave} disabled={busy} style={styles.switchButton}>
          <ThemedText type="small" themeColor="textSecondary">
            {busy ? 'Leaving…' : 'Leave group'}
          </ThemedText>
        </Pressable>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>{children}</SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.three,
    gap: Spacing.three,
  },
  message: {
    textAlign: 'center',
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  switchButton: {
    alignItems: 'center',
  },
});
