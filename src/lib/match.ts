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
