import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { confirmMatch } from '@/lib/match';
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

/**
 * The match moment's own lifecycle, independent of the deck above it.
 * `shown` covers both the freshly-created moment and a failed confirmation
 * attempt -- the moment stays up either way, which is why there is no
 * separate error phase. `finalized` replaces the moment (and the deck's own
 * card) with the winner state once this user's confirmation completed the
 * group's agreement.
 */
type MatchState =
  | { phase: 'none' }
  | { phase: 'shown'; media: MediaRecord; pending: boolean }
  | { phase: 'finalized'; media: MediaRecord };

export function SwipeDeck({ poolId }: { poolId: string }) {
  const [deck, setDeck] = useState<DeckState>({ phase: 'loading' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The media id of the pass a member could still take back -- mirrors the
  // backend's `undoable` flag, which moves to whichever pass was made most
  // recently and is cleared by any further decision.
  const [undoableId, setUndoableId] = useState<string | null>(null);
  // A dismissible moment layered over the (already-advanced) deck, never a
  // detour from it -- matching is independent of the pool's own lifecycle.
  // `media` is captured from the exact card that matched, not derived from
  // deck.queue[0], so the moment keeps its identity after the deck advances.
  const [matchState, setMatchState] = useState<MatchState>({ phase: 'none' });

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
        setMatchState({ phase: 'none' });
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
    // Cleared up front, not just on dismissal: a match moment belongs to the
    // decision that earned it, and starting a new one -- whatever it turns
    // out to be -- must not leave a stale banner from the last card behind.
    setMatchState({ phase: 'none' });

    try {
      const result = await recordSwipe(poolId, current.id, decision);

      if (result.status === 'recorded' || result.status === 'already_recorded') {
        setDeck((previous) =>
          previous.phase === 'ready' ? { ...previous, queue: previous.queue.slice(1) } : previous
        );
        setUndoableId(decision === 'pass' ? current.id : null);
        // Only a brand-new recorded like can complete the group's agreement --
        // a duplicate has nothing new to complete, and a pass never matches.
        // `current` -- not deck.queue[0] -- is what the moment tracks, since
        // the deck above has already advanced past it by the time this runs.
        if (decision === 'like' && result.status === 'recorded' && result.matchCreated) {
          setMatchState({ phase: 'shown', media: current, pending: false });
        }
      } else {
        setError(ERROR_MESSAGE);
      }
    } catch {
      setError(ERROR_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  function handleDismissMatch() {
    if (matchState.phase !== 'shown' || matchState.pending) return;
    setMatchState({ phase: 'none' });
  }

  /**
   * Confirms the exact matched title the moment was shown for -- never
   * whatever the deck currently has queued. finalized=true is the only
   * outcome that replaces the moment with the winner state; every other
   * successful outcome (confirmed or the idempotent already_confirmed) just
   * dismisses the moment and leaves the deck exactly as it was.
   */
  async function handleConfirm() {
    if (matchState.phase !== 'shown' || matchState.pending) return;
    const media = matchState.media;

    setMatchState({ phase: 'shown', media, pending: true });
    setError(null);

    try {
      const result = await confirmMatch(poolId, media.id);

      if (result.status === 'confirmed' || result.status === 'already_confirmed') {
        if (result.finalized) {
          // The winner is looked up by the backend's own media id rather than
          // assumed to be `media` -- it always will be for this call, but the
          // lookup is what keeps that a fact about confirm_match rather than
          // something this component invents.
          const winnerId = result.mediaId ?? media.id;
          const winner = (deck.phase === 'ready' ? deck.byId.get(winnerId) : undefined) ?? media;
          setMatchState({ phase: 'finalized', media: winner });
        } else {
          setMatchState({ phase: 'none' });
        }
      } else {
        setError(ERROR_MESSAGE);
        setMatchState({ phase: 'shown', media, pending: false });
      }
    } catch {
      setError(ERROR_MESSAGE);
      setMatchState({ phase: 'shown', media, pending: false });
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
      {matchState.phase === 'finalized' ? (
        <MatchFinalized media={matchState.media} />
      ) : current ? (
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

      {matchState.phase === 'shown' && (
        <MatchMoment
          pending={matchState.pending}
          onConfirm={handleConfirm}
          onDismiss={handleDismissMatch}
        />
      )}
    </Shell>
  );
}

/**
 * A lightweight, dismissible layer over the deck -- not a replacement for it.
 * The deck has already advanced by the time this shows. "I want to watch
 * this!" is the primary CTA (a personal, non-finalizing commitment toward
 * the group's unanimity); "Keep swiping" only dismisses the moment and never
 * calls confirmMatch.
 */
function MatchMoment({
  pending,
  onConfirm,
  onDismiss,
}: {
  pending: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const theme = useTheme();

  return (
    <ThemedView type="backgroundElement" style={styles.matchMoment}>
      <ThemedText type="smallBold">It&apos;s a match!</ThemedText>

      <Pressable
        accessibilityRole="button"
        onPress={onConfirm}
        disabled={pending}
        style={[
          styles.matchConfirmButton,
          { backgroundColor: theme.backgroundSelected, opacity: pending ? 0.5 : 1 },
        ]}>
        <ThemedText type="smallBold">I want to watch this!</ThemedText>
      </Pressable>

      <Pressable onPress={onDismiss} disabled={pending} style={styles.matchDismissButton}>
        <ThemedText type="small" themeColor="textSecondary">
          Keep swiping
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

/**
 * Replaces the deck entirely -- no Pass/Like, no next card -- once this
 * user's confirmation completed the group's unanimity. Not a push
 * notification, just an immediate in-app acknowledgement that the pool is
 * settled.
 */
function MatchFinalized({ media }: { media: MediaRecord }) {
  return (
    <ThemedView type="backgroundElement" style={styles.matchMoment}>
      <ThemedText type="smallBold">It&apos;s final -- everyone confirmed!</ThemedText>
      <ThemedText type="subtitle">{media.title}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        This pool is settled. Enjoy the movie.
      </ThemedText>
    </ThemedView>
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
      {/*
        No 'top' edge: this deck always renders below the pool route's native
        Stack header, which the platform has already placed clear of the
        notch/Dynamic Island. Claiming the top inset again here would reserve
        that space a second time and push the poster down by a gap the header
        already accounted for. Bottom/left/right stay, for the Pass/Like/Undo
        controls near the device's own edges.
      */}
      <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.safeArea}>
        {children}
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
  matchMoment: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    alignItems: 'center',
  },
  matchConfirmButton: {
    width: '100%',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
  },
  matchDismissButton: {
    alignItems: 'center',
  },
});
