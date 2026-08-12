import { FunctionsHttpError } from '@supabase/supabase-js';
import { useCallback, useRef, useState } from 'react';

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
