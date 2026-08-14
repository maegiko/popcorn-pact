import { FunctionsHttpError } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';

/**
 * Outcomes the generate-pool Edge Function can report to a correct client.
 * `invalid_request`/`unauthenticated` are faults a correct client never
 * provokes, and a network failure has no status of its own -- both collapse
 * into 'error' here rather than growing the union a client has to handle.
 */
export type GeneratePoolOutcome =
  | 'created'
  | 'not_a_member'
  | 'group_in_grace'
  | 'no_candidates'
  | 'filter_unsupported'
  | 'upstream_unavailable'
  | 'error';

export type GeneratePoolState = 'idle' | 'generating' | GeneratePoolOutcome;

type FunctionBody = { status?: unknown; poolId?: unknown };

const KNOWN_OUTCOMES = new Set<string>([
  'created',
  'not_a_member',
  'group_in_grace',
  'no_candidates',
  // The server cannot narrow by the group's streaming services right now. It
  // deliberately says nothing about which upstream is configured -- the client
  // has no business knowing where titles come from.
  'filter_unsupported',
  'upstream_unavailable',
]);

function parseOutcome(body: FunctionBody | null): {
  outcome: GeneratePoolOutcome;
  poolId: string | null;
} {
  const status = typeof body?.status === 'string' ? body.status : null;
  if (!status || !KNOWN_OUTCOMES.has(status)) return { outcome: 'error', poolId: null };

  const outcome = status as GeneratePoolOutcome;
  const poolId = outcome === 'created' && typeof body?.poolId === 'string' ? body.poolId : null;
  return { outcome, poolId };
}

/**
 * The function client throws for any non-2xx response, and generate-pool
 * serves upstream_unavailable as 503 -- so that outcome's body has to be
 * recovered from the error rather than trusted from `data`.
 */
async function parseHttpErrorBody(error: FunctionsHttpError): Promise<FunctionBody | null> {
  try {
    const response = error.context as Response;
    return (await response.json()) as FunctionBody;
  } catch {
    return null;
  }
}

/**
 * A result tagged with the group it was requested for -- the same discipline
 * auth.tsx and group.tsx use for a switched user/attempt. Deriving `state`
 * below by comparing this tag to the caller's *current* `groupId` is what
 * drops a response that arrives after the group changed: the result object
 * still gets written, but it stops reading as current the moment the prop
 * does not match, with no effect required to notice the change.
 */
type GenerateResult =
  | { groupId: string; phase: 'generating' }
  | { groupId: string; phase: 'done'; outcome: GeneratePoolOutcome; poolId: string | null };

/**
 * Requests a generated pool for `groupId` and tracks the outcome.
 *
 * `busyRef` guards the one race the tagged-result comparison cannot: a second
 * tap firing a duplicate request while one for the same group is already in
 * flight. It is only ever read or written from inside `generate`, never during
 * render, so it never needs to be reconciled against a render in progress.
 */
export function useGeneratePool(groupId: string | null) {
  const [result, setResult] = useState<GenerateResult | null>(null);
  const busyRef = useRef(false);

  const current = result && result.groupId === groupId ? result : null;
  const state: GeneratePoolState = !current
    ? 'idle'
    : current.phase === 'generating'
      ? 'generating'
      : current.outcome;
  const poolId = current?.phase === 'done' && current.outcome === 'created' ? current.poolId : null;

  const generate = useCallback(async () => {
    if (!groupId || busyRef.current) return;

    busyRef.current = true;
    setResult({ groupId, phase: 'generating' });

    let outcome: GeneratePoolOutcome;
    let nextPoolId: string | null;

    try {
      const { data, error } = await supabase.functions.invoke<FunctionBody>('generate-pool', {
        body: { groupId, effectiveProviderIds: null },
      });

      if (error instanceof FunctionsHttpError) {
        ({ outcome, poolId: nextPoolId } = parseOutcome(await parseHttpErrorBody(error)));
      } else if (error) {
        outcome = 'error';
        nextPoolId = null;
      } else {
        ({ outcome, poolId: nextPoolId } = parseOutcome(data));
      }
    } catch {
      outcome = 'error';
      nextPoolId = null;
    }

    busyRef.current = false;
    setResult({ groupId, phase: 'done', outcome, poolId: nextPoolId });
  }, [groupId]);

  const reset = useCallback(() => {
    busyRef.current = false;
    setResult(null);
  }, []);

  return { state, poolId, generate, reset };
}

export type LatestActivePoolStatus = 'loading' | 'found' | 'none' | 'error';

type LatestActivePoolResult =
  | { groupId: string; status: 'found'; poolId: string }
  | { groupId: string; status: 'none' }
  | { groupId: string; status: 'error' };

type LatestActivePoolRow = { id: string };

/**
 * The group-level "resume where you left off" lookup: the newest pool this
 * group has not completed. `status` is a lifecycle property of the pool
 * itself, not of any one member's swipe progress -- a member who finished
 * their own deck does not make the pool any less active. See the pools
 * lifecycle migration, which this mirrors exactly:
 *
 *   where group_id = :group_id and status = 'active'
 *   order by created_at desc
 *   limit 1
 *
 * A direct RLS-backed SELECT rather than an RPC: the read is already scoped to
 * the caller's groups by the existing pools policy, grace preserves it
 * unconditionally, and there is nothing trusted left to compute server-side.
 */
export async function loadLatestActivePool(groupId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('pools')
    .select('id')
    .eq('group_id', groupId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as LatestActivePoolRow | null)?.id ?? null;
}

/**
 * Tracks the current group's latest active pool for Home's recovery state.
 *
 * Tagged by `groupId`, the same discipline `useGeneratePool` above and
 * `group.tsx` use: a lookup that resolves after the group has changed
 * underneath this screen reads as stale rather than being adopted, so
 * switching groups (or leaving one) never surfaces another group's pool.
 */
export function useLatestActivePool(groupId: string | null) {
  const [result, setResult] = useState<LatestActivePoolResult | null>(null);

  useEffect(() => {
    if (!groupId) return;

    let cancelled = false;

    loadLatestActivePool(groupId)
      .then((poolId) => {
        if (cancelled) return;
        setResult(poolId ? { groupId, status: 'found', poolId } : { groupId, status: 'none' });
      })
      .catch(() => {
        if (!cancelled) setResult({ groupId, status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const current = result && result.groupId === groupId ? result : null;
  const status: LatestActivePoolStatus = !current ? 'loading' : current.status;
  const poolId = current?.status === 'found' ? current.poolId : null;

  return { status, poolId };
}

/** RPCs declared `returns table` arrive as an array of one row, same as swipe.ts. */
function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return (data as T | null) ?? null;
}

export type PoolStatus = 'active' | 'completed';

/** Canonical media fields the lifecycle needs to render a winner -- same shape as match.ts's MatchMedia. */
export type PoolWinnerMedia = {
  id: string;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl: string | null;
};

export type PoolLifecycle = {
  poolId: string;
  status: PoolStatus;
  createdBy: string | null;
  plannedFor: string | null;
  winnerMediaId: string | null;
  finalizedAt: string | null;
  winner: PoolWinnerMedia | null;
};

type PoolLifecycleRow = {
  id: string;
  status: PoolStatus;
  created_by: string | null;
  planned_for: string | null;
  winner_media_id: string | null;
  finalized_at: string | null;
};

type WinnerMediaRow = {
  id: string;
  media_type: 'movie' | 'tv';
  title: string | null;
  poster_url: string | null;
};

async function loadWinnerMedia(mediaId: string): Promise<PoolWinnerMedia | null> {
  const { data, error } = await supabase
    .from('media')
    .select('id, media_type, title, poster_url')
    .eq('id', mediaId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const media = data as WinnerMediaRow;
  return {
    id: media.id,
    mediaType: media.media_type,
    title: media.title ?? '',
    posterUrl: media.poster_url,
  };
}

/**
 * Loads one pool's lifecycle: status, ownership, planned watch time and --
 * once completed -- the winning title. A direct RLS-backed read, same
 * discipline as loadLatestActivePool above: the pools policy already scopes
 * this to the caller's groups, so a pool id outside them resolves to null
 * rather than an error.
 */
export async function loadPoolLifecycle(poolId: string): Promise<PoolLifecycle | null> {
  const { data, error } = await supabase
    .from('pools')
    .select('id, status, created_by, planned_for, winner_media_id, finalized_at')
    .eq('id', poolId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as PoolLifecycleRow;
  const winner = row.winner_media_id ? await loadWinnerMedia(row.winner_media_id) : null;

  return {
    poolId: row.id,
    status: row.status,
    createdBy: row.created_by,
    plannedFor: row.planned_for,
    winnerMediaId: row.winner_media_id,
    finalizedAt: row.finalized_at,
    winner,
  };
}

export type PlannedForStatus =
  | 'updated'
  | 'not_creator'
  | 'not_a_member'
  | 'pool_not_found'
  | 'group_in_grace'
  | 'error';

const PLANNED_FOR_STATUSES = new Set<string>([
  'updated',
  'not_creator',
  'not_a_member',
  'pool_not_found',
  'group_in_grace',
]);

/**
 * Sets or clears a pool's planned watch time. `plannedFor` of null clears it.
 * Only the pool's current owner may call this successfully -- see
 * `not_creator` -- and it may be called again after finalization to
 * reschedule without touching the winner.
 */
export async function setPoolPlannedFor(
  poolId: string,
  plannedFor: string | null
): Promise<{ status: PlannedForStatus }> {
  const { data, error } = await supabase.rpc('set_pool_planned_for', {
    p_pool_id: poolId,
    p_planned_for: plannedFor,
  });
  if (error) throw error;

  const row = firstRow<{ status: string }>(data);
  const status = row?.status;
  return { status: status && PLANNED_FOR_STATUSES.has(status) ? (status as PlannedForStatus) : 'error' };
}

export type FinalizePoolStatus =
  | 'finalized'
  | 'already_completed'
  | 'no_matches'
  | 'not_creator'
  | 'not_a_member'
  | 'media_not_matched'
  | 'group_in_grace'
  | 'error';

const FINALIZE_POOL_STATUSES = new Set<string>([
  'finalized',
  'already_completed',
  'no_matches',
  'not_creator',
  'not_a_member',
  'media_not_matched',
  'group_in_grace',
]);

function toFinalizeResult(data: unknown): { status: FinalizePoolStatus; mediaId: string | null } {
  const row = firstRow<{ status: string; media_id: string | null }>(data);
  const status = row?.status;
  return {
    status: status && FINALIZE_POOL_STATUSES.has(status) ? (status as FinalizePoolStatus) : 'error',
    mediaId: row?.media_id ?? null,
  };
}

/**
 * Finalizes a pool on an exact matched title. Only the pool's current owner
 * may finalize, and finalization is irreversible -- the backend rejects a
 * second call with `already_completed` rather than re-finalizing.
 */
export async function finalizePool(
  poolId: string,
  mediaId: string
): Promise<{ status: FinalizePoolStatus; mediaId: string | null }> {
  const { data, error } = await supabase.rpc('finalize_pool', {
    p_pool_id: poolId,
    p_media_id: mediaId,
  });
  if (error) throw error;
  return toFinalizeResult(data);
}

/**
 * Finalizes a pool on a winner the server chooses at random from its
 * matches. The client never picks -- it only ever reads back whichever
 * media id the backend returns.
 */
export async function finalizePoolRandom(
  poolId: string
): Promise<{ status: FinalizePoolStatus; mediaId: string | null }> {
  const { data, error } = await supabase.rpc('finalize_pool_random', { p_pool_id: poolId });
  if (error) throw error;
  return toFinalizeResult(data);
}

/**
 * Canonical media fields Home/history need to render a winner -- same shape
 * as match.ts's MatchMedia and pool.ts's own PoolWinnerMedia, with `overview`
 * added since a dashboard card shows more than a title. Provider identity
 * stops at the boundary that produced this row.
 */
export type DashboardMediaWinner = {
  id: string;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl: string | null;
  overview: string | null;
};

/** One pool's dashboard-facing summary, shared by Home's preview and the full group history screen. */
export type DashboardPool = {
  id: string;
  status: PoolStatus;
  plannedFor: string | null;
  createdAt: string;
  winner: DashboardMediaWinner | null;
};

export type DashboardGroup = {
  id: string;
  name: string;
  pools: DashboardPool[];
};

/**
 * The columns both loadHomeGroups and loadGroupPoolHistory read from
 * home_group_pool_dashboard -- one flat, provider-independent view joining a
 * group's pools to their canonical winner media, ranked per group by recency
 * (`home_rank`) so Home's three-pool cap is a `lte` rather than a client-side
 * slice.
 */
const HOME_DASHBOARD_SELECT =
  'group_id, group_name, group_joined_at, home_rank, pool_id, pool_status, pool_planned_for, pool_created_at, winner_media_id, winner_media_type, winner_title, winner_poster_url, winner_overview';

const HOME_POOLS_PER_GROUP = 3;

type HomeDashboardRow = {
  group_id: string;
  group_name: string;
  pool_id: string;
  pool_status: PoolStatus;
  pool_planned_for: string | null;
  pool_created_at: string;
  winner_media_id: string | null;
  winner_media_type: 'movie' | 'tv' | null;
  winner_title: string | null;
  winner_poster_url: string | null;
  winner_overview: string | null;
};

function toDashboardPool(row: HomeDashboardRow): DashboardPool {
  return {
    id: row.pool_id,
    status: row.pool_status,
    plannedFor: row.pool_planned_for,
    createdAt: row.pool_created_at,
    winner: row.winner_media_id
      ? {
          id: row.winner_media_id,
          mediaType: row.winner_media_type as 'movie' | 'tv',
          title: row.winner_title ?? '',
          posterUrl: row.winner_poster_url,
          overview: row.winner_overview,
        }
      : null,
  };
}

/** Folds the view's flat rows into one entry per group, preserving row order for both groups and pools. */
function groupDashboardRows(rows: HomeDashboardRow[]): DashboardGroup[] {
  const groups: DashboardGroup[] = [];
  const byGroupId = new Map<string, DashboardGroup>();

  for (const row of rows) {
    let group = byGroupId.get(row.group_id);
    if (!group) {
      group = { id: row.group_id, name: row.group_name, pools: [] };
      byGroupId.set(row.group_id, group);
      groups.push(group);
    }
    group.pools.push(toDashboardPool(row));
  }

  return groups;
}

/**
 * Loads every group the caller belongs to, each with its most recent pools
 * (active and completed mixed, newest first, capped at
 * `HOME_POOLS_PER_GROUP`). A direct RLS-backed read: the view already scopes
 * rows to the caller's own memberships, so nothing here filters by user.
 * Groups come back oldest-membership-first, matching group.tsx's own
 * ordering convention.
 */
export async function loadHomeGroups(): Promise<DashboardGroup[]> {
  const { data, error } = await supabase
    .from('home_group_pool_dashboard')
    .select(HOME_DASHBOARD_SELECT)
    .lte('home_rank', HOME_POOLS_PER_GROUP)
    .order('group_joined_at', { ascending: true })
    .order('pool_created_at', { ascending: false });

  if (error) throw error;

  return groupDashboardRows((data ?? []) as HomeDashboardRow[]);
}

/**
 * Loads every pool for one group, newest first, with no cap -- the full
 * history behind Home's three-pool preview. `groupId` is exact: RLS still
 * governs visibility, so a group the caller does not belong to resolves to
 * an empty list rather than an error.
 */
export async function loadGroupPoolHistory(groupId: string): Promise<DashboardPool[]> {
  const { data, error } = await supabase
    .from('home_group_pool_dashboard')
    .select(HOME_DASHBOARD_SELECT)
    .eq('group_id', groupId)
    .order('pool_created_at', { ascending: false });

  if (error) throw error;

  return ((data ?? []) as HomeDashboardRow[]).map(toDashboardPool);
}

/** Stable identity so consumers do not re-render when the dashboard is empty. */
const EMPTY_DASHBOARD_GROUPS: DashboardGroup[] = [];

export type HomeDashboardStatus = 'loading' | 'error' | 'ready';

/** A load tagged by its own attempt, the same discipline group.tsx's GroupProvider uses for retries. */
type HomeDashboardResult = { attempt: number } & (
  | { status: 'loaded'; groups: DashboardGroup[] }
  | { status: 'error' }
);

/**
 * Home's multi-group dashboard. Loads on mount and exposes `refresh` for the
 * one thing it cannot observe on its own -- a pool this member just
 * generated, which must appear as the newest pool in its group immediately
 * rather than waiting for a remount.
 */
export function useHomeDashboard(): {
  status: HomeDashboardStatus;
  groups: DashboardGroup[];
  refresh: () => void;
} {
  const [result, setResult] = useState<HomeDashboardResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const thisAttempt = attempt;

    loadHomeGroups()
      .then((groups) => {
        if (!cancelled) setResult({ attempt: thisAttempt, status: 'loaded', groups });
      })
      .catch(() => {
        if (!cancelled) setResult({ attempt: thisAttempt, status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // A result from a superseded attempt is simply not a match, so it reads as
  // 'loading' -- the same tagged-result discipline as useLatestActivePool
  // above, extended from a group id to a reload attempt.
  const current = result && result.attempt === attempt ? result : null;
  const status: HomeDashboardStatus = !current ? 'loading' : current.status === 'error' ? 'error' : 'ready';
  const groups = current?.status === 'loaded' ? current.groups : EMPTY_DASHBOARD_GROUPS;

  const refresh = useCallback(() => setAttempt((count) => count + 1), []);

  return { status, groups, refresh };
}
