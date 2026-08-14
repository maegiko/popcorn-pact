import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GroupRequired } from '@/components/group-required';
import { PoolHistoryCard } from '@/components/pool-history-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/auth';
import { useGeneratePool, useHomeDashboard, type DashboardGroup, type GeneratePoolState } from '@/lib/pool';

const ERROR_MESSAGE = 'Something went wrong. Try again.';

/**
 * The shared watching surface: a multi-group dashboard, one section per group
 * the caller belongs to, each showing its most recent pools. A single group
 * is the free-tier steady state, but nothing here assumes there is only one.
 *
 * Sign out sits deliberately *outside* the gate: account-level actions must
 * work for someone who is not in a group. It lives here only until there is a
 * settings tab to own it, along with subscription, billing and notifications.
 */
export default function HomeScreen() {
  return (
    <ThemedView style={styles.container}>
      <View style={styles.gated}>
        <GroupRequired>
          <Dashboard />
        </GroupRequired>
      </View>

      <AccountActions />
    </ThemedView>
  );
}

function Dashboard() {
  const dashboard = useHomeDashboard();

  if (dashboard.status === 'loading') {
    return (
      <SafeAreaView style={styles.messageArea}>
        <ThemedText type="small" themeColor="textSecondary">
          Loading your groups
        </ThemedText>
      </SafeAreaView>
    );
  }

  if (dashboard.status === 'error') {
    return (
      <SafeAreaView style={styles.messageArea}>
        <ThemedText type="small" themeColor="textSecondary">
          {ERROR_MESSAGE}
        </ThemedText>
      </SafeAreaView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        {dashboard.groups.map((group) => (
          // dashboard.refresh is optional-called: real usage always provides
          // it, but a caller that only mocks {status, groups} (see the Home
          // tests) must not crash a group section that never fires it.
          <GroupSection key={group.id} group={group} onGenerated={() => dashboard.refresh?.()} />
        ))}
      </SafeAreaView>
    </ScrollView>
  );
}

/**
 * generate-pool's status vocabulary, worded for the person tapping the
 * button. 'idle'/'generating'/'created' have no message of their own -- idle
 * and generating are silent, and 'created' needs no message because the new
 * pool simply appears in the list above once the dashboard refreshes.
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
 * One group's section: name/history header, up to three recent pools, and
 * `Make new pool` -- always available, even with active pools already
 * showing, since generating one is never gated on finishing another.
 */
function GroupSection({ group, onGenerated }: { group: DashboardGroup; onGenerated: () => void }) {
  const theme = useTheme();
  const router = useRouter();
  const { state, generate } = useGeneratePool(group.id);
  const busy = state === 'generating';

  async function handleGenerate() {
    await generate();
    onGenerated();
  }

  return (
    <ThemedView style={styles.section}>
      <ThemedView style={styles.sectionHeader}>
        <Pressable
          onPress={() =>
            router.push({ pathname: '/group/[groupId]/pools', params: { groupId: group.id } })
          }
          style={styles.sectionTitleButton}>
          <ThemedText type="subtitle">{group.name}</ThemedText>
        </Pressable>

        <View style={styles.sectionActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Invite ${group.name}`}
            onPress={() =>
              router.push({ pathname: '/pair', params: { groupId: group.id, mode: 'invite' } })
            }
            style={styles.iconButton}>
            <SymbolView
              name={{ ios: 'person.badge.plus', android: 'person_add', web: 'person_add' }}
              size={20}
              tintColor={theme.text}
            />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Group settings for ${group.name}`}
            onPress={() =>
              router.push({ pathname: '/pair', params: { groupId: group.id, mode: 'settings' } })
            }
            style={styles.iconButton}>
            <SymbolView
              name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
              size={20}
              tintColor={theme.text}
            />
          </Pressable>
        </View>
      </ThemedView>

      {group.pools.map((pool) => (
        <PoolHistoryCard key={pool.id} pool={pool} />
      ))}

      <Pressable onPress={handleGenerate} disabled={busy} style={styles.switchButton}>
        <ThemedText type="small" themeColor="textSecondary">
          {busy ? 'Finding titles…' : 'Make new pool'}
        </ThemedText>
      </Pressable>

      {poolMessage(state) && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          {poolMessage(state)}
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
  scrollContent: {
    flexGrow: 1,
  },
  safeArea: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    gap: Spacing.five,
  },
  messageArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
  },
  section: {
    gap: Spacing.three,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitleButton: {
    flexShrink: 1,
  },
  sectionActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  iconButton: {
    width: Spacing.five,
    height: Spacing.five,
    alignItems: 'center',
    justifyContent: 'center',
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
