import { supabase } from '@/lib/supabase';

/**
 * Canonical media fields the deck needs to render a card. Deliberately just
 * identity plus what the UI shows -- no provider id crosses this boundary, so
 * the component never learns whether a title came from TMDB, TVDB or
 * Streaming Availability.
 */
export type MediaRecord = {
  id: string;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl: string | null;
};

/**
 * One member's decision, scoped to the pool it was made in. `undoable` mirrors
 * the backend's `undoable` flag -- true on exactly the pass the member could
 * still take back, so the deck can restore Undo across a reload without a
 * separate round trip.
 */
export type SwipeRow = {
  poolId: string;
  mediaId: string;
  decision: 'like' | 'pass';
  undoable: boolean;
};

export type PoolDeck = {
  media: MediaRecord[];
  swipes: SwipeRow[];
};

export type RecordSwipeStatus =
  | 'recorded'
  | 'already_recorded'
  | 'like_final'
  | 'pass_must_be_undone'
  | 'not_a_member'
  | 'media_not_in_pool'
  | 'invalid_decision'
  | 'group_in_grace'
  | 'group_too_small'
  | 'pool_completed'
  | 'error';

export type UndoStatus = 'undone' | 'nothing_to_undo' | 'not_a_member' | 'group_in_grace' | 'error';

const RECORD_SWIPE_STATUSES = new Set<string>([
  'recorded',
  'already_recorded',
  'like_final',
  'pass_must_be_undone',
  'not_a_member',
  'media_not_in_pool',
  'invalid_decision',
  'group_in_grace',
  'group_too_small',
  'pool_completed',
]);

const UNDO_STATUSES = new Set<string>(['undone', 'nothing_to_undo', 'not_a_member', 'group_in_grace']);

/** RPCs declared `returns table` arrive as an array of one row, same as group.tsx. */
function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return (data as T | null) ?? null;
}

type MediaEmbed = {
  id: string;
  media_type: 'movie' | 'tv';
  title: string | null;
  poster_url: string | null;
};

type PoolTitleRow = {
  media_id: string;
  // PostgREST returns an object for a to-one embed, but the shape is not typed
  // without generated types, so both forms are handled -- same discipline as
  // group.tsx's profiles embed.
  media: MediaEmbed | MediaEmbed[] | null;
};

type SwipeSelectRow = {
  pool_id: string;
  media_id: string;
  decision: 'like' | 'pass';
  undoable: boolean;
};

function toMediaRecord(row: PoolTitleRow): MediaRecord | null {
  const media = Array.isArray(row.media) ? row.media[0] : row.media;
  if (!media) return null;

  return {
    id: media.id,
    mediaType: media.media_type,
    title: media.title ?? '',
    posterUrl: media.poster_url,
  };
}

/**
 * Loads a pool's titles and the caller's own swipes for that pool.
 *
 * Swipes are fetched scoped to `poolId`, but RLS is what actually keeps them
 * private: a client can only ever see its own rows regardless of this filter.
 */
export async function loadPoolDeck(poolId: string): Promise<PoolDeck> {
  const [titles, swipes] = await Promise.all([
    supabase
      .from('pool_titles')
      .select('media_id, media(id, media_type, title, poster_url)')
      .eq('pool_id', poolId),
    supabase.from('swipes').select('pool_id, media_id, decision, undoable').eq('pool_id', poolId),
  ]);

  if (titles.error) throw titles.error;
  if (swipes.error) throw swipes.error;

  const media = ((titles.data ?? []) as PoolTitleRow[])
    .map(toMediaRecord)
    .filter((item): item is MediaRecord => item !== null);

  const swipeRows = ((swipes.data ?? []) as SwipeSelectRow[]).map(
    (row): SwipeRow => ({
      poolId: row.pool_id,
      mediaId: row.media_id,
      decision: row.decision,
      undoable: row.undoable,
    })
  );

  return { media, swipes: swipeRows };
}

/**
 * Records the caller's decision for a title in a pool. See swipes migration
 * for the status contract, and the matches migration for match_created --
 * true only for the exact call whose like completed every current member's
 * agreement, false for every other outcome including a duplicate/rejected
 * swipe or a successful like that did not complete the set.
 */
export async function recordSwipe(
  poolId: string,
  mediaId: string,
  decision: 'like' | 'pass'
): Promise<{ status: RecordSwipeStatus; matchCreated: boolean }> {
  const { data, error } = await supabase.rpc('record_swipe', {
    p_pool_id: poolId,
    p_media_id: mediaId,
    p_decision: decision,
  });
  if (error) throw error;

  const row = firstRow<{ status: string; match_created?: boolean }>(data);
  const status = row?.status;
  return {
    status: status && RECORD_SWIPE_STATUSES.has(status) ? (status as RecordSwipeStatus) : 'error',
    matchCreated: row?.match_created === true,
  };
}

/** Undoes the caller's pass, while it is still the decision just made. */
export async function undoLastPass(poolId: string): Promise<{ status: UndoStatus; mediaId: string | null }> {
  const { data, error } = await supabase.rpc('undo_last_pass', { p_pool_id: poolId });
  if (error) throw error;

  const row = firstRow<{ status: string; media_id: string | null }>(data);
  const status = row?.status;
  return {
    status: status && UNDO_STATUSES.has(status) ? (status as UndoStatus) : 'error',
    mediaId: row?.media_id ?? null,
  };
}
