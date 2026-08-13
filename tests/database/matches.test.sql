-- Popcorn Pact: match creation from pool-scoped likes.
--
-- This is a black-box contract suite for the next database slice. A match is a
-- group-level agreement on one canonical title inside one pool. It is created
-- only by the trusted swipe path when a newly recorded like completes the set of
-- current group members who have liked that same (pool_id, media_id).
--
-- The tests intentionally do not create production objects. Helpers below keep
-- missing tables/columns/function-return fields reporting as pgTAP failures
-- until the match migration and record_swipe changes exist.

set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(23);


-- ---------------------------------------------------------------------------
-- Test harness.
-- ---------------------------------------------------------------------------

create function pg_temp.record_swipe_result(p_pool_id uuid, p_media_id uuid, p_decision text)
returns table (status text, match_created boolean)
language plpgsql
as $$
begin
  return query execute
    'select status, match_created from public.record_swipe($1, $2, $3)'
    using p_pool_id, p_media_id, p_decision;
exception
  when undefined_column then
    return query execute
      'select status, null::boolean from public.record_swipe($1, $2, $3)'
      using p_pool_id, p_media_id, p_decision;
  when undefined_function then
    return query select '__missing_function__'::text, null::boolean;
  when insufficient_privilege then
    return query select '__permission_denied__'::text, null::boolean;
  when others then
    return query select ('__error_' || sqlstate || '__')::text, null::boolean;
end;
$$;

create function pg_temp.visible_match_count(
  p_pool_id uuid default null,
  p_group_id uuid default null,
  p_media_id uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  if to_regclass('public.matches') is null then
    return -1;
  end if;

  execute $query$
    select count(*)::integer
    from public.matches as m
    where ($1 is null or m.pool_id = $1)
      and ($2 is null or m.group_id = $2)
      and ($3 is null or m.media_id = $3)
  $query$
  into v_count
  using p_pool_id, p_group_id, p_media_id;

  return v_count;
exception
  when undefined_table or undefined_column or insufficient_privilege then return -1;
end;
$$;

create function pg_temp.visible_swipe_count(
  p_pool_id uuid default null,
  p_user_id uuid default null,
  p_media_id uuid default null,
  p_decision text default null
)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  if to_regclass('public.swipes') is null then
    return -1;
  end if;

  execute $query$
    select count(*)::integer
    from public.swipes as s
    where ($1 is null or s.pool_id = $1)
      and ($2 is null or s.user_id = $2)
      and ($3 is null or s.media_id = $3)
      and ($4 is null or s.decision = $4)
  $query$
  into v_count
  using p_pool_id, p_user_id, p_media_id, p_decision;

  return v_count;
exception
  when undefined_table or undefined_column or insufficient_privilege then return -1;
end;
$$;

create function pg_temp.seed_swipe(
  p_pool_id uuid,
  p_group_id uuid,
  p_user_id uuid,
  p_media_id uuid,
  p_decision text
)
returns void
language plpgsql
as $$
begin
  if to_regclass('public.swipes') is null then
    return;
  end if;

  execute $query$
    insert into public.swipes (pool_id, group_id, user_id, media_id, decision)
    values ($1, $2, $3, $4, $5)
    on conflict (pool_id, user_id, media_id) do nothing
  $query$
  using p_pool_id, p_group_id, p_user_id, p_media_id, p_decision;
exception
  when undefined_table or undefined_column then return;
end;
$$;

create function pg_temp.insert_match_status(p_pool_id uuid, p_group_id uuid, p_media_id uuid)
returns text
language plpgsql
as $$
begin
  execute
    'insert into public.matches (pool_id, group_id, media_id) values ($1, $2, $3)'
    using p_pool_id, p_group_id, p_media_id;

  return 'inserted';
exception
  when undefined_table then return '__missing_table__';
  when undefined_column then return '__missing_column__';
  when unique_violation then return '__unique_violation__';
  when foreign_key_violation then return '__foreign_key_violation__';
  when others then return '__error_' || sqlstate || '__';
end;
$$;

create function pg_temp.pool_status(p_pool_id uuid)
returns text
language plpgsql
as $$
declare
  v_status text;
begin
  execute 'select status from public.pools where id = $1'
  into v_status
  using p_pool_id;

  return v_status;
exception
  when undefined_column then return '__missing_status__';
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
    ('00000000-0000-0000-0000-000000001101'::uuid, 'user1101@example.test', 'Match A'),
    ('00000000-0000-0000-0000-000000001102'::uuid, 'user1102@example.test', 'Match B'),
    ('00000000-0000-0000-0000-000000001103'::uuid, 'user1103@example.test', 'Match C'),
    ('00000000-0000-0000-0000-000000001104'::uuid, 'user1104@example.test', 'Match D'),
    ('00000000-0000-0000-0000-000000001105'::uuid, 'user1105@example.test', 'Single Member'),
    ('00000000-0000-0000-0000-000000001106'::uuid, 'user1106@example.test', 'Grace A'),
    ('00000000-0000-0000-0000-000000001107'::uuid, 'user1107@example.test', 'Grace B'),
    ('00000000-0000-0000-0000-000000001108'::uuid, 'user1108@example.test', 'Grace C'),
    ('00000000-0000-0000-0000-000000001109'::uuid, 'user1109@example.test', 'Outsider')
) as users(user_id, email, display_name);

insert into public.media (id, media_type, title)
values
  ('81000000-0000-0000-0000-000000000001'::uuid, 'movie', 'Match Movie X'),
  ('81000000-0000-0000-0000-000000000002'::uuid, 'movie', 'Match Movie Y'),
  ('81000000-0000-0000-0000-000000000003'::uuid, 'movie', 'Match Movie Z'),
  ('81000000-0000-0000-0000-000000000004'::uuid, 'tv', 'Match Series W'),
  ('81000000-0000-0000-0000-000000000099'::uuid, 'movie', 'Not In Pool');

insert into public.media_external_ids (media_id, media_type, provider, external_id)
values
  ('81000000-0000-0000-0000-000000000001'::uuid, 'movie', 'pgtap-matches', 'x'),
  ('81000000-0000-0000-0000-000000000002'::uuid, 'movie', 'pgtap-matches', 'y'),
  ('81000000-0000-0000-0000-000000000003'::uuid, 'movie', 'pgtap-matches', 'z'),
  ('81000000-0000-0000-0000-000000000004'::uuid, 'tv', 'pgtap-matches', 'w'),
  ('81000000-0000-0000-0000-000000000099'::uuid, 'movie', 'pgtap-matches', 'outside');

insert into public.groups (id, created_by)
values
  ('11000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001101'::uuid),
  ('11000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001101'::uuid),
  ('11000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001105'::uuid),
  ('11000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001106'::uuid),
  ('11000000-0000-0000-0000-000000000005'::uuid, '00000000-0000-0000-0000-000000001101'::uuid);

insert into public.group_members (group_id, user_id, joined_at)
values
  ('11000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001101'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('11000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001102'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('11000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001101'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('11000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001102'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('11000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001103'::uuid, timestamp with time zone '2026-08-13 10:02:00+00'),
  ('11000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001105'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('11000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001106'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('11000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001107'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('11000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001108'::uuid, timestamp with time zone '2026-08-13 10:02:00+00'),
  ('11000000-0000-0000-0000-000000000005'::uuid, '00000000-0000-0000-0000-000000001101'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('11000000-0000-0000-0000-000000000005'::uuid, '00000000-0000-0000-0000-000000001102'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('11000000-0000-0000-0000-000000000005'::uuid, '00000000-0000-0000-0000-000000001103'::uuid, timestamp with time zone '2026-08-13 10:02:00+00');

insert into public.pools (id, group_id, created_by, mode, created_at)
values
  ('21000000-0000-0000-0000-000000000001'::uuid, '11000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001101'::uuid, 'manual', timestamp with time zone '2026-08-13 11:00:00+00'),
  ('21000000-0000-0000-0000-000000000002'::uuid, '11000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001101'::uuid, 'manual', timestamp with time zone '2026-08-13 11:01:00+00'),
  ('21000000-0000-0000-0000-000000000003'::uuid, '11000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001101'::uuid, 'manual', timestamp with time zone '2026-08-13 11:02:00+00'),
  ('21000000-0000-0000-0000-000000000004'::uuid, '11000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001101'::uuid, 'manual', timestamp with time zone '2026-08-13 11:03:00+00'),
  ('21000000-0000-0000-0000-000000000005'::uuid, '11000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001105'::uuid, 'manual', timestamp with time zone '2026-08-13 11:04:00+00'),
  ('21000000-0000-0000-0000-000000000006'::uuid, '11000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001106'::uuid, 'manual', timestamp with time zone '2026-08-13 11:05:00+00'),
  ('21000000-0000-0000-0000-000000000007'::uuid, '11000000-0000-0000-0000-000000000005'::uuid, '00000000-0000-0000-0000-000000001101'::uuid, 'manual', timestamp with time zone '2026-08-13 11:06:00+00');

insert into public.pool_titles (pool_id, media_id)
select p.pool_id, m.media_id
from (
  values
    ('21000000-0000-0000-0000-000000000001'::uuid),
    ('21000000-0000-0000-0000-000000000002'::uuid),
    ('21000000-0000-0000-0000-000000000003'::uuid),
    ('21000000-0000-0000-0000-000000000004'::uuid),
    ('21000000-0000-0000-0000-000000000005'::uuid),
    ('21000000-0000-0000-0000-000000000006'::uuid),
    ('21000000-0000-0000-0000-000000000007'::uuid)
) as p(pool_id)
cross join (
  values
    ('81000000-0000-0000-0000-000000000001'::uuid),
    ('81000000-0000-0000-0000-000000000002'::uuid),
    ('81000000-0000-0000-0000-000000000003'::uuid),
    ('81000000-0000-0000-0000-000000000004'::uuid)
) as m(media_id);


-- ---------------------------------------------------------------------------
-- Test-only entitlement fixture.
--
-- member_limit_for_group() is the entitlement seam the schema exists
-- specifically so callers (production RevenueCat integration later, this
-- suite now) can swap its answer without touching any table, policy or RPC --
-- see the groups migration. The three-member matching scenario below needs
-- group 11000000-...-002 to have real capacity for three members, not the
-- free-tier default of two, or group_access_state() would put it in grace and
-- record_swipe() would refuse every swipe with group_in_grace before matching
-- was ever exercised.
--
-- Scoped to exactly that one group: group 11000000-...-004 (the deliberate
-- three-member "Grace" fixture below) is left at the unmodified default of 2
-- so it stays in grace, which is the point of that fixture. Production
-- entitlement rules are untouched -- CREATE OR REPLACE FUNCTION is
-- transactional DDL, and the whole suite runs inside BEGIN/ROLLBACK, so this
-- reverts the instant the test transaction ends.
-- ---------------------------------------------------------------------------

create or replace function public.member_limit_for_group(p_group_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when g.id = '11000000-0000-0000-0000-000000000002'::uuid then 3
    else 2
  end
  from public.groups as g
  where g.id = p_group_id;
$$;


-- ---------------------------------------------------------------------------
-- Public surface.
-- ---------------------------------------------------------------------------

select has_table('public', 'matches', 'matches are persisted in a public table with RLS');


-- ---------------------------------------------------------------------------
-- Basic two-member matching and idempotency.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table two_member_a_like_x on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000001'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is false from two_member_a_like_x)
  and pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid
  ) = 0,
  'first like in a two-member group records without creating a match'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001102', true);
create temporary table two_member_b_like_x on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000001'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is true from two_member_b_like_x)
  and pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid
  ) = 1,
  'final like in a two-member group creates exactly one match and reports it'
);

create temporary table duplicate_b_like_x on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000001'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);

select ok(
  (select status = 'already_recorded' and match_created is false from duplicate_b_like_x)
  and pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid
  ) = 1,
  'duplicate like is idempotent and does not report a new match'
);


-- ---------------------------------------------------------------------------
-- Three-member, pass, title and pool scoping.
-- ---------------------------------------------------------------------------

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table three_a_like_x on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000004'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001102', true);
create temporary table three_b_like_x on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000004'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001103', true);
create temporary table three_c_like_x on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000004'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is false from three_a_like_x)
  and (select status = 'recorded' and match_created is false from three_b_like_x)
  and (select status = 'recorded' and match_created is true from three_c_like_x)
  and pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000004'::uuid,
    '11000000-0000-0000-0000-000000000002'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid
  ) = 1,
  'three-member groups match only after every current member likes'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table pass_a_y on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000002'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  'pass'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001102', true);
create temporary table like_b_y_after_pass on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000002'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is false from pass_a_y)
  and (select status = 'recorded' and match_created is false from like_b_y_after_pass)
  and pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000002'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '81000000-0000-0000-0000-000000000002'::uuid
  ) = 0,
  'a pass from one member prevents other likes from creating a match'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table split_a_z on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000002'::uuid,
  '81000000-0000-0000-0000-000000000003'::uuid,
  'like'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001102', true);
create temporary table split_b_w on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000002'::uuid,
  '81000000-0000-0000-0000-000000000004'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is false from split_a_z)
  and (select status = 'recorded' and match_created is false from split_b_w)
  and pg_temp.visible_match_count('21000000-0000-0000-0000-000000000002'::uuid, null, null) = 0,
  'likes split across different media do not combine into a match'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table pool1_a_y on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000003'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  'like'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001102', true);
create temporary table pool2_b_y on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000001'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is false from pool1_a_y)
  and (select status = 'recorded' and match_created is false from pool2_b_y)
  and pg_temp.visible_match_count(null, '11000000-0000-0000-0000-000000000001'::uuid, '81000000-0000-0000-0000-000000000002'::uuid) = 0,
  'likes for the same media in different pools do not combine'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001102', true);
create temporary table pool1_b_y on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000003'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  'like'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
create temporary table pool2_a_y on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000001'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is true from pool1_b_y)
  and (select status = 'recorded' and match_created is true from pool2_a_y)
  and pg_temp.visible_match_count(null, '11000000-0000-0000-0000-000000000001'::uuid, '81000000-0000-0000-0000-000000000002'::uuid) = 2,
  'the same media can independently match in different pools'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table multi_a_z on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000003'::uuid,
  '81000000-0000-0000-0000-000000000003'::uuid,
  'like'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001102', true);
create temporary table multi_b_z on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000003'::uuid,
  '81000000-0000-0000-0000-000000000003'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is true from multi_b_z)
  and pg_temp.visible_match_count('21000000-0000-0000-0000-000000000003'::uuid, null, null) = 2,
  'multiple different media can match within one pool'
);


-- ---------------------------------------------------------------------------
-- Race-safety/idempotency and membership timing.
-- ---------------------------------------------------------------------------

reset role;
select is(
  pg_temp.insert_match_status(
    '21000000-0000-0000-0000-000000000003'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '81000000-0000-0000-0000-000000000003'::uuid
  ),
  '__unique_violation__',
  'matches are unique per pool and media for deterministic retry/race safety'
);

select pg_temp.seed_swipe(
  '21000000-0000-0000-0000-000000000007'::uuid,
  '11000000-0000-0000-0000-000000000005'::uuid,
  '00000000-0000-0000-0000-000000001101'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);

delete from public.group_members
where group_id = '11000000-0000-0000-0000-000000000005'::uuid
  and user_id = '00000000-0000-0000-0000-000000001103'::uuid;

select is(
  pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000007'::uuid,
    '11000000-0000-0000-0000-000000000005'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid
  ),
  0,
  'membership changes alone do not create matches from old partial likes'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001102', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table membership_b_like_x on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000007'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);

select ok(
  (select status = 'recorded' and match_created is true from membership_b_like_x)
  and pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000007'::uuid,
    '11000000-0000-0000-0000-000000000005'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid
  ) = 1,
  'a later new like evaluates against the members current at that moment'
);

reset role;
insert into public.group_members (group_id, user_id, joined_at)
values (
  '11000000-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000001104'::uuid,
  timestamp with time zone '2026-08-13 12:00:00+00'
);

select is(
  pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid
  ),
  1,
  'a later member joining does not invalidate an existing match'
);

delete from public.group_members
where group_id = '11000000-0000-0000-0000-000000000001'::uuid
  and user_id = '00000000-0000-0000-0000-000000001102'::uuid;

select is(
  pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid
  ),
  1,
  'a later member leaving does not invalidate an existing match'
);


-- ---------------------------------------------------------------------------
-- Minimum group size, RLS, grace and pool independence.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001105', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table single_member_like on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000005'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid,
  'like'
);

select ok(
  (select status = 'group_too_small' and match_created is false from single_member_like)
  and pg_temp.visible_swipe_count(
    '21000000-0000-0000-0000-000000000005'::uuid,
    '00000000-0000-0000-0000-000000001105'::uuid,
    '81000000-0000-0000-0000-000000000001'::uuid,
    null
  ) = 0
  and pg_temp.visible_match_count('21000000-0000-0000-0000-000000000005'::uuid, null, null) = 0,
  'record_swipe is rejected server-side while a group has fewer than two members'
);

reset role;
select pg_temp.insert_match_status(
  '21000000-0000-0000-0000-000000000006'::uuid,
  '11000000-0000-0000-0000-000000000004'::uuid,
  '81000000-0000-0000-0000-000000000001'::uuid
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

-- Pool 1 legitimately carries two matches by this point, not one: media X
-- (asserted by "final like in a two-member group creates exactly one match
-- and reports it", above) and media Y (asserted by "the same media can
-- independently match in different pools", where pool2_a_y explicitly
-- completes Y's match in this same pool). This checks that a member can read
-- their group's matches at all, not the count of a specific title's match, so
-- it counts both rather than re-deriving a fresh pool.
select is(
  pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    null
  ),
  2,
  'group members can read matches in their group'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001109', true);

select is(
  pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    null
  ),
  0,
  'non-members cannot read another group''s matches'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001106', true);

select is(
  pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000006'::uuid,
    '11000000-0000-0000-0000-000000000004'::uuid,
    null
  ),
  1,
  'grace-state members can still read existing matches'
);

create temporary table grace_like_attempt on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000006'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  'like'
);

select ok(
  (select status = 'group_in_grace' and match_created is false from grace_like_attempt)
  and pg_temp.visible_match_count(
    '21000000-0000-0000-0000-000000000006'::uuid,
    '11000000-0000-0000-0000-000000000004'::uuid,
    null
  ) = 1,
  'grace still blocks new swipe writes and cannot create new matches'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001101', true);
create temporary table media_outside_pool on commit drop as
select * from pg_temp.record_swipe_result(
  '21000000-0000-0000-0000-000000000002'::uuid,
  '81000000-0000-0000-0000-000000000099'::uuid,
  'like'
);

select ok(
  (select status = 'media_not_in_pool' and match_created is false from media_outside_pool)
  and pg_temp.visible_match_count('21000000-0000-0000-0000-000000000002'::uuid, null, null) = 0,
  'trusted swipe path cannot create a match for media outside the pool'
);

select ok(
  pg_temp.visible_swipe_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000001101'::uuid,
    null,
    null
  ) > 0
  and pg_temp.visible_swipe_count(
    '21000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000001102'::uuid,
    null,
    null
  ) = 0,
  'raw partner swipes remain private even after matches exist'
);

select is(
  pg_temp.pool_status('21000000-0000-0000-0000-000000000003'::uuid),
  'active',
  'creating matches does not complete the pool'
);

reset role;

select * from finish();

rollback;
