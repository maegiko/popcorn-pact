-- Popcorn Pact: per-user match confirmations and unanimous auto-finalization.
--
-- This is a black-box contract suite for the next database slice. A match
-- confirmation is a member's irreversible "I want to watch this!" for one
-- matched canonical title in one pool. A new successful confirmation evaluates
-- trusted current membership and, if unanimous, finalizes the pool to that
-- media through the same one-way lifecycle as manual/random finalization.
--
-- The tests intentionally do not create production objects. Helpers keep a
-- missing table/RPC reporting as pgTAP failures until the implementation
-- exists, rather than aborting at the first undefined object.

set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(32);


-- ---------------------------------------------------------------------------
-- Test harness.
-- ---------------------------------------------------------------------------

create function pg_temp.confirm_match_result(p_pool_id uuid, p_media_id uuid)
returns table (status text, finalized boolean, media_id uuid)
language plpgsql
as $$
begin
  return query execute 'select status, finalized, media_id from public.confirm_match($1, $2)'
  using p_pool_id, p_media_id;
exception
  when undefined_function then return query select '__missing_function__'::text, null::boolean, null::uuid;
  when undefined_column then return query select '__missing_column__'::text, null::boolean, null::uuid;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::boolean, null::uuid;
  when others then return query select ('__error_' || sqlstate || '__')::text, null::boolean, null::uuid;
end;
$$;

create function pg_temp.finalize_pool_result(p_pool_id uuid, p_media_id uuid)
returns table (status text, media_id uuid)
language plpgsql
as $$
begin
  return query execute 'select status, media_id from public.finalize_pool($1, $2)'
  using p_pool_id, p_media_id;
exception
  when undefined_function then return query select '__missing_function__'::text, null::uuid;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::uuid;
  when others then return query select ('__error_' || sqlstate || '__')::text, null::uuid;
end;
$$;

create function pg_temp.finalize_pool_random_result(p_pool_id uuid)
returns table (status text, media_id uuid)
language plpgsql
as $$
begin
  return query execute 'select status, media_id from public.finalize_pool_random($1)'
  using p_pool_id;
exception
  when undefined_function then return query select '__missing_function__'::text, null::uuid;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::uuid;
  when others then return query select ('__error_' || sqlstate || '__')::text, null::uuid;
end;
$$;

create function pg_temp.visible_confirmation_count(
  p_pool_id uuid default null,
  p_media_id uuid default null,
  p_user_id uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  if to_regclass('public.match_confirmations') is null then
    return -1;
  end if;

  execute $query$
    select count(*)::integer
    from public.match_confirmations as mc
    where ($1 is null or mc.pool_id = $1)
      and ($2 is null or mc.media_id = $2)
      and ($3 is null or mc.user_id = $3)
  $query$
  into v_count
  using p_pool_id, p_media_id, p_user_id;

  return v_count;
exception
  when undefined_table or undefined_column or insufficient_privilege then return -1;
end;
$$;

create function pg_temp.force_confirmation(
  p_pool_id uuid,
  p_media_id uuid,
  p_user_id uuid,
  p_created_at timestamptz default now()
)
returns text
language plpgsql
as $$
begin
  execute
    'insert into public.match_confirmations (pool_id, media_id, user_id, created_at) values ($1, $2, $3, $4)'
    using p_pool_id, p_media_id, p_user_id, p_created_at;

  return 'inserted';
exception
  when undefined_table then return '__missing_table__';
  when undefined_column then return '__missing_column__';
  when unique_violation then return '__unique_violation__';
  when foreign_key_violation then return '__foreign_key_violation__';
  when others then return '__error_' || sqlstate || '__';
end;
$$;

create function pg_temp.pool_winner_state(p_pool_id uuid)
returns table (status text, winner_media_id uuid, finalized_at timestamptz)
language plpgsql
as $$
begin
  return query execute
    'select p.status, p.winner_media_id, p.finalized_at from public.pools as p where p.id = $1'
    using p_pool_id;
exception
  when undefined_column then return query select '__missing_finalization_columns__'::text, null::uuid, null::timestamptz;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::uuid, null::timestamptz;
end;
$$;

create function pg_temp.visible_swipe_count(p_pool_id uuid, p_user_id uuid default null)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  execute $query$
    select count(*)::integer
    from public.swipes as s
    where s.pool_id = $1
      and ($2 is null or s.user_id = $2)
  $query$
  into v_count
  using p_pool_id, p_user_id;

  return v_count;
exception
  when undefined_table or undefined_column or insufficient_privilege then return -1;
end;
$$;

create function pg_temp.visible_match_count(p_pool_id uuid)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  execute 'select count(*)::integer from public.matches as m where m.pool_id = $1'
  into v_count
  using p_pool_id;

  return v_count;
exception
  when undefined_table or undefined_column or insufficient_privilege then return -1;
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
    ('00000000-0000-0000-0000-000000001301'::uuid, 'user1301@example.test', 'Confirm A'),
    ('00000000-0000-0000-0000-000000001302'::uuid, 'user1302@example.test', 'Confirm B'),
    ('00000000-0000-0000-0000-000000001303'::uuid, 'user1303@example.test', 'Confirm C'),
    ('00000000-0000-0000-0000-000000001304'::uuid, 'user1304@example.test', 'Confirm D'),
    ('00000000-0000-0000-0000-000000001305'::uuid, 'user1305@example.test', 'Confirm Outsider'),
    ('00000000-0000-0000-0000-000000001306'::uuid, 'user1306@example.test', 'Grace A'),
    ('00000000-0000-0000-0000-000000001307'::uuid, 'user1307@example.test', 'Grace B'),
    ('00000000-0000-0000-0000-000000001308'::uuid, 'user1308@example.test', 'Grace C')
) as users(user_id, email, display_name);

insert into public.media (id, media_type, title)
values
  ('83000000-0000-0000-0000-000000000001'::uuid, 'movie', 'Confirmation Movie X'),
  ('83000000-0000-0000-0000-000000000002'::uuid, 'movie', 'Confirmation Movie Y'),
  ('83000000-0000-0000-0000-000000000003'::uuid, 'movie', 'Confirmation Movie Z'),
  ('83000000-0000-0000-0000-000000000099'::uuid, 'movie', 'Confirmation Non Match');

insert into public.media_external_ids (media_id, media_type, provider, external_id)
values
  ('83000000-0000-0000-0000-000000000001'::uuid, 'movie', 'pgtap-confirmations', 'x'),
  ('83000000-0000-0000-0000-000000000002'::uuid, 'movie', 'pgtap-confirmations', 'y'),
  ('83000000-0000-0000-0000-000000000003'::uuid, 'movie', 'pgtap-confirmations', 'z'),
  ('83000000-0000-0000-0000-000000000099'::uuid, 'movie', 'pgtap-confirmations', 'outside');

insert into public.groups (id, created_by)
values
  ('13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid),
  ('13000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001301'::uuid),
  ('13000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001301'::uuid),
  ('13000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001306'::uuid);

insert into public.group_members (group_id, user_id, joined_at)
values
  ('13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001302'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('13000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('13000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001302'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('13000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001303'::uuid, timestamp with time zone '2026-08-13 10:02:00+00'),
  ('13000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('13000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001302'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('13000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001306'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('13000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001307'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('13000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001308'::uuid, timestamp with time zone '2026-08-13 10:02:00+00');

insert into public.pools (id, group_id, created_by, mode, created_at)
select
  pool_id,
  group_id,
  created_by,
  'manual',
  created_at
from (
  values
    ('23000000-0000-0000-0000-000000000001'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:00:00+00'),
    ('23000000-0000-0000-0000-000000000002'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:01:00+00'),
    ('23000000-0000-0000-0000-000000000003'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:02:00+00'),
    ('23000000-0000-0000-0000-000000000004'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:03:00+00'),
    ('23000000-0000-0000-0000-000000000005'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:04:00+00'),
    ('23000000-0000-0000-0000-000000000006'::uuid, '13000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:05:00+00'),
    ('23000000-0000-0000-0000-000000000007'::uuid, '13000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:06:00+00'),
    ('23000000-0000-0000-0000-000000000008'::uuid, '13000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:07:00+00'),
    ('23000000-0000-0000-0000-000000000009'::uuid, '13000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:08:00+00'),
    ('23000000-0000-0000-0000-000000000010'::uuid, '13000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000001306'::uuid, timestamp with time zone '2026-08-13 11:09:00+00'),
    ('23000000-0000-0000-0000-000000000011'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:10:00+00'),
    ('23000000-0000-0000-0000-000000000012'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:11:00+00'),
    ('23000000-0000-0000-0000-000000000013'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:12:00+00'),
    ('23000000-0000-0000-0000-000000000014'::uuid, '13000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid, timestamp with time zone '2026-08-13 11:13:00+00')
) as pools(pool_id, group_id, created_by, created_at);

insert into public.pool_titles (pool_id, media_id)
select p.id, m.id
from public.pools as p
cross join public.media as m
where p.id between '23000000-0000-0000-0000-000000000001'::uuid
  and '23000000-0000-0000-0000-000000000014'::uuid
  and m.id in (
    '83000000-0000-0000-0000-000000000001'::uuid,
    '83000000-0000-0000-0000-000000000002'::uuid,
    '83000000-0000-0000-0000-000000000003'::uuid
  );

insert into public.swipes (pool_id, group_id, user_id, media_id, decision)
select p.id, p.group_id, gm.user_id, m.id, 'like'
from public.pools as p
join public.group_members as gm on gm.group_id = p.group_id
cross join public.media as m
where p.id between '23000000-0000-0000-0000-000000000001'::uuid
  and '23000000-0000-0000-0000-000000000014'::uuid
  and m.id in ('83000000-0000-0000-0000-000000000001'::uuid, '83000000-0000-0000-0000-000000000002'::uuid);

insert into public.matches (pool_id, group_id, media_id)
select p.id, p.group_id, m.id
from public.pools as p
cross join public.media as m
where p.id between '23000000-0000-0000-0000-000000000001'::uuid
  and '23000000-0000-0000-0000-000000000014'::uuid
  and m.id in ('83000000-0000-0000-0000-000000000001'::uuid, '83000000-0000-0000-0000-000000000002'::uuid);

update public.pools
set status = 'completed',
    winner_media_id = '83000000-0000-0000-0000-000000000001'::uuid,
    finalized_at = timestamp with time zone '2026-08-13 12:00:00+00'
where id = '23000000-0000-0000-0000-000000000004'::uuid;

-- Three-member groups 2 and 3 are legitimate active fixtures. Grace group 4 is
-- intentionally left at the free limit so write operations remain blocked.
create or replace function public.member_limit_for_group(p_group_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when g.id in (
      '13000000-0000-0000-0000-000000000002'::uuid,
      '13000000-0000-0000-0000-000000000003'::uuid
    ) then 3
    else 2
  end
  from public.groups as g
  where g.id = p_group_id;
$$;


-- ---------------------------------------------------------------------------
-- Public surface.
-- ---------------------------------------------------------------------------

select has_table('public', 'match_confirmations', 'match confirmations are persisted in a public table with RLS');
select has_pk('public', 'match_confirmations', 'match confirmations are keyed once per pool/media/user');
select has_function('public', 'confirm_match', array['uuid', 'uuid'], 'confirm_match(pool_id, media_id) is the trusted write boundary');


-- ---------------------------------------------------------------------------
-- Basic confirmation contract.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table first_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000001'::uuid,
  '83000000-0000-0000-0000-000000000001'::uuid
);
create temporary table duplicate_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000001'::uuid,
  '83000000-0000-0000-0000-000000000001'::uuid
);
create temporary table second_title_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000001'::uuid,
  '83000000-0000-0000-0000-000000000002'::uuid
);
create temporary table non_match_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000001'::uuid,
  '83000000-0000-0000-0000-000000000003'::uuid
);
create temporary table other_pool_match_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000002'::uuid,
  '83000000-0000-0000-0000-000000000003'::uuid
);
create temporary table completed_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000004'::uuid,
  '83000000-0000-0000-0000-000000000001'::uuid
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001305', true);
create temporary table outsider_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000001'::uuid,
  '83000000-0000-0000-0000-000000000001'::uuid
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001306', true);
create temporary table grace_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000010'::uuid,
  '83000000-0000-0000-0000-000000000001'::uuid
);
reset role;

select ok(
  (select status = 'confirmed' and finalized is false and media_id is null from first_confirm)
  and pg_temp.visible_confirmation_count(
    '23000000-0000-0000-0000-000000000001'::uuid,
    '83000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000001301'::uuid
  ) = 1,
  'first valid confirmation is persisted once without finalizing'
);
select ok(
  (select status = 'already_confirmed' and finalized is false from duplicate_confirm)
  and pg_temp.visible_confirmation_count(
    '23000000-0000-0000-0000-000000000001'::uuid,
    '83000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000001301'::uuid
  ) = 1,
  'duplicate confirmation is idempotent and creates no second row'
);
select ok(
  (select status = 'confirmed' from second_title_confirm)
  and pg_temp.visible_confirmation_count(
    '23000000-0000-0000-0000-000000000001'::uuid,
    null,
    '00000000-0000-0000-0000-000000001301'::uuid
  ) = 2,
  'a user may confirm multiple different matches in the same pool'
);
select is((select status from non_match_confirm), 'match_not_found', 'non-match media cannot be confirmed');
select is((select status from other_pool_match_confirm), 'match_not_found', 'a match from another pool cannot be confirmed here');
select is((select status from outsider_confirm), 'not_a_member', 'outsider cannot confirm a match');
select is((select status from grace_confirm), 'group_in_grace', 'group feature writes, including confirmations, are blocked in grace');
select is((select status from completed_confirm), 'pool_completed', 'completed pools reject confirmations');
select is(
  pg_temp.visible_confirmation_count(
    '23000000-0000-0000-0000-000000000004'::uuid,
    '83000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000001301'::uuid
  ),
  0,
  'rejected post-completion confirmations create no late rows'
);


-- ---------------------------------------------------------------------------
-- Unanimous auto-finalization and current membership timing.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table two_a_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000002'::uuid,
  '83000000-0000-0000-0000-000000000001'::uuid
);
-- Snapshotted here rather than read live in the assertion below: the second
-- confirmation finalizes this pool, and both assertions run after both calls,
-- so a live read would report the completed state to the test that is about the
-- state *before* it.
create temporary table two_state_after_a on commit drop as
select * from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000002'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001302', true);
create temporary table two_b_confirm on commit drop as
select * from pg_temp.confirm_match_result(
  '23000000-0000-0000-0000-000000000002'::uuid,
  '83000000-0000-0000-0000-000000000001'::uuid
);
reset role;

select ok(
  (select status = 'confirmed' and finalized is false from two_a_confirm)
  and (select status = 'active' from two_state_after_a),
  'two-member first confirmation does not finalize'
);
select ok(
  (select status = 'confirmed' and finalized is true and media_id = '83000000-0000-0000-0000-000000000001'::uuid from two_b_confirm)
  and (select status = 'completed' and winner_media_id = '83000000-0000-0000-0000-000000000001'::uuid and finalized_at is not null from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000002'::uuid)),
  'two-member final confirmation auto-finalizes and persists winner lifecycle'
);
select ok(
  pg_temp.visible_match_count('23000000-0000-0000-0000-000000000002'::uuid) = 2
  and pg_temp.visible_swipe_count('23000000-0000-0000-0000-000000000002'::uuid) = 4,
  'auto-finalization leaves matches and swipes as historical records'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table three_a_confirm on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000006'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001302', true);
create temporary table three_b_confirm on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000006'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001303', true);
create temporary table three_c_confirm on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000006'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
reset role;

select ok(
  (select status = 'confirmed' and finalized is false from three_a_confirm)
  and (select status = 'confirmed' and finalized is false from three_b_confirm)
  and (select status = 'confirmed' and finalized is true from three_c_confirm)
  and (select winner_media_id = '83000000-0000-0000-0000-000000000001'::uuid from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000006'::uuid)),
  'three-member groups auto-finalize only after every current member confirms'
);

select pg_temp.force_confirmation('23000000-0000-0000-0000-000000000007'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid);
select pg_temp.force_confirmation('23000000-0000-0000-0000-000000000007'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001302'::uuid);
delete from public.group_members
where group_id = '13000000-0000-0000-0000-000000000002'::uuid
  and user_id = '00000000-0000-0000-0000-000000001303'::uuid;

select is(
  (select status from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000007'::uuid)),
  'active',
  'membership changes alone do not auto-finalize old confirmations'
);

insert into public.group_members (group_id, user_id, joined_at)
values (
  '13000000-0000-0000-0000-000000000002'::uuid,
  '00000000-0000-0000-0000-000000001303'::uuid,
  timestamp with time zone '2026-08-13 12:00:00+00'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001303', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table rejoined_c_confirm on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000007'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
reset role;

select ok(
  (select status = 'confirmed' and finalized is true from rejoined_c_confirm)
  and (select winner_media_id = '83000000-0000-0000-0000-000000000001'::uuid from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000007'::uuid)),
  'a later new confirmation evaluates against membership current at confirmation time'
);

select pg_temp.force_confirmation('23000000-0000-0000-0000-000000000009'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid);
select pg_temp.force_confirmation('23000000-0000-0000-0000-000000000009'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001302'::uuid);
insert into public.group_members (group_id, user_id, joined_at)
values (
  '13000000-0000-0000-0000-000000000003'::uuid,
  '00000000-0000-0000-0000-000000001303'::uuid,
  timestamp with time zone '2026-08-13 12:00:00+00'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001303', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table joined_c_confirm on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000009'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
reset role;

select ok(
  (select status = 'confirmed' and finalized is true from joined_c_confirm)
  and (select winner_media_id = '83000000-0000-0000-0000-000000000001'::uuid from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000009'::uuid)),
  'members who join before a confirmation event are included in the unanimity count'
);


-- ---------------------------------------------------------------------------
-- Interactions with existing finalization paths and race invariants.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table manual_beats_confirmation on commit drop as
select * from pg_temp.finalize_pool_result('23000000-0000-0000-0000-000000000003'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
create temporary table late_confirm_after_manual on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000003'::uuid, '83000000-0000-0000-0000-000000000002'::uuid);
create temporary table random_beats_confirmation on commit drop as
select * from pg_temp.finalize_pool_random_result('23000000-0000-0000-0000-000000000005'::uuid);
create temporary table late_confirm_after_random on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000005'::uuid, '83000000-0000-0000-0000-000000000002'::uuid);
reset role;

select ok(
  (select status = 'finalized' from manual_beats_confirmation)
  and (select status = 'pool_completed' from late_confirm_after_manual)
  and pg_temp.visible_confirmation_count('23000000-0000-0000-0000-000000000003'::uuid, '83000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001301'::uuid) = 0,
  'manual finalization can beat confirmation and losing confirmation creates no late mutation'
);
select ok(
  (select status = 'finalized' from random_beats_confirmation)
  and (select status = 'pool_completed' from late_confirm_after_random)
  and pg_temp.visible_confirmation_count('23000000-0000-0000-0000-000000000005'::uuid, '83000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001301'::uuid) = 0,
  'random finalization can beat confirmation and losing confirmation creates no late mutation'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table auto_first_a on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000011'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001302', true);
create temporary table auto_first_b on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000011'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
create temporary table manual_after_auto on commit drop as
select * from pg_temp.finalize_pool_result('23000000-0000-0000-0000-000000000011'::uuid, '83000000-0000-0000-0000-000000000002'::uuid);

create temporary table auto_random_a on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000012'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001302', true);
create temporary table auto_random_b on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000012'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
create temporary table random_after_auto on commit drop as
select * from pg_temp.finalize_pool_random_result('23000000-0000-0000-0000-000000000012'::uuid);
reset role;

select ok(
  (select finalized is true from auto_first_b)
  and (select status = 'already_completed' from manual_after_auto)
  and (select winner_media_id = '83000000-0000-0000-0000-000000000001'::uuid from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000011'::uuid)),
  'unanimous confirmation can beat manual finalization if it acquires lifecycle completion first'
);
select ok(
  (select finalized is true from auto_random_b)
  and (select status = 'already_completed' from random_after_auto)
  and (select winner_media_id = '83000000-0000-0000-0000-000000000001'::uuid from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000012'::uuid)),
  'unanimous confirmation can beat random finalization if it acquires lifecycle completion first'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table race_dup_one on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000013'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
create temporary table race_dup_two on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000013'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001302', true);
create temporary table race_dup_final on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000013'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
reset role;

select ok(
  (select status = 'confirmed' from race_dup_one)
  and (select status = 'already_confirmed' from race_dup_two)
  and pg_temp.visible_confirmation_count('23000000-0000-0000-0000-000000000013'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid) = 1
  and (select finalized is true from race_dup_final),
  'retried/concurrent duplicate confirmations cannot create duplicate rows and still allow one finalization'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table title_race_a_x on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000014'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
create temporary table title_race_a_y on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000014'::uuid, '83000000-0000-0000-0000-000000000002'::uuid);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001302', true);
create temporary table title_race_b_y on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000014'::uuid, '83000000-0000-0000-0000-000000000002'::uuid);
create temporary table title_race_b_x_late on commit drop as
select * from pg_temp.confirm_match_result('23000000-0000-0000-0000-000000000014'::uuid, '83000000-0000-0000-0000-000000000001'::uuid);
reset role;

select ok(
  (select finalized is true and media_id = '83000000-0000-0000-0000-000000000002'::uuid from title_race_b_y)
  and (select status = 'pool_completed' from title_race_b_x_late)
  and (select winner_media_id = '83000000-0000-0000-0000-000000000002'::uuid from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000014'::uuid))
  and pg_temp.visible_confirmation_count('23000000-0000-0000-0000-000000000014'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001302'::uuid) = 0,
  'two different titles nearing unanimity still produce exactly one finalized winner'
);
select ok(
  pg_temp.visible_confirmation_count('23000000-0000-0000-0000-000000000014'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, null) = 1
  and (select winner_media_id = '83000000-0000-0000-0000-000000000002'::uuid from pg_temp.pool_winner_state('23000000-0000-0000-0000-000000000014'::uuid)),
  'partial confirmations on losing matches remain historical and do not alter the winner'
);


-- ---------------------------------------------------------------------------
-- RLS and privacy.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.force_confirmation('23000000-0000-0000-0000-000000000008'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid);
select pg_temp.force_confirmation('23000000-0000-0000-0000-000000000008'::uuid, '83000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001302'::uuid);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001301', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is(
  pg_temp.visible_confirmation_count('23000000-0000-0000-0000-000000000008'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid),
  1,
  'a member can read their own confirmation state for UI'
);
select is(
  pg_temp.visible_confirmation_count('23000000-0000-0000-0000-000000000008'::uuid, '83000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001302'::uuid),
  0,
  'a member does not need raw partner confirmation rows exposed'
);
select is(
  pg_temp.visible_swipe_count('23000000-0000-0000-0000-000000000008'::uuid, '00000000-0000-0000-0000-000000001302'::uuid),
  0,
  'raw partner swipe privacy remains unchanged'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001305', true);
select is(
  pg_temp.visible_confirmation_count('23000000-0000-0000-0000-000000000008'::uuid, null, null),
  0,
  'outsiders cannot read confirmation state'
);
reset role;

select is(
  pg_temp.force_confirmation('23000000-0000-0000-0000-000000000008'::uuid, '83000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001301'::uuid),
  '__unique_violation__',
  'database identity enforces one confirmation per user per match'
);
select is(
  pg_temp.force_confirmation('23000000-0000-0000-0000-000000000001'::uuid, '83000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001301'::uuid),
  '__foreign_key_violation__',
  'confirmation integrity is tied to an existing match identity'
);

select * from finish();
rollback;
