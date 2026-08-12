import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { loadPoolDeck, recordSwipe, undoLastPass, type MediaRecord } from '@/lib/swipe';
import { resolveSwipeGesture, SWIPE_DECISION_THRESHOLD } from '@/lib/swipe-gesture';

export { resolveSwipeGesture, SWIPE_DECISION_THRESHOLD };

const ERROR_MESSAGE = 'Something went wrong. Try again.';

/**
 * Local deck state, reconstructed from the server on every mount rather than
 * carried across remounts. `queue` holds only unresolved titles, in the order
 * a card should be offered; `byId` keeps the full loaded set so a media row
 * undo returns can be looked back up without a second round trip.
 */
type DeckState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; queue: MediaRecord[]; byId: Map<string, MediaRecord> };

export function SwipeDeck({ poolId }: { poolId: string }) {
  const [deck, setDeck] = useState<DeckState>({ phase: 'loading' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The media id of the pass a member could still take back -- mirrors the
  // backend's `undoable` flag, which moves to whichever pass was made most
  // recently and is cleared by any further decision.
  const [undoableId, setUndoableId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadPoolDeck(poolId)
      .then((pool) => {
        if (cancelled) return;

        const poolSwipes = pool.swipes.filter((swipe) => swipe.poolId === poolId);
        const resolved = new Set(poolSwipes.map((swipe) => swipe.mediaId));
        const queue = pool.media.filter((item) => !resolved.has(item.id));
        const byId = new Map(pool.media.map((item) => [item.id, item]));
        // Undo eligibility is backend truth, not local-only state: a pass made
        // in an earlier session is still undoable here if the server says so.
        const persistedUndoable = poolSwipes.find((swipe) => swipe.undoable)?.mediaId ?? null;

        setDeck({ phase: 'ready', queue, byId });
        setError(null);
        setUndoableId(persistedUndoable);
      })
      .catch(() => {
        if (!cancelled) setDeck({ phase: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [poolId]);

  async function handleDecision(decision: 'like' | 'pass') {
    if (deck.phase !== 'ready' || pending) return;
    const current = deck.queue[0];
    if (!current) return;

    setPending(true);
    setError(null);

    try {
      const result = await recordSwipe(poolId, current.id, decision);

      if (result.status === 'recorded' || result.status === 'already_recorded') {
        setDeck((previous) =>
          previous.phase === 'ready' ? { ...previous, queue: previous.queue.slice(1) } : previous
        );
        setUndoableId(decision === 'pass' ? current.id : null);
      } else {
        setError(ERROR_MESSAGE);
      }
    } catch {
      setError(ERROR_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  async function handleUndo() {
    if (!undoableId || pending) return;

    setPending(true);
    setError(null);

    try {
      const result = await undoLastPass(poolId);

      if (result.status === 'undone' && result.mediaId) {
        const mediaId = result.mediaId;
        setDeck((previous) => {
          if (previous.phase !== 'ready') return previous;
          const media = previous.byId.get(mediaId);
          if (!media) return previous;
          return { ...previous, queue: [media, ...previous.queue] };
        });
        setUndoableId(null);
      } else {
        setError(ERROR_MESSAGE);
      }
    } catch {
      setError(ERROR_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  if (deck.phase === 'error') {
    return (
      <Shell>
        <ThemedText type="small" themeColor="textSecondary">
          {ERROR_MESSAGE}
        </ThemedText>
      </Shell>
    );
  }

  if (deck.phase === 'loading') {
    return <Shell />;
  }

  const current = deck.queue[0] ?? null;

  return (
    <Shell>
      {current ? (
        <Card
          media={current}
          pending={pending}
          error={error}
          showUndo={undoableId !== null}
          onPass={() => handleDecision('pass')}
          onLike={() => handleDecision('like')}
          onUndo={handleUndo}
        />
      ) : (
        <ThemedText type="subtitle">You&apos;re done with this pool.</ThemedText>
      )}
    </Shell>
  );
}

function Card({
  media,
  pending,
  error,
  showUndo,
  onPass,
  onLike,
  onUndo,
}: {
  media: MediaRecord;
  pending: boolean;
  error: string | null;
  showUndo: boolean;
  onPass: () => void;
  onLike: () => void;
  onUndo: () => void;
}) {
  const theme = useTheme();
  const translateX = useSharedValue(0);

  // Left = pass, right = like -- the same decision the buttons make, reached
  // through resolveSwipeGesture() instead of a tap. A small activeOffsetX
  // deadzone keeps this from competing with the Pass/Like/Undo Pressables.
  const pan = Gesture.Pan()
    .withTestId('swipe-card-gesture')
    .enabled(!pending)
    .activeOffsetX([-10, 10])
    .onUpdate((event) => {
      translateX.value = event.translationX;
    })
    .onEnd((event) => {
      const decision = resolveSwipeGesture(event.translationX);
      translateX.value = withSpring(0);
      if (decision === 'pass') runOnJS(onPass)();
      if (decision === 'like') runOnJS(onLike)();
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { rotate: `${translateX.value / 20}deg` }],
  }));

  return (
    <ThemedView style={styles.card}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.cardInner, cardStyle]}>
          {media.posterUrl ? (
            <Image
              accessibilityLabel={`Poster for ${media.title}`}
              source={{ uri: media.posterUrl }}
              style={styles.poster}
            />
          ) : null}

          <ThemedText type="subtitle">{media.title}</ThemedText>
        </Animated.View>
      </GestureDetector>

      {error ? (
        <ThemedText type="small" themeColor="textSecondary">
          {error}
        </ThemedText>
      ) : null}

      <ThemedView style={styles.actions}>
        <Pressable
          onPress={onPass}
          disabled={pending}
          style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="smallBold">Pass</ThemedText>
        </Pressable>

        <Pressable
          onPress={onLike}
          disabled={pending}
          style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText type="smallBold">Like</ThemedText>
        </Pressable>
      </ThemedView>

      {showUndo ? (
        <Pressable onPress={onUndo} disabled={pending}>
          <ThemedText type="small" themeColor="textSecondary">
            Undo
          </ThemedText>
        </Pressable>
      ) : null}
    </ThemedView>
  );
}

function Shell({ children }: { children?: React.ReactNode }) {
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
  card: {
    gap: Spacing.three,
    alignItems: 'center',
  },
  cardInner: {
    width: '100%',
    alignItems: 'center',
    gap: Spacing.three,
  },
  poster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: Spacing.two,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  button: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
});
