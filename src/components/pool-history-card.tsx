import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatPlannedFor } from '@/lib/format';
import type { DashboardPool } from '@/lib/pool';

/**
 * One pool's card, shared by Home's recent-pools preview and the full group
 * history screen -- the same lifecycle facts render the same way wherever a
 * pool is listed. Active and completed are mutually exclusive states, not a
 * per-screen design choice: an active pool has no winner to show yet, and a
 * completed one has nothing left to swipe.
 *
 * The whole card opens the pool; the id label lets a pool be found/targeted
 * before it has anything more identifying to show (an active pool has no
 * title yet, only whoever's swiping knows what's in it).
 */
export function PoolHistoryCard({ pool }: { pool: DashboardPool }) {
  const theme = useTheme();
  const router = useRouter();

  function openPool() {
    router.push({ pathname: '/pool/[poolId]', params: { poolId: pool.id } });
  }

  const winner = pool.status === 'completed' ? pool.winner : null;

  return (
    <Pressable onPress={openPool} style={styles.card}>
      <ThemedView type="backgroundElement" style={styles.cardInner}>
        <ThemedText type="small" themeColor="textSecondary">
          {pool.id}
        </ThemedText>

        {winner ? (
          <>
            {winner.posterUrl ? (
              <Image
                accessibilityLabel={`Poster for ${winner.title}`}
                source={{ uri: winner.posterUrl }}
                style={styles.poster}
              />
            ) : null}

            <ThemedText type="default">{winner.title}</ThemedText>

            {winner.overview ? (
              <ThemedText type="small" themeColor="textSecondary">
                {winner.overview}
              </ThemedText>
            ) : null}
          </>
        ) : (
          <Pressable
            onPress={openPool}
            style={[styles.continueButton, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type="smallBold">Continue swiping</ThemedText>
          </Pressable>
        )}

        {pool.plannedFor && (
          <ThemedText type="small" themeColor="textSecondary">
            {formatPlannedFor(pool.plannedFor)}
          </ThemedText>
        )}
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
  },
  cardInner: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  poster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: Spacing.two,
  },
  continueButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
});
