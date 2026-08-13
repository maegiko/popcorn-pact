import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PlannedTimePicker } from '@/components/planned-time-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/auth';
import { defaultPlannedTime, formatPlannedFor } from '@/lib/format';
import { loadPoolMatches, type PoolMatch } from '@/lib/match';
import {
  finalizePool,
  finalizePoolRandom,
  loadPoolLifecycle,
  setPoolPlannedFor,
  type FinalizePoolStatus,
  type PoolLifecycle,
} from '@/lib/pool';

const ERROR_MESSAGE = 'Something went wrong. Try again.';

/**
 * This group's matches for one pool, plus the pool's lifecycle: planned watch
 * time (visible to every member, editable only by the pool's owner) and, for
 * an active pool with at least one match, the owner's finalization controls.
 * A match still records only that the group agreed on a title -- nothing here
 * shows who liked what, and watched-state controls are a later slice.
 *
 * `poolId` is normalized exactly like the pool screen, and a missing/empty one
 * gets the same "Pool not found" fallback rather than ever calling either
 * boundary with nothing to scope it to.
 */
export default function MatchesScreen() {
  const { poolId } = useLocalSearchParams<{ poolId?: string | string[] }>();
  const normalizedPoolId = Array.isArray(poolId) ? poolId[0] : poolId;
  const { session } = useSession();

  if (!normalizedPoolId) {
    return <InvalidPool />;
  }

  return <MatchesList poolId={normalizedPoolId} userId={session?.user.id ?? null} />;
}

type ScreenResult =
  | { poolId: string; phase: 'error' }
  | { poolId: string; phase: 'ready'; matches: PoolMatch[]; lifecycle: PoolLifecycle | null };

function MatchesList({ poolId, userId }: { poolId: string; userId: string | null }) {
  const [result, setResult] = useState<ScreenResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([loadPoolMatches(poolId), loadPoolLifecycle(poolId)])
      .then(([matches, lifecycle]) => {
        if (!cancelled) setResult({ poolId, phase: 'ready', matches, lifecycle });
      })
      .catch(() => {
        if (!cancelled) setResult({ poolId, phase: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [poolId]);

  // Tagged by poolId, the same discipline the pool screen uses: a response
  // for a previous poolId reads as not-yet-loaded rather than being adopted,
  // with no synchronous reset required when poolId changes.
  const current = result && result.poolId === poolId ? result : null;

  if (!current) {
    return (
      <Shell>
        <ThemedText type="small" themeColor="textSecondary">
          Loading matches
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

  const { matches, lifecycle } = current;

  function updateLifecycle(next: PoolLifecycle) {
    setResult((prev) => (prev && prev.phase === 'ready' ? { ...prev, lifecycle: next } : prev));
  }

  return (
    <Shell scroll>
      <PoolLifecyclePanel
        poolId={poolId}
        userId={userId}
        lifecycle={lifecycle}
        matches={matches}
        onLifecycleChange={updateLifecycle}
      />

      {matches.length === 0 ? (
        <>
          <ThemedText type="subtitle">No matches yet</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
            Keep swiping together to find one.
          </ThemedText>
        </>
      ) : (
        matches.map((match) => (
          <MatchRow
            key={match.media.id}
            match={match}
            isWinner={lifecycle?.status === 'completed' && lifecycle.winnerMediaId === match.media.id}
          />
        ))
      )}
    </Shell>
  );
}

function PoolLifecyclePanel({
  poolId,
  userId,
  lifecycle,
  matches,
  onLifecycleChange,
}: {
  poolId: string;
  userId: string | null;
  lifecycle: PoolLifecycle | null;
  matches: PoolMatch[];
  onLifecycleChange: (next: PoolLifecycle) => void;
}) {
  const isOwner = userId !== null && lifecycle !== null && lifecycle.createdBy === userId;
  const isCompleted = lifecycle?.status === 'completed';

  return (
    <ThemedView style={styles.panel}>
      {isCompleted && (
        <ThemedView type="backgroundElement" style={styles.completedCard}>
          <ThemedText type="subtitle">Pool completed</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            The winning title is marked below.
          </ThemedText>
        </ThemedView>
      )}

      <PlannedTimeControls
        poolId={poolId}
        isOwner={isOwner}
        plannedFor={lifecycle?.plannedFor ?? null}
        onSaved={(plannedFor) => {
          if (lifecycle) onLifecycleChange({ ...lifecycle, plannedFor });
        }}
      />

      {!isCompleted && isOwner && matches.length > 0 && (
        <FinalizeControls
          poolId={poolId}
          matches={matches}
          onFinalized={async () => {
            const refreshed = await loadPoolLifecycle(poolId);
            if (refreshed) onLifecycleChange(refreshed);
          }}
        />
      )}
    </ThemedView>
  );
}

function PlannedTimeControls({
  poolId,
  isOwner,
  plannedFor,
  onSaved,
}: {
  poolId: string;
  isOwner: boolean;
  plannedFor: string | null;
  onSaved: (plannedFor: string | null) => void;
}) {
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Date>(defaultPlannedTime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    setEditing(false);
    setError(null);
  }

  /**
   * Save deliberately leaves the editor open rather than closing it: the
   * owner may want to clear right after saving (see the matches-screen
   * tests), and "Edit planned time" living only in the idle (!editing) view
   * is what keeps it from ever appearing next to "Clear planned time" -- the
   * two would otherwise both match a loose "planned" search at once.
   */
  async function save(nextValue: string | null) {
    setBusy(true);
    setError(null);

    try {
      const result = await setPoolPlannedFor(poolId, nextValue);
      if (result.status === 'updated') {
        onSaved(nextValue);
      } else {
        setError(ERROR_MESSAGE);
      }
    } catch {
      setError(ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ThemedView style={styles.plannedSection}>
      {plannedFor && !editing && (
        <ThemedText type="small" themeColor="textSecondary">
          {isOwner ? formatPlannedFor(plannedFor) : `Planned for ${formatPlannedFor(plannedFor)}`}
        </ThemedText>
      )}

      {isOwner && editing && (
        <>
          <PlannedTimePicker value={draft} onChange={setDraft} />
          <Pressable
            onPress={() => save(draft.toISOString())}
            disabled={busy}
            style={[
              styles.smallButton,
              { backgroundColor: theme.backgroundSelected, opacity: busy ? 0.5 : 1 },
            ]}>
            <ThemedText type="smallBold">Save planned time</ThemedText>
          </Pressable>
          <Pressable onPress={cancel} disabled={busy} style={styles.switchButton}>
            <ThemedText type="small" themeColor="textSecondary">
              Cancel
            </ThemedText>
          </Pressable>
          <Pressable onPress={() => save(null)} disabled={busy} style={styles.switchButton}>
            <ThemedText type="small" themeColor="textSecondary">
              Clear planned time
            </ThemedText>
          </Pressable>
        </>
      )}

      {isOwner && !editing && (
        <Pressable
          onPress={() => {
            setDraft(plannedFor ? new Date(plannedFor) : defaultPlannedTime());
            setEditing(true);
          }}
          disabled={busy}
          style={styles.switchButton}>
          <ThemedText type="small" themeColor="textSecondary">
            {plannedFor ? 'Edit planned time' : 'Add planned time'}
          </ThemedText>
        </Pressable>
      )}

      {error && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          {error}
        </ThemedText>
      )}
    </ThemedView>
  );
}

function FinalizeControls({
  poolId,
  matches,
  onFinalized,
}: {
  poolId: string;
  matches: PoolMatch[];
  onFinalized: () => Promise<void>;
}) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  async function run(action: () => Promise<{ status: FinalizePoolStatus; mediaId: string | null }>) {
    setBusy(true);
    setError(null);

    try {
      const result = await action();
      if (result.status === 'finalized' || result.status === 'already_completed') {
        await onFinalized();
        setManualOpen(false);
      } else {
        setError(ERROR_MESSAGE);
      }
    } catch {
      setError(ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  if (matches.length === 1) {
    const only = matches[0];
    return (
      <ThemedView style={styles.finalizeSection}>
        <Pressable
          onPress={() => run(() => finalizePool(poolId, only.media.id))}
          disabled={busy}
          style={[styles.button, { backgroundColor: theme.backgroundSelected, opacity: busy ? 0.5 : 1 }]}>
          <ThemedText type="smallBold">Finalize match</ThemedText>
        </Pressable>

        {error && (
          <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
            {error}
          </ThemedText>
        )}
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.finalizeSection}>
      <Pressable
        onPress={() => run(() => finalizePoolRandom(poolId))}
        disabled={busy}
        style={[styles.button, { backgroundColor: theme.backgroundSelected, opacity: busy ? 0.5 : 1 }]}>
        <ThemedText type="smallBold">Pick for us</ThemedText>
      </Pressable>

      <Pressable
        onPress={() => setManualOpen((open) => !open)}
        disabled={busy}
        style={styles.switchButton}>
        <ThemedText type="small" themeColor="textSecondary">
          Choose manually
        </ThemedText>
      </Pressable>

      {manualOpen &&
        matches.map((match) => (
          <Pressable
            key={match.media.id}
            onPress={() => run(() => finalizePool(poolId, match.media.id))}
            disabled={busy}
            style={styles.switchButton}>
            <ThemedText type="small" themeColor="textSecondary">
              {`Choose ${match.media.title}`}
            </ThemedText>
          </Pressable>
        ))}

      {error && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          {error}
        </ThemedText>
      )}
    </ThemedView>
  );
}

function MatchRow({ match, isWinner }: { match: PoolMatch; isWinner: boolean }) {
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
      {isWinner && (
        <ThemedText type="small" themeColor="textSecondary">
          Winner
        </ThemedText>
      )}
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
  panel: {
    gap: Spacing.two,
  },
  completedCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    alignItems: 'center',
  },
  plannedSection: {
    gap: Spacing.two,
  },
  finalizeSection: {
    gap: Spacing.two,
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  smallButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  switchButton: {
    alignItems: 'center',
  },
});
