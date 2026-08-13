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
