import { supabase } from '@/lib/supabase';

/**
 * Canonical media fields the matches list needs to render a row. Same shape
 * as swipe.ts's MediaRecord and deliberately just identity plus what the UI
 * shows -- no provider id crosses this boundary.
 */
export type MatchMedia = {
  id: string;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl: string | null;
};

export type PoolMatch = {
  poolId: string;
  media: MatchMedia;
};

type MediaEmbed = {
  id: string;
  media_type: 'movie' | 'tv';
  title: string | null;
  poster_url: string | null;
};

type MatchRow = {
  pool_id: string;
  // PostgREST returns an object for a to-one embed, but the shape is not typed
  // without generated types, so both forms are handled -- same discipline as
  // swipe.ts's pool_titles embed.
  media: MediaEmbed | MediaEmbed[] | null;
};

function toPoolMatch(row: MatchRow): PoolMatch | null {
  const media = Array.isArray(row.media) ? row.media[0] : row.media;
  if (!media) return null;

  return {
    poolId: row.pool_id,
    media: {
      id: media.id,
      mediaType: media.media_type,
      title: media.title ?? '',
      posterUrl: media.poster_url,
    },
  };
}

/**
 * Outcomes confirm_match() can report to a correct client -- see the
 * match_confirmations migration for the full contract. `error` covers a
 * transport failure and any status this client build does not recognise,
 * matching swipe.ts's and pool.ts's boundary convention.
 */
export type ConfirmMatchStatus =
  | 'confirmed'
  | 'already_confirmed'
  | 'pool_completed'
  | 'not_a_member'
  | 'match_not_found'
  | 'group_in_grace'
  | 'group_too_small'
  | 'error';

export type ConfirmMatchResult = {
  status: ConfirmMatchStatus;
  finalized: boolean;
  mediaId: string | null;
};

const CONFIRM_MATCH_STATUSES = new Set<string>([
  'confirmed',
  'already_confirmed',
  'pool_completed',
  'not_a_member',
  'match_not_found',
  'group_in_grace',
  'group_too_small',
]);

/** RPCs declared `returns table` arrive as an array of one row, same as swipe.ts and pool.ts. */
function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return (data as T | null) ?? null;
}

/**
 * Records the caller's irreversible "I want to watch this" for one of their
 * pool's matches. `mediaId` on the result is only ever the winning title --
 * it is null on every non-finalizing outcome, including a duplicate --
 * because the caller already knows which title it just confirmed.
 */
export async function confirmMatch(poolId: string, mediaId: string): Promise<ConfirmMatchResult> {
  const { data, error } = await supabase.rpc('confirm_match', {
    p_pool_id: poolId,
    p_media_id: mediaId,
  });
  if (error) throw error;

  const row = firstRow<{ status: string; finalized: boolean; media_id: string | null }>(data);
  const status = row?.status;
  return {
    status: status && CONFIRM_MATCH_STATUSES.has(status) ? (status as ConfirmMatchStatus) : 'error',
    finalized: row?.finalized === true,
    mediaId: row?.media_id ?? null,
  };
}

/**
 * Loads the caller's own confirmed media ids for one pool. A direct
 * RLS-backed read, same discipline as pool.ts's loadPoolLifecycle: the
 * match_confirmations policy already limits this to the caller's own rows,
 * so filtering by pool_id here is enough -- it never needs to (and must
 * never try to) ask about a partner's confirmations.
 */
export async function loadMyMatchConfirmations(poolId: string): Promise<string[]> {
  const { data, error } = await supabase.from('match_confirmations').select('media_id').eq('pool_id', poolId);

  if (error) throw error;

  return ((data ?? []) as { media_id: string }[]).map((row) => row.media_id);
}

/**
 * Loads one pool's matches, newest first. Pool-scoped like everything else
 * built on a pool; RLS further scopes this to groups the caller belongs to,
 * so a pool id for another group's pool resolves to an empty list rather than
 * an error. Carries no swipe data -- a match records only that the group
 * agreed, never who liked what or when relative to whom.
 */
export async function loadPoolMatches(poolId: string): Promise<PoolMatch[]> {
  const { data, error } = await supabase
    .from('matches')
    .select('pool_id, media(id, media_type, title, poster_url)')
    .eq('pool_id', poolId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return ((data ?? []) as MatchRow[])
    .map(toPoolMatch)
    .filter((item): item is PoolMatch => item !== null);
}
