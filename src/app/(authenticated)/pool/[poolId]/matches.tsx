import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { loadPoolMatches, type PoolMatch } from '@/lib/match';

const ERROR_MESSAGE = 'Something went wrong. Try again.';

/**
 * This group's matches for one pool. Read-only history: a match records only
 * that the group agreed on a title, and nothing here shows who liked what, or
 * offers watched/completion controls -- those are later slices.
 *
 * `poolId` is normalized exactly like the pool screen, and a missing/empty one
 * gets the same "Pool not found" fallback rather than ever calling the
 * boundary with nothing to scope it to.
 */
export default function MatchesScreen() {
  const { poolId } = useLocalSearchParams<{ poolId?: string | string[] }>();
  const normalizedPoolId = Array.isArray(poolId) ? poolId[0] : poolId;

  if (!normalizedPoolId) {
    return <InvalidPool />;
  }

  return <MatchesList poolId={normalizedPoolId} />;
}

type MatchesState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; matches: PoolMatch[] };

function MatchesList({ poolId }: { poolId: string }) {
  const [state, setState] = useState<MatchesState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    loadPoolMatches(poolId)
      .then((matches) => {
        if (!cancelled) setState({ phase: 'ready', matches });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [poolId]);

  if (state.phase === 'loading') {
    return (
      <Shell>
        <ThemedText type="small" themeColor="textSecondary">
          Loading matches
        </ThemedText>
      </Shell>
    );
  }

  if (state.phase === 'error') {
    return (
      <Shell>
        <ThemedText type="small" themeColor="textSecondary">
          {ERROR_MESSAGE}
        </ThemedText>
      </Shell>
    );
  }

  if (state.matches.length === 0) {
    return (
      <Shell>
        <ThemedText type="subtitle">No matches yet</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          Keep swiping together to find one.
        </ThemedText>
      </Shell>
    );
  }

  return (
    <Shell scroll>
      {state.matches.map((match) => (
        <MatchRow key={match.media.id} match={match} />
      ))}
    </Shell>
  );
}

function MatchRow({ match }: { match: PoolMatch }) {
  return (
    <ThemedView type="backgroundElement" style={styles.row}>
      {match.media.posterUrl ? (
        <Image
          accessibilityLabel={`Poster for ${match.media.title}`}
          source={{ uri: match.media.posterUrl }}
          style={styles.poster}
        />
      ) : null}

      <ThemedText type="default">{match.media.title}</ThemedText>
    </ThemedView>
  );
}

function InvalidPool() {
  return (
    <Shell>
      <ThemedText type="subtitle">Pool not found</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
        This link looks broken. Head back and start a new pool.
      </ThemedText>
    </Shell>
  );
}

function Shell({ children, scroll = false }: { children?: React.ReactNode; scroll?: boolean }) {
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
  row: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    alignItems: 'center',
  },
  poster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: Spacing.two,
  },
});
