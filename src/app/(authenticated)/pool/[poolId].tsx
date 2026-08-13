import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GroupRequired } from '@/components/group-required';
import { SwipeDeck } from '@/components/swipe-deck';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { formatPlannedFor } from '@/lib/format';
import { loadPoolLifecycle, type PoolLifecycle } from '@/lib/pool';

/**
 * Opens an already-existing pool for swiping. This screen owns nothing about
 * the deck itself -- it only resolves `poolId` from the route and hands it to
 * <SwipeDeck />, which is the sole owner of loading, cards and swipe state.
 * The Matches action is the one thing this screen owns directly, deliberately
 * kept outside <SwipeDeck /> -- navigating away from the deck is not swipe
 * business logic.
 *
 * Wrapped in <GroupRequired /> because this is the shared watching experience,
 * matching the same partial gate HomeScreen's swipe surface uses -- the
 * authenticated layout itself only gates on session, not group membership.
 */
export default function PoolScreen() {
  const { poolId } = useLocalSearchParams<{ poolId?: string | string[] }>();
  const normalizedPoolId = Array.isArray(poolId) ? poolId[0] : poolId;

  if (!normalizedPoolId) {
    return <InvalidPool />;
  }

  return (
    <GroupRequired>
      <PoolWithMatches poolId={normalizedPoolId} />
    </GroupRequired>
  );
}

/**
 * Loads the pool's lifecycle alongside the deck itself. The deck is not
 * blocked on this load -- a pool with no lifecycle response yet is treated as
 * active, since <SwipeDeck /> is what actually knows whether there is
 * anything left to swipe. Only a confirmed `completed` status swaps the deck
 * for a read-only winner summary; a stale response from a previous poolId is
 * discarded the same way MatchesList discards one.
 */
type LifecycleResult = { poolId: string; lifecycle: PoolLifecycle | null };

function PoolWithMatches({ poolId }: { poolId: string }) {
  const router = useRouter();
  const [result, setResult] = useState<LifecycleResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadPoolLifecycle(poolId)
      .then((lifecycle) => {
        if (!cancelled) setResult({ poolId, lifecycle });
      })
      .catch(() => {
        // Lifecycle is a summary layered on top of the deck -- a failed load
        // leaves the pool looking active rather than blocking swiping.
      });

    return () => {
      cancelled = true;
    };
  }, [poolId]);

  // Tagged by poolId, the same discipline pool.ts's useGeneratePool and
  // useLatestActivePool use: a response that arrives after the route moved to
  // a different pool reads as not-yet-loaded rather than being adopted, with
  // no synchronous reset required when poolId changes.
  const lifecycle = result && result.poolId === poolId ? result.lifecycle : null;
  const isCompleted = lifecycle?.status === 'completed';

  return (
    <ThemedView style={styles.container}>
      {lifecycle?.plannedFor && (
        <SafeAreaView edges={['top']} style={styles.plannedBar}>
          <ThemedText type="small" themeColor="textSecondary">
            Planned for {formatPlannedFor(lifecycle.plannedFor)}
          </ThemedText>
        </SafeAreaView>
      )}

      {isCompleted ? <CompletedSummary lifecycle={lifecycle} /> : <SwipeDeck poolId={poolId} />}

      <SafeAreaView edges={['bottom']} style={styles.matchesBar}>
        <Pressable
          onPress={() => router.push({ pathname: '/pool/[poolId]/matches', params: { poolId } })}>
          <ThemedText type="small" themeColor="textSecondary">
            Matches
          </ThemedText>
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

function CompletedSummary({ lifecycle }: { lifecycle: PoolLifecycle }) {
  return (
    <ThemedView style={styles.completedContainer}>
      <ThemedText type="subtitle">Pool completed</ThemedText>
      {lifecycle.winner && (
        <ThemedText type="default" themeColor="textSecondary">
          {lifecycle.winner.title}
        </ThemedText>
      )}
    </ThemedView>
  );
}

function InvalidPool() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle">Pool not found</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          This link looks broken. Head back and start a new pool.
        </ThemedText>
      </SafeAreaView>
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
    gap: Spacing.three,
  },
  message: {
    textAlign: 'center',
  },
  matchesBar: {
    paddingBottom: BottomTabInset + Spacing.three,
    paddingTop: Spacing.two,
    alignItems: 'center',
  },
  plannedBar: {
    paddingTop: Spacing.two,
    alignItems: 'center',
  },
  completedContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
});
