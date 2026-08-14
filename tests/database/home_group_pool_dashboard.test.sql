-- Popcorn Pact: Home/group pool dashboard read model.
--
-- This is the database contract for the read-only view consumed by Home's
-- multi-group dashboard and by the full group pool history route:
--
--   public.home_group_pool_dashboard
--
-- The view does not own state. It is a safe, RLS-scoped projection over group
-- membership, pools, pool finalization, and canonical media winner metadata.
--
-- These tests intentionally do not implement the view. Dynamic helpers below
-- keep a missing view/column reporting as pgTAP failures instead of aborting
-- the suite at the first undefined relation.

set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(33);


-- ---------------------------------------------------------------------------
-- Test harness.
-- ---------------------------------------------------------------------------

create function pg_temp.dashboard_rows()
returns table (
  group_id uuid,
  group_name text,
  group_joined_at timestamptz,
  home_rank integer,
  pool_id uuid,
  pool_status text,
  pool_planned_for timestamptz,
  pool_created_at timestamptz,
  winner_media_id uuid,
  winner_media_type text,
  winner_title text,
  winner_poster_url text,
  winner_overview text,
  winner_release_year integer
)
language plpgsql
as $$
begin
  return query execute $query$
    select
      group_id,
      group_name,
      group_joined_at,
      home_rank,
      pool_id,
      pool_status,
      pool_planned_for,
      pool_created_at,
      winner_media_id,
      winner_media_type,
      winner_title,
      winner_poster_url,
      winner_overview,
      winner_release_year
    from public.home_group_pool_dashboard
  $query$;
exception
  when undefined_table or undefined_column or insufficient_privilege then
    return;
end;
$$;


-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
select
  user_id,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  email,
  extensions.crypt('password', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('display_name', display_name),
  now(),
  now()
from (
  values
    ('00000000-0000-0000-0000-000000001701'::uuid, 'dashboard-owner@example.test', 'Dashboard Owner'),
    ('00000000-0000-0000-0000-000000001702'::uuid, 'dashboard-partner@example.test', 'Dashboard Partner'),
    ('00000000-0000-0000-0000-000000001703'::uuid, 'dashboard-outsider@example.test', 'Dashboard Outsider'),
    ('00000000-0000-0000-0000-000000001704'::uuid, 'dashboard-grace-owner@example.test', 'Dashboard Grace Owner')
) as users(user_id, email, display_name);

insert into public.groups (id, created_by, created_at)
values
  ('17000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, timestamp with time zone '2026-08-01 00:00:00+00'),
  ('17000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, timestamp with time zone '2026-08-02 00:00:00+00'),
  ('17000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001703'::uuid, timestamp with time zone '2026-08-03 00:00:00+00'),
  ('17000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001704'::uuid, timestamp with time zone '2026-08-04 00:00:00+00'),
  ('17000000-0000-0000-0000-000000000005'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, timestamp with time zone '2026-08-05 00:00:00+00');

insert into public.group_members (group_id, user_id, joined_at)
values
  ('17000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, timestamp with time zone '2026-08-01 10:00:00+00'),
  ('17000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001702'::uuid, timestamp with time zone '2026-08-01 12:00:00+00'),
  ('17000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, timestamp with time zone '2026-08-02 10:00:00+00'),
  ('17000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001703'::uuid, timestamp with time zone '2026-08-03 10:00:00+00'),
  ('17000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001704'::uuid, timestamp with time zone '2026-08-04 10:00:00+00'),
  ('17000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, timestamp with time zone '2026-08-04 11:00:00+00'),
  ('17000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001702'::uuid, timestamp with time zone '2026-08-04 12:00:00+00'),
  ('17000000-0000-0000-0000-000000000005'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, timestamp with time zone '2026-08-05 10:00:00+00');

insert into public.media (id, media_type, title, overview, poster_url, release_year)
values
  ('17000000-0000-0000-0000-000000000101'::uuid, 'movie', 'Canonical Winner', 'Provider-independent overview.', 'https://cdn.example.test/winner.jpg', 2016),
  ('17000000-0000-0000-0000-000000000102'::uuid, 'tv', 'Nullable Winner', null, null, null),
  ('17000000-0000-0000-0000-000000000103'::uuid, 'movie', 'Active Match Only', 'Should not show on active cards.', 'https://cdn.example.test/active.jpg', 2019);

insert into public.pools (id, group_id, created_by, mode, status, planned_for, created_at)
values
  ('17000000-0000-0000-0000-000000000201'::uuid, '17000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, 'manual', 'completed', timestamp with time zone '2026-08-20 20:00:00+00', timestamp with time zone '2026-08-14 14:00:00+00'),
  ('17000000-0000-0000-0000-000000000202'::uuid, '17000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, 'manual', 'active', null, timestamp with time zone '2026-08-14 13:00:00+00'),
  ('17000000-0000-0000-0000-000000000203'::uuid, '17000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001702'::uuid, 'generated', 'active', timestamp with time zone '2026-08-18 20:30:00+00', timestamp with time zone '2026-08-14 12:00:00+00'),
  ('17000000-0000-0000-0000-000000000204'::uuid, '17000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001702'::uuid, 'manual', 'completed', null, timestamp with time zone '2026-08-14 11:00:00+00'),
  ('17000000-0000-0000-0000-000000000205'::uuid, '17000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, 'manual', 'active', null, timestamp with time zone '2026-08-13 13:00:00+00'),
  ('17000000-0000-0000-0000-000000000206'::uuid, '17000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, 'manual', 'active', null, timestamp with time zone '2026-08-13 12:00:00+00'),
  ('17000000-0000-0000-0000-000000000207'::uuid, '17000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001701'::uuid, 'manual', 'completed', null, timestamp with time zone '2026-08-13 11:00:00+00'),
  ('17000000-0000-0000-0000-000000000208'::uuid, '17000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001703'::uuid, 'manual', 'active', null, timestamp with time zone '2026-08-12 10:00:00+00'),
  ('17000000-0000-0000-0000-000000000209'::uuid, '17000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001704'::uuid, 'manual', 'active', null, timestamp with time zone '2026-08-11 10:00:00+00');

insert into public.matches (pool_id, group_id, media_id)
values
  ('17000000-0000-0000-0000-000000000201'::uuid, '17000000-0000-0000-0000-000000000001'::uuid, '17000000-0000-0000-0000-000000000101'::uuid),
  ('17000000-0000-0000-0000-000000000204'::uuid, '17000000-0000-0000-0000-000000000001'::uuid, '17000000-0000-0000-0000-000000000102'::uuid),
  ('17000000-0000-0000-0000-000000000202'::uuid, '17000000-0000-0000-0000-000000000001'::uuid, '17000000-0000-0000-0000-000000000103'::uuid);

update public.pools
set
  winner_media_id = '17000000-0000-0000-0000-000000000101'::uuid,
  finalized_at = timestamp with time zone '2026-08-14 15:00:00+00'
where id = '17000000-0000-0000-0000-000000000201'::uuid;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001701', true);
create temporary table dashboard_owner_view on commit drop as
select * from pg_temp.dashboard_rows();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001702', true);
create temporary table dashboard_partner_view on commit drop as
select * from pg_temp.dashboard_rows();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001703', true);
create temporary table dashboard_outsider_view on commit drop as
select * from pg_temp.dashboard_rows();

reset role;


-- ---------------------------------------------------------------------------
-- Schema shape.
-- ---------------------------------------------------------------------------

select ok(
  to_regclass('public.home_group_pool_dashboard') is not null,
  'home_group_pool_dashboard exists as a public read model'
);

select is(
  (
    select count(*)::integer
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'home_group_pool_dashboard'
      and column_name = any (array[
        'group_id',
        'group_name',
        'group_joined_at',
        'home_rank',
        'pool_id',
        'pool_status',
        'pool_planned_for',
        'pool_created_at',
        'winner_media_id',
        'winner_media_type',
        'winner_title',
        'winner_poster_url',
        'winner_overview',
        'winner_release_year'
      ])
  ),
  14,
  'home_group_pool_dashboard exposes the client dashboard columns'
);

select is(
  (
    select count(*)::integer
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'home_group_pool_dashboard'
      and column_name = any (array[
        'provider',
        'external_id',
        'tmdb_id',
        'tvdb_id',
        'imdb_id',
        'description',
        'synopsis'
      ])
  ),
  0,
  'home_group_pool_dashboard does not expose provider-specific or duplicate description fields'
);


-- ---------------------------------------------------------------------------
-- Visibility / RLS semantics.
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::integer
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
  ),
  4,
  'a member sees every pool row for their own group'
);

select is(
  (
    select count(*)::integer
    from dashboard_outsider_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
  ),
  0,
  'an outsider does not see another group dashboard rows'
);

select set_eq(
  $$
    select group_id::text
    from dashboard_owner_view
  $$,
  $$
    values
      ('17000000-0000-0000-0000-000000000001'),
      ('17000000-0000-0000-0000-000000000002'),
      ('17000000-0000-0000-0000-000000000004'),
      ('17000000-0000-0000-0000-000000000005')
  $$,
  'a user in multiple groups sees all and only their own groups'
);

select is(
  (
    select count(*)::integer
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000003'::uuid
  ),
  0,
  'dashboard rows do not leak pools from unrelated groups'
);

select is(
  public.group_access_state('17000000-0000-0000-0000-000000000004'::uuid),
  'grace',
  'fixture grace group is in grace'
);

select is(
  (
    select count(*)::integer
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000004'::uuid
  ),
  1,
  'grace preserves dashboard reads for current members'
);


-- ---------------------------------------------------------------------------
-- Group metadata.
-- ---------------------------------------------------------------------------

select is(
  (
    select min(group_id::text)
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000201'::uuid
  ),
  '17000000-0000-0000-0000-000000000001',
  'each row exposes the exact source group id'
);

select is(
  (
    select min(group_joined_at)
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
  ),
  timestamp with time zone '2026-08-01 10:00:00+00',
  'group_joined_at is the current caller membership timestamp'
);

select is(
  (
    select min(group_joined_at)
    from dashboard_partner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
  ),
  timestamp with time zone '2026-08-01 12:00:00+00',
  'group_joined_at is not borrowed from another member'
);

select is(
  (
    select count(distinct group_joined_at)::integer
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
  ),
  1,
  'the caller membership timestamp is consistent across one group pool history'
);

select is(
  (
    select min(group_name)
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
  ),
  'You and Dashboard Partner',
  'group_name is an exact dashboard-safe label for the current caller'
);


-- ---------------------------------------------------------------------------
-- Pool rows and ranking.
-- ---------------------------------------------------------------------------

select is(
  (
    select count(distinct pool_id)::integer
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
  ),
  4,
  'one visible row appears per pool with no duplicates'
);

select ok(
  exists (
    select 1
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000202'::uuid
      and pool_status = 'active'
  ),
  'active pools are included'
);

select ok(
  exists (
    select 1
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000201'::uuid
      and pool_status = 'completed'
  ),
  'completed pools are included'
);

select ok(
  exists (
    select 1
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000203'::uuid
      and pool_status = 'active'
  ),
  'older active pools are not hidden by a newer completed pool'
);

select is(
  (
    select pool_status || '|' || coalesce(pool_planned_for::text, '<null>') || '|' || pool_created_at::text
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000203'::uuid
  ),
  'active|2026-08-18 20:30:00+00|2026-08-14 12:00:00+00',
  'pool status, planned_for, and created_at match the source pool exactly'
);

select is(
  (
    select array_agg(pool_id::text || ':' || home_rank::text order by home_rank)
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
      and pool_id is not null
  ),
  array[
    '17000000-0000-0000-0000-000000000201:1',
    '17000000-0000-0000-0000-000000000202:2',
    '17000000-0000-0000-0000-000000000203:3',
    '17000000-0000-0000-0000-000000000204:4'
  ],
  'home_rank orders all pools in a group by pool_created_at desc'
);

select is(
  (
    select home_rank
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000205'::uuid
  ),
  1,
  'home_rank restarts per group'
);

select is(
  (
    select array_agg(home_rank order by home_rank)
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000002'::uuid
  ),
  array[1, 2, 3],
  'a group with exactly three pools exposes ranks 1, 2, and 3'
);

select ok(
  exists (
    select 1
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000204'::uuid
      and home_rank = 4
  ),
  'rank 4+ rows remain available for full history'
);


-- ---------------------------------------------------------------------------
-- Winner metadata.
-- ---------------------------------------------------------------------------

select is(
  (
    select winner_media_id::text || '|' || winner_media_type || '|' || winner_title || '|' || winner_poster_url || '|' || winner_overview || '|' || winner_release_year::text
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000201'::uuid
  ),
  '17000000-0000-0000-0000-000000000101|movie|Canonical Winner|https://cdn.example.test/winner.jpg|Provider-independent overview.|2016',
  'finalized pools expose canonical winner media metadata, including release_year'
);

select ok(
  exists (
    select 1
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000204'::uuid
      and winner_media_id is null
      and winner_media_type is null
      and winner_title is null
      and winner_poster_url is null
      and winner_overview is null
      and winner_release_year is null
  ),
  'completed pools without a finalization winner keep winner columns null'
);

select ok(
  exists (
    select 1
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000202'::uuid
      and winner_media_id is null
      and winner_media_type is null
      and winner_title is null
      and winner_poster_url is null
      and winner_overview is null
      and winner_release_year is null
  ),
  'active pools do not fabricate winner metadata from matches or pool contents'
);

select is(
  (
    select count(*)::integer
    from dashboard_owner_view
    where pool_id = '17000000-0000-0000-0000-000000000201'::uuid
      and winner_title = 'Nullable Winner'
  ),
  0,
  'winner metadata is scoped to the pool winner and never borrowed from another pool'
);


-- ---------------------------------------------------------------------------
-- Full-history and Home-preview suitability.
-- ---------------------------------------------------------------------------

select is(
  (
    select array_agg(pool_id::text order by pool_created_at desc)
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
      and pool_id is not null
  ),
  array[
    '17000000-0000-0000-0000-000000000201',
    '17000000-0000-0000-0000-000000000202',
    '17000000-0000-0000-0000-000000000203',
    '17000000-0000-0000-0000-000000000204'
  ],
  'filtering one group by group_id supports full chronological history'
);

select is(
  (
    select array_agg(pool_id::text order by pool_created_at desc)
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000001'::uuid
      and home_rank <= 3
  ),
  array[
    '17000000-0000-0000-0000-000000000201',
    '17000000-0000-0000-0000-000000000202',
    '17000000-0000-0000-0000-000000000203'
  ],
  'Home can select the three newest pools for one group with home_rank <= 3'
);

select is(
  (
    select count(*)::integer
    from dashboard_owner_view
    where home_rank <= 3
      and group_id in (
        '17000000-0000-0000-0000-000000000001'::uuid,
        '17000000-0000-0000-0000-000000000002'::uuid
      )
  ),
  6,
  'home_rank <= 3 is applied independently per group'
);


-- ---------------------------------------------------------------------------
-- Empty groups and group ordering support.
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::integer
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000005'::uuid
  ),
  1,
  'a visible group with zero pools is still represented'
);

select ok(
  exists (
    select 1
    from dashboard_owner_view
    where group_id = '17000000-0000-0000-0000-000000000005'::uuid
      and pool_id is null
      and pool_status is null
      and pool_planned_for is null
      and pool_created_at is null
      and home_rank is null
      and winner_media_id is null
      and winner_media_type is null
      and winner_title is null
      and winner_poster_url is null
      and winner_overview is null
  ),
  'the empty-group row leaves pool and winner fields null'
);

select is(
  (
    select array_agg(distinct group_joined_at order by group_joined_at)
    from dashboard_owner_view
    where group_id in (
      '17000000-0000-0000-0000-000000000001'::uuid,
      '17000000-0000-0000-0000-000000000002'::uuid,
      '17000000-0000-0000-0000-000000000005'::uuid
    )
  ),
  array[
    timestamp with time zone '2026-08-01 10:00:00+00',
    timestamp with time zone '2026-08-02 10:00:00+00',
    timestamp with time zone '2026-08-05 10:00:00+00'
  ],
  'group_joined_at provides stable caller-specific group ordering data'
);

select * from finish();

rollback;
