import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PoolHistoryCard } from '@/components/pool-history-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { loadGroupPoolHistory, type DashboardPool } from '@/lib/pool';

const ERROR_MESSAGE = 'Something went wrong. Try again.';

/**
 * The full pool history behind one group's Home preview -- every pool, not
 * just the three most recent, active and completed mixed together. `groupId`
 * is normalized exactly like the pool and matches screens, and a missing/
 * empty one gets the same "not found" fallback rather than ever calling the
 * boundary with nothing to scope it to.
 */
export default function GroupPoolsScreen() {
  const { groupId } = useLocalSearchParams<{ groupId?: string | string[] }>();
  const normalizedGroupId = Array.isArray(groupId) ? groupId[0] : groupId;

  if (!normalizedGroupId) {
    return <InvalidGroup />;
  }

  return <PoolHistoryList groupId={normalizedGroupId} />;
}

type ScreenResult =
  | { groupId: string; phase: 'error' }
  | { groupId: string; phase: 'ready'; pools: DashboardPool[] };

function PoolHistoryList({ groupId }: { groupId: string }) {
  const [result, setResult] = useState<ScreenResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadGroupPoolHistory(groupId)
      .then((pools) => {
        if (!cancelled) setResult({ groupId, phase: 'ready', pools });
      })
      .catch(() => {
        if (!cancelled) setResult({ groupId, phase: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [groupId]);

  // Tagged by groupId, the same discipline the matches screen uses: a
  // response for a previous groupId reads as not-yet-loaded rather than
  // being adopted, with no synchronous reset required when groupId changes.
  const current = result && result.groupId === groupId ? result : null;

  if (!current) {
    return (
      <Shell>
        <ThemedText type="small" themeColor="textSecondary">
          Loading pools
        </ThemedText>
      </Shell>
    );
  }

  if (current.phase === 'error') {
    return (
      <Shell>
        <ThemedText type="small" themeColor="textSecondary">
          {ERROR_MESSAGE}
        </ThemedText>
      </Shell>
    );
  }

  if (current.pools.length === 0) {
    return (
      <Shell>
        <ThemedText type="subtitle">No pools yet</ThemedText>
      </Shell>
    );
  }

  return (
    <Shell scroll>
      {current.pools.map((pool) => (
        <PoolHistoryCard key={pool.id} pool={pool} />
      ))}
    </Shell>
  );
}

function InvalidGroup() {
  return (
    <Shell>
      <ThemedText type="subtitle">Group not found</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
        This link looks broken. Head back and try again.
      </ThemedText>
    </Shell>
  );
}

function Shell({ children, scroll = false }: { children?: ReactNode; scroll?: boolean }) {
  const content = scroll ? (
    <ScrollView contentContainerStyle={styles.list}>{children}</ScrollView>
  ) : (
    children
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>{content}</SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    gap: Spacing.three,
  },
  message: {
    textAlign: 'center',
  },
  list: {
    gap: Spacing.three,
  },
});
