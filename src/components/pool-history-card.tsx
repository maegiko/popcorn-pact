import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatPlannedFor } from '@/lib/format';
import type { DashboardMediaWinner, DashboardPool } from '@/lib/pool';

/** Thumbnail scale, not detail-screen scale: several cards must fit in one dashboard list. */
const POSTER_WIDTH = 72;

/** "Movie • 2018" / "TV • 2024" -- media type alone when there is no year to show, never a fake one. */
function metaLine(winner: DashboardMediaWinner): string {
  const mediaTypeLabel = winner.mediaType === 'tv' ? 'TV' : 'Movie';
  return winner.releaseYear ? `${mediaTypeLabel} • ${winner.releaseYear}` : mediaTypeLabel;
}

/**
 * One pool's card, shared by Home's recent-pools preview and the full group
 * history screen -- the same lifecycle facts render the same way wherever a
 * pool is listed. Active and completed are mutually exclusive states, not a
 * per-screen design choice: an active pool has no winner to show yet, and a
 * completed one has nothing left to swipe.
 *
 * The whole card opens the pool. Neither variant shows the pool's own id --
 * an active pool has nothing else identifying yet either, so it stays down
 * to planned time and the way back into the deck rather than a raw UUID.
 * `testID` is what tests target a specific card by, not visible text.
 */
export function PoolHistoryCard({ pool }: { pool: DashboardPool }) {
  const router = useRouter();

  function openPool() {
    router.push({ pathname: '/pool/[poolId]', params: { poolId: pool.id } });
  }

  const winner = pool.status === 'completed' ? pool.winner : null;

  return (
    <Pressable testID={`pool-card-${pool.id}`} onPress={openPool} style={styles.card}>
      <ThemedView type="backgroundElement" style={styles.cardInner}>
        {winner ? (
          <CompletedContent winner={winner} plannedFor={pool.plannedFor} />
        ) : (
          <ActiveContent plannedFor={pool.plannedFor} onContinue={openPool} />
        )}
      </ThemedView>
    </Pressable>
  );
}

function CompletedContent({
  winner,
  plannedFor,
}: {
  winner: DashboardMediaWinner;
  plannedFor: string | null;
}) {
  return (
    <View style={styles.completedRow}>
      {winner.posterUrl ? (
        <Image
          accessibilityLabel={`Poster for ${winner.title}`}
          source={{ uri: winner.posterUrl }}
          style={styles.poster}
        />
      ) : null}

      <View style={styles.completedText}>
        <ThemedText type="default" style={styles.title} numberOfLines={2}>
          {winner.title}
        </ThemedText>

        <ThemedText type="small" themeColor="textSecondary">
          {metaLine(winner)}
        </ThemedText>

        {winner.overview ? (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={3}>
            {winner.overview}
          </ThemedText>
        ) : null}

        {plannedFor && (
          <ThemedText type="small" themeColor="textSecondary">
            {formatPlannedFor(plannedFor)}
          </ThemedText>
        )}
      </View>
    </View>
  );
}

function ActiveContent({
  plannedFor,
  onContinue,
}: {
  plannedFor: string | null;
  onContinue: () => void;
}) {
  const theme = useTheme();

  return (
    <>
      {plannedFor && (
        <ThemedText type="small" themeColor="textSecondary">
          {formatPlannedFor(plannedFor)}
        </ThemedText>
      )}

      <Pressable
        onPress={onContinue}
        style={[styles.continueButton, { backgroundColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold">Continue swiping</ThemedText>
      </Pressable>
    </>
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
  completedRow: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  poster: {
    width: POSTER_WIDTH,
    aspectRatio: 2 / 3,
    borderRadius: Spacing.two,
  },
  completedText: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.half,
  },
  title: {
    fontWeight: '700',
  },
  continueButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
});
