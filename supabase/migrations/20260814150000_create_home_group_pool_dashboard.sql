-- Popcorn Pact: Home's multi-group dashboard read model.
--
-- public.home_group_pool_dashboard is the single view behind two client
-- boundaries -- Home's per-group pool preview and the full group pool
-- history route. It owns no state of its own: a projection over group
-- membership, pools, pool finalization, and canonical media winner metadata,
-- all of which already exist and are already governed by their own RLS.
--
-- Three properties are load-bearing:
--
--   caller-scoped     every row belongs to a group the caller currently
--                     belongs to, and group_joined_at is always the
--                     CALLER's own membership row, never a partner's.
--   empty groups       a group with zero pools still emits one row, with
--                     every pool/winner column null, so Home can render the
--                     group's header and "Make new pool" before it has
--                     anything else to show.
--   provider-free       winner metadata is exactly media.title / .poster_url /
--                     .overview, joined by pools.winner_media_id alone --
--                     never inferred from matches, pool_titles or swipes,
--                     and never branched on which provider populated the
--                     canonical media row.


-- ---------------------------------------------------------------------------
-- Visibility.
--
-- security_invoker = true, the same load-bearing choice group_access makes in
-- the groups migration: it makes the querying user's own RLS policies govern
-- every table this view touches, so a defect in the view's own filtering
-- cannot fall back to the view owner's elevated privileges and expose another
-- user's groups. Without it this would be a definer view and leak everyone's
-- data regardless of what the WHERE clauses below say.
--
-- That protection is a backstop, not the only guard: my_memberships below
-- filters explicitly on `(select auth.uid())` rather than trusting the
-- underlying group_members/pools policies to do it implicitly. Two
-- independent reasons to be caller-scoped, rather than one.
-- ---------------------------------------------------------------------------

create view public.home_group_pool_dashboard
with (security_invoker = true) as
with my_memberships as (
  -- THE EXPLICIT AUTH.UID()-SCOPED BASE RELATION. Every other CTE below joins
  -- against this one (never against group_members or pools directly keyed on
  -- some other column), so "which groups can this caller see" is answered in
  -- exactly one place. group_joined_at is carried from here alone, which is
  -- what guarantees it is always the caller's own membership timestamp and
  -- never a partner's -- group_members has no uniqueness that would stop a
  -- naive join from picking up the wrong member's row.
  select
    gm.group_id,
    gm.joined_at as group_joined_at
  from public.group_members as gm
  where gm.user_id = (select auth.uid())
),

group_labels as (
  -- Client-safe, caller-relative group naming: groups carries no name
  -- column, so "You and {the other member(s)}" is derived per caller from
  -- who else is in the group. A solo group (no partner yet) gets a distinct
  -- label rather than "You and" with nothing after it.
  select
    mm.group_id,
    (
      select string_agg(p.display_name, ' and ' order by gm2.joined_at)
      from public.group_members as gm2
      join public.profiles as p on p.id = gm2.user_id
      where gm2.group_id = mm.group_id
        and gm2.user_id <> (select auth.uid())
    ) as other_members_label
  from my_memberships as mm
),

ranked_pools as (
  -- One row per pool this caller may see, ranked newest-first within its own
  -- group. Pre-filtered to my_memberships (rather than ranking the whole
  -- table and relying on the outer join to discard the rest) so the window
  -- function never has to consider a pool the caller cannot see, and so RLS
  -- on pools is exercised the same way every other read of it is.
  select
    p.id as pool_id,
    p.group_id,
    p.status as pool_status,
    p.planned_for as pool_planned_for,
    p.created_at as pool_created_at,
    p.winner_media_id,
    -- row_number() is bigint; cast to integer to match the client's declared
    -- column type (and pgTAP's function-return-type check on this view).
    (row_number() over (
      partition by p.group_id
      order by p.created_at desc
    ))::integer as home_rank
  from public.pools as p
  where p.group_id in (select group_id from my_memberships)
)

select
  mm.group_id,
  case
    when gl.other_members_label is null then 'Waiting for them'
    else 'You and ' || gl.other_members_label
  end as group_name,
  mm.group_joined_at,
  rp.home_rank,
  rp.pool_id,
  rp.pool_status,
  rp.pool_planned_for,
  rp.pool_created_at,
  -- WINNER METADATA IS JOINED BY POOLS.WINNER_MEDIA_ID ALONE. A pool with no
  -- winner_media_id -- active, or completed without ever being finalized --
  -- takes the left join's all-null side here rather than falling back to
  -- anything drawn from matches or pool_titles, which is what keeps an
  -- active pool's card from ever fabricating a title to show.
  m.id as winner_media_id,
  m.media_type as winner_media_type,
  m.title as winner_title,
  m.poster_url as winner_poster_url,
  m.overview as winner_overview
from my_memberships as mm
join group_labels as gl on gl.group_id = mm.group_id
-- LEFT JOIN, not JOIN: a group with zero pools must still produce its one
-- placeholder row rather than disappearing from the dashboard entirely.
left join ranked_pools as rp on rp.group_id = mm.group_id
left join public.media as m on m.id = rp.winner_media_id;

comment on view public.home_group_pool_dashboard is
  'Read model behind Home''s multi-group dashboard and the full group pool history route. One row per pool the caller can see (newest first per group via home_rank), plus one all-null-pool placeholder row for a group with none. Caller-scoped by construction (security_invoker plus an explicit auth.uid() base relation), never definer-elevated. Winner metadata is canonical media joined by pools.winner_media_id only -- never inferred from matches or provider-specific fields.';


-- ---------------------------------------------------------------------------
-- Grants.
--
-- Views are not auto-exposed to the Data API roles, so grant explicitly, the
-- same as group_access. Read-only: there is no writer here, the view merely
-- projects tables that already have their own.
-- ---------------------------------------------------------------------------

grant select on public.home_group_pool_dashboard to authenticated;
