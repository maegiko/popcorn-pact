-- Popcorn Pact: pool finalization and planned watch time.
--
-- This is a black-box contract suite for the next database slice. A pool can
-- carry an optional planned watch time, and the pool creator/current owner is
-- the only member allowed to schedule it or finalize the pool. Finalization is
-- one-way: it chooses exactly one existing match in that pool, marks the pool
-- completed, and leaves swipes/matches/watched state as history.
--
-- The tests intentionally do not create production objects. Helpers below keep
-- missing columns/RPCs reporting as pgTAP failures until the implementation
-- exists, rather than aborting at the first undefined object.

set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(40);


-- ---------------------------------------------------------------------------
-- Test harness.
-- ---------------------------------------------------------------------------

create function pg_temp.set_planned_for_status(p_pool_id uuid, p_planned_for timestamptz)
returns text
language plpgsql
as $$
declare
  v_status text;
begin
  execute 'select status from public.set_pool_planned_for($1, $2)'
  into v_status
  using p_pool_id, p_planned_for;

  return v_status;
exception
  when undefined_function then return '__missing_function__';
  when undefined_column then return '__missing_column__';
  when insufficient_privilege then return '__permission_denied__';
  when others then return '__error_' || sqlstate || '__';
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
  when undefined_column then return query select '__missing_column__'::text, null::uuid;
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
  when undefined_column then return query select '__missing_column__'::text, null::uuid;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::uuid;
  when others then return query select ('__error_' || sqlstate || '__')::text, null::uuid;
end;
$$;

create function pg_temp.pool_planned_for_state(p_pool_id uuid)
returns table (lookup_status text, planned_for timestamptz)
language plpgsql
as $$
begin
  return query execute 'select ''ok''::text, p.planned_for from public.pools as p where p.id = $1'
  using p_pool_id;
exception
  when undefined_column then return query select '__missing_planned_for__'::text, null::timestamptz;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::timestamptz;
end;
$$;

create function pg_temp.pool_winner_state(p_pool_id uuid)
returns table (lookup_status text, status text, winner_media_id uuid, finalized_at timestamptz)
language plpgsql
as $$
begin
  return query execute
    'select ''ok''::text, p.status, p.winner_media_id, p.finalized_at from public.pools as p where p.id = $1'
    using p_pool_id;
exception
  when undefined_column then
    return query select '__missing_finalization_columns__'::text, null::text, null::uuid, null::timestamptz;
  when insufficient_privilege then
    return query select '__permission_denied__'::text, null::text, null::uuid, null::timestamptz;
end;
$$;

create function pg_temp.pool_owner_state(p_pool_id uuid)
returns table (lookup_status text, owner_id uuid)
language plpgsql
as $$
begin
  return query execute 'select ''ok''::text, p.created_by from public.pools as p where p.id = $1'
  using p_pool_id;
exception
  when undefined_column then return query select '__missing_owner__'::text, null::uuid;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::uuid;
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

create function pg_temp.visible_swipe_count(p_pool_id uuid)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  execute 'select count(*)::integer from public.swipes as s where s.pool_id = $1'
  into v_count
  using p_pool_id;

  return v_count;
exception
  when undefined_table or undefined_column or insufficient_privilege then return -1;
end;
$$;

create function pg_temp.visible_watched_count(p_group_id uuid, p_media_id uuid)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  if to_regclass('public.watched') is null then
    return 0;
  end if;

  execute 'select count(*)::integer from public.watched as w where w.group_id = $1 and w.media_id = $2'
  into v_count
  using p_group_id, p_media_id;

  return v_count;
exception
  when undefined_table or undefined_column or insufficient_privilege then return -1;
end;
$$;

create function pg_temp.visible_pool_row_count(p_pool_id uuid)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  execute 'select count(*)::integer from public.pools as p where p.id = $1'
  into v_count
  using p_pool_id;

  return v_count;
exception
  when insufficient_privilege then return -1;
end;
$$;

create function pg_temp.record_swipe_result(p_pool_id uuid, p_media_id uuid, p_decision text)
returns table (status text, match_created boolean)
language plpgsql
as $$
begin
  return query execute 'select status, match_created from public.record_swipe($1, $2, $3)'
  using p_pool_id, p_media_id, p_decision;
exception
  when undefined_column then
    return query execute 'select status, null::boolean from public.record_swipe($1, $2, $3)'
    using p_pool_id, p_media_id, p_decision;
  when undefined_function then return query select '__missing_function__'::text, null::boolean;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::boolean;
  when others then return query select ('__error_' || sqlstate || '__')::text, null::boolean;
end;
$$;

create function pg_temp.undo_last_pass_result(p_pool_id uuid)
returns table (status text, media_id uuid)
language plpgsql
as $$
begin
  return query execute 'select status, media_id from public.undo_last_pass($1)'
  using p_pool_id;
exception
  when undefined_function then return query select '__missing_function__'::text, null::uuid;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::uuid;
  when others then return query select ('__error_' || sqlstate || '__')::text, null::uuid;
end;
$$;

create function pg_temp.fixture_mark_finalized(
  p_pool_id uuid,
  p_winner_media_id uuid,
  p_planned_for timestamptz default null
)
returns text
language plpgsql
as $$
begin
  execute $query$
    update public.pools
    set status = 'completed',
        winner_media_id = $2,
        finalized_at = timestamp with time zone '2026-08-13 20:00:00+00',
        planned_for = coalesce($3, planned_for)
    where id = $1
  $query$
  using p_pool_id, p_winner_media_id, p_planned_for;

  return 'ok';
exception
  when undefined_column then return '__missing_finalization_columns__';
  when check_violation then return '__check_violation__';
  when others then return '__error_' || sqlstate || '__';
end;
$$;

create function pg_temp.try_reopen_pool_status(p_pool_id uuid)
returns text
language plpgsql
as $$
begin
  execute 'update public.pools set status = ''active'' where id = $1'
  using p_pool_id;

  return 'ok';
exception
  when check_violation then return '__check_violation__';
  when insufficient_privilege then return '__permission_denied__';
  when others then return '__error_' || sqlstate || '__';
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
    ('00000000-0000-0000-0000-000000001201'::uuid, 'user1201@example.test', 'Finalization Creator'),
    ('00000000-0000-0000-0000-000000001202'::uuid, 'user1202@example.test', 'Finalization Partner A'),
    ('00000000-0000-0000-0000-000000001203'::uuid, 'user1203@example.test', 'Finalization Partner B'),
    ('00000000-0000-0000-0000-000000001204'::uuid, 'user1204@example.test', 'Finalization Outsider'),
    ('00000000-0000-0000-0000-000000001205'::uuid, 'user1205@example.test', 'Finalization Grace A'),
    ('00000000-0000-0000-0000-000000001206'::uuid, 'user1206@example.test', 'Finalization Grace B'),
    ('00000000-0000-0000-0000-000000001207'::uuid, 'user1207@example.test', 'Finalization Grace C')
) as users(user_id, email, display_name);

insert into public.media (id, media_type, title)
values
  ('82000000-0000-0000-0000-000000000001'::uuid, 'movie', 'Finalization Movie A'),
  ('82000000-0000-0000-0000-000000000002'::uuid, 'movie', 'Finalization Movie B'),
  ('82000000-0000-0000-0000-000000000003'::uuid, 'movie', 'Finalization Movie C'),
  ('82000000-0000-0000-0000-000000000004'::uuid, 'tv', 'Finalization Series D'),
  ('82000000-0000-0000-0000-000000000099'::uuid, 'movie', 'Finalization Non Match');

insert into public.media_external_ids (media_id, media_type, provider, external_id)
values
  ('82000000-0000-0000-0000-000000000001'::uuid, 'movie', 'pgtap-finalization', 'a'),
  ('82000000-0000-0000-0000-000000000002'::uuid, 'movie', 'pgtap-finalization', 'b'),
  ('82000000-0000-0000-0000-000000000003'::uuid, 'movie', 'pgtap-finalization', 'c'),
  ('82000000-0000-0000-0000-000000000004'::uuid, 'tv', 'pgtap-finalization', 'd'),
  ('82000000-0000-0000-0000-000000000099'::uuid, 'movie', 'pgtap-finalization', 'outside');

insert into public.groups (id, created_by)
values
  ('12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid),
  ('12000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001201'::uuid),
  ('12000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001205'::uuid);

insert into public.group_members (group_id, user_id, joined_at)
values
  ('12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001202'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('12000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('12000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001202'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('12000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001205'::uuid, timestamp with time zone '2026-08-13 10:00:00+00'),
  ('12000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001206'::uuid, timestamp with time zone '2026-08-13 10:01:00+00'),
  ('12000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001207'::uuid, timestamp with time zone '2026-08-13 10:02:00+00');

insert into public.pools (id, group_id, created_by, mode, created_at)
select
  pool_id,
  group_id,
  created_by,
  'manual',
  created_at
from (
  values
    ('22000000-0000-0000-0000-000000000001'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:00:00+00'),
    ('22000000-0000-0000-0000-000000000002'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:01:00+00'),
    ('22000000-0000-0000-0000-000000000003'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:02:00+00'),
    ('22000000-0000-0000-0000-000000000004'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:03:00+00'),
    ('22000000-0000-0000-0000-000000000005'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:04:00+00'),
    ('22000000-0000-0000-0000-000000000006'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:05:00+00'),
    ('22000000-0000-0000-0000-000000000007'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:06:00+00'),
    ('22000000-0000-0000-0000-000000000008'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:07:00+00'),
    ('22000000-0000-0000-0000-000000000009'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:08:00+00'),
    ('22000000-0000-0000-0000-000000000010'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:09:00+00'),
    ('22000000-0000-0000-0000-000000000011'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:10:00+00'),
    ('22000000-0000-0000-0000-000000000012'::uuid, '12000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, timestamp with time zone '2026-08-13 11:11:00+00'),
    ('22000000-0000-0000-0000-000000000013'::uuid, '12000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000001205'::uuid, timestamp with time zone '2026-08-13 11:12:00+00')
) as pools(pool_id, group_id, created_by, created_at);

insert into public.pool_titles (pool_id, media_id)
select p.id, m.id
from public.pools as p
cross join public.media as m
where p.id between '22000000-0000-0000-0000-000000000001'::uuid
  and '22000000-0000-0000-0000-000000000013'::uuid
  and m.id in (
    '82000000-0000-0000-0000-000000000001'::uuid,
    '82000000-0000-0000-0000-000000000002'::uuid,
    '82000000-0000-0000-0000-000000000003'::uuid
  );

insert into public.swipes (pool_id, group_id, user_id, media_id, decision)
values
  ('22000000-0000-0000-0000-000000000002'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, '82000000-0000-0000-0000-000000000001'::uuid, 'like'),
  ('22000000-0000-0000-0000-000000000002'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001202'::uuid, '82000000-0000-0000-0000-000000000001'::uuid, 'like'),
  ('22000000-0000-0000-0000-000000000003'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, '82000000-0000-0000-0000-000000000001'::uuid, 'like'),
  ('22000000-0000-0000-0000-000000000003'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001202'::uuid, '82000000-0000-0000-0000-000000000001'::uuid, 'like'),
  ('22000000-0000-0000-0000-000000000003'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001201'::uuid, '82000000-0000-0000-0000-000000000002'::uuid, 'like'),
  ('22000000-0000-0000-0000-000000000003'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000001202'::uuid, '82000000-0000-0000-0000-000000000002'::uuid, 'like');

-- An undoable pass in a pool that is finalized later on, so "a completed pool
-- rejects undo" can prove the historical row actually survives rather than
-- merely that the lifecycle check fires before anything is found to undo.
insert into public.swipes (pool_id, group_id, user_id, media_id, decision, undoable)
values (
  '22000000-0000-0000-0000-000000000011'::uuid,
  '12000000-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000001202'::uuid,
  '82000000-0000-0000-0000-000000000003'::uuid,
  'pass',
  true
);

insert into public.matches (pool_id, group_id, media_id)
values
  ('22000000-0000-0000-0000-000000000002'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000003'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000003'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000002'::uuid),
  ('22000000-0000-0000-0000-000000000004'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000005'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000006'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000007'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000007'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000002'::uuid),
  ('22000000-0000-0000-0000-000000000008'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000008'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000002'::uuid),
  ('22000000-0000-0000-0000-000000000009'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000009'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000002'::uuid),
  ('22000000-0000-0000-0000-000000000010'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000011'::uuid, '12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  ('22000000-0000-0000-0000-000000000012'::uuid, '12000000-0000-0000-0000-000000000002'::uuid, '82000000-0000-0000-0000-000000000002'::uuid),
  ('22000000-0000-0000-0000-000000000013'::uuid, '12000000-0000-0000-0000-000000000003'::uuid, '82000000-0000-0000-0000-000000000001'::uuid);


-- ---------------------------------------------------------------------------
-- Pool ownership comes from the caller.
--
-- created_by now carries authority -- scheduling and finalization -- so where
-- it comes from is a security property rather than bookkeeping. This runs as
-- 1202, who is a member of group 1 but NOT its owner (1201 is, until the
-- transfer section below), so a pool owned by 1202 can only have come from
-- auth.uid() inside the trusted path.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001202', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table generated_pool_owner on commit drop as
select * from public.create_generated_pool(
  '12000000-0000-0000-0000-000000000001'::uuid,
  $$[
    {
      "media_type": "movie",
      "title": "Finalization Movie A",
      "external_ids": { "pgtap-finalization": "a" }
    }
  ]$$::jsonb
);
reset role;

select ok(
  (select status = 'created' from generated_pool_owner)
  and (
    select owner_id = '00000000-0000-0000-0000-000000001202'::uuid
    from pg_temp.pool_owner_state((select pool_id from generated_pool_owner))
  ),
  'a generated pool is owned by the member who requested it, not by the group owner'
);


-- ---------------------------------------------------------------------------
-- Planned watch time.
-- ---------------------------------------------------------------------------

select ok(
  (select lookup_status = 'ok' from pg_temp.pool_planned_for_state('22000000-0000-0000-0000-000000000001'::uuid))
  and (select planned_for is null from pg_temp.pool_planned_for_state('22000000-0000-0000-0000-000000000001'::uuid)),
  'planned_for defaults null'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001201', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table planned_set on commit drop as
select pg_temp.set_planned_for_status(
  '22000000-0000-0000-0000-000000000001'::uuid,
  timestamp with time zone '2026-08-14 19:30:00+00'
) as status;
-- Observed immediately, because all three mutations below run at fixture time,
-- before any assertion. Reading the column after the clear would only ever see
-- NULL, so each step's persisted value has to be captured as it happens.
create temporary table planned_after_set on commit drop as
select * from pg_temp.pool_planned_for_state('22000000-0000-0000-0000-000000000001'::uuid);

create temporary table planned_update on commit drop as
select pg_temp.set_planned_for_status(
  '22000000-0000-0000-0000-000000000001'::uuid,
  timestamp with time zone '2026-08-15 20:00:00+00'
) as status;
create temporary table planned_after_update on commit drop as
select * from pg_temp.pool_planned_for_state('22000000-0000-0000-0000-000000000001'::uuid);

create temporary table planned_clear on commit drop as
select pg_temp.set_planned_for_status('22000000-0000-0000-0000-000000000001'::uuid, null) as status;
reset role;

select ok(
  (select status = 'updated' from planned_set)
  and (select planned_for = timestamp with time zone '2026-08-14 19:30:00+00' from planned_after_set),
  'creator sets planned_for on an active pool'
);

select ok(
  (select status = 'updated' from planned_update)
  and (select planned_for = timestamp with time zone '2026-08-15 20:00:00+00' from planned_after_update),
  'creator updates planned_for on an active pool'
);

select ok(
  (select status = 'updated' from planned_clear)
  and (select planned_for is null from pg_temp.pool_planned_for_state('22000000-0000-0000-0000-000000000001'::uuid)),
  'creator can clear planned_for back to null'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001202', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table planned_non_creator on commit drop as
select pg_temp.set_planned_for_status(
  '22000000-0000-0000-0000-000000000001'::uuid,
  timestamp with time zone '2026-08-16 20:00:00+00'
) as status;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001204', true);
create temporary table planned_outsider on commit drop as
select pg_temp.set_planned_for_status(
  '22000000-0000-0000-0000-000000000001'::uuid,
  timestamp with time zone '2026-08-16 20:00:00+00'
) as status;
reset role;

select is((select status from planned_non_creator), 'not_creator', 'non-creator cannot edit planned_for');
select is((select status from planned_outsider), 'not_a_member', 'outsider cannot edit planned_for');


-- ---------------------------------------------------------------------------
-- Manual finalization.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001201', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table finalize_zero on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000001'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
create temporary table finalize_one on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000002'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
create temporary table finalize_multi on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000003'::uuid,
  '82000000-0000-0000-0000-000000000002'::uuid
);
create temporary table finalize_non_match on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000004'::uuid,
  '82000000-0000-0000-0000-000000000003'::uuid
);
create temporary table finalize_other_pool_match on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000004'::uuid,
  '82000000-0000-0000-0000-000000000002'::uuid
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001202', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table finalize_non_creator on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000005'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001204', true);
create temporary table finalize_outsider on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000005'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
reset role;

select is((select status from finalize_zero), 'no_matches', 'zero matches cannot be finalized');
select ok(
  (select status = 'finalized' and media_id = '82000000-0000-0000-0000-000000000001'::uuid from finalize_one),
  'one-match finalization selects that exact match'
);
select ok(
  (select status = 'finalized' and media_id = '82000000-0000-0000-0000-000000000002'::uuid from finalize_multi),
  'multiple-match manual finalization may choose any valid match from that pool'
);
select is((select status from finalize_non_match), 'media_not_matched', 'non-match media is rejected');
select is((select status from finalize_other_pool_match), 'media_not_matched', 'match from another pool is rejected');
select is((select status from finalize_non_creator), 'not_creator', 'non-creator cannot finalize');
select is((select status from finalize_outsider), 'not_a_member', 'outsider cannot finalize');

select ok(
  (select status = 'completed' from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000002'::uuid)),
  'successful finalization sets pool completed'
);
select ok(
  (select winner_media_id = '82000000-0000-0000-0000-000000000001'::uuid and finalized_at is not null from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000002'::uuid)),
  'winner is persisted with finalized timestamp'
);
select ok(
  pg_temp.visible_match_count('22000000-0000-0000-0000-000000000002'::uuid) = 1
  and pg_temp.visible_swipe_count('22000000-0000-0000-0000-000000000002'::uuid) = 2,
  'finalization does not delete matches or swipes'
);
select is(
  pg_temp.visible_watched_count('12000000-0000-0000-0000-000000000001'::uuid, '82000000-0000-0000-0000-000000000001'::uuid),
  0,
  'finalization does not imply watched state'
);


-- ---------------------------------------------------------------------------
-- Irreversibility and completed-pool swipe rejection.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001201', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table second_finalize on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000002'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
create temporary table winner_change_attempt on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000003'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
create temporary table post_completion_like on commit drop as
select * from pg_temp.record_swipe_result(
  '22000000-0000-0000-0000-000000000002'::uuid,
  '82000000-0000-0000-0000-000000000002'::uuid,
  'like'
);
create temporary table post_completion_pass on commit drop as
select * from pg_temp.record_swipe_result(
  '22000000-0000-0000-0000-000000000002'::uuid,
  '82000000-0000-0000-0000-000000000003'::uuid,
  'pass'
);
reset role;

select is((select status from second_finalize), 'already_completed', 'second finalization attempt is rejected');
select ok(
  (select status = 'already_completed' from winner_change_attempt)
  and (select winner_media_id = '82000000-0000-0000-0000-000000000002'::uuid from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000003'::uuid)),
  'winner cannot change after completion'
);
select isnt(
  pg_temp.try_reopen_pool_status('22000000-0000-0000-0000-000000000003'::uuid),
  'ok',
  'completed pool cannot reopen'
);
select is((select status from post_completion_like), 'pool_completed', 'completed pool rejects further likes');
select is((select status from post_completion_pass), 'pool_completed', 'completed pool rejects further passes');
select is(
  pg_temp.visible_swipe_count('22000000-0000-0000-0000-000000000002'::uuid),
  2,
  'rejected post-completion swipes create no swipe rows'
);
select is(
  pg_temp.visible_match_count('22000000-0000-0000-0000-000000000002'::uuid),
  1,
  'rejected post-completion swipes create no matches'
);


-- ---------------------------------------------------------------------------
-- Random finalization and race invariants.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001201', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table random_one on commit drop as
select * from pg_temp.finalize_pool_random_result('22000000-0000-0000-0000-000000000006'::uuid);
create temporary table random_multi on commit drop as
select * from pg_temp.finalize_pool_random_result('22000000-0000-0000-0000-000000000007'::uuid);
create temporary table race_manual on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000008'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
create temporary table race_random on commit drop as
select * from pg_temp.finalize_pool_random_result('22000000-0000-0000-0000-000000000008'::uuid);
create temporary table race_random_a on commit drop as
select * from pg_temp.finalize_pool_random_result('22000000-0000-0000-0000-000000000009'::uuid);
create temporary table race_manual_b on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000009'::uuid,
  '82000000-0000-0000-0000-000000000002'::uuid
);
reset role;

select ok(
  (select status = 'finalized' and media_id = '82000000-0000-0000-0000-000000000001'::uuid from random_one),
  'random finalization with one match selects it'
);
select ok(
  (select status = 'finalized' from random_multi)
  and exists (
    select 1
    from public.matches as m
    join random_multi as r on r.media_id = m.media_id
    where m.pool_id = '22000000-0000-0000-0000-000000000007'::uuid
  )
  and (select winner_media_id = media_id from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000007'::uuid), random_multi),
  'random finalization with multiple matches selects one valid current-pool match'
);
select ok(
  (select status = 'finalized' from race_manual)
  and (select status = 'already_completed' from race_random)
  and (select winner_media_id is not null from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000008'::uuid)),
  'random/manual race can produce only one winner'
);
select ok(
  (select status = 'finalized' from race_random_a)
  and (select status = 'already_completed' from race_manual_b)
  and (select winner_media_id is not null from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000009'::uuid)),
  'concurrent finalization attempts cannot produce two winners'
);


-- ---------------------------------------------------------------------------
-- Pool owner transfer.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001201', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select public.leave_group('12000000-0000-0000-0000-000000000001'::uuid);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001202', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table transferred_owner_finalize on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000010'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
create temporary table transferred_owner_plan on commit drop as
select pg_temp.set_planned_for_status(
  '22000000-0000-0000-0000-000000000011'::uuid,
  timestamp with time zone '2026-08-17 20:00:00+00'
) as status;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001201', true);
create temporary table old_creator_finalize_after_transfer on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000011'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
create temporary table old_creator_plan_after_transfer on commit drop as
select pg_temp.set_planned_for_status(
  '22000000-0000-0000-0000-000000000011'::uuid,
  timestamp with time zone '2026-08-18 20:00:00+00'
) as status;
reset role;

select ok(
  (select lookup_status = 'ok' and owner_id = '00000000-0000-0000-0000-000000001202'::uuid from pg_temp.pool_owner_state('22000000-0000-0000-0000-000000000010'::uuid)),
  'creator leaves and pool ownership transfers to the longest-standing current member'
);
select is((select status from transferred_owner_finalize), 'finalized', 'transferred owner can finalize');
select ok(
  (select status = 'not_a_member' from old_creator_finalize_after_transfer)
  and (select status = 'not_a_member' from old_creator_plan_after_transfer),
  'old creator cannot finalize or edit planned_for after transfer'
);
select is((select status from transferred_owner_plan), 'updated', 'transferred owner can edit planned_for');


-- ---------------------------------------------------------------------------
-- Post-completion planning, finalize-overrides-like and reads.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001202', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table reschedule_after_completion on commit drop as
select pg_temp.set_planned_for_status(
  '22000000-0000-0000-0000-000000000010'::uuid,
  timestamp with time zone '2026-08-19 21:00:00+00'
) as status;
reset role;

select is((select status from reschedule_after_completion), 'updated', 'creator can reschedule planned_for after completion');
select ok(
  (select status = 'completed' from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000010'::uuid)),
  'completed status remains completed after reschedule'
);
select ok(
  (select winner_media_id = '82000000-0000-0000-0000-000000000001'::uuid from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000010'::uuid)),
  'winner remains unchanged after reschedule'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001202', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table finalize_before_late_like on commit drop as
select * from pg_temp.finalize_pool_result(
  '22000000-0000-0000-0000-000000000011'::uuid,
  '82000000-0000-0000-0000-000000000001'::uuid
);
create temporary table late_like_after_finalize on commit drop as
select * from pg_temp.record_swipe_result(
  '22000000-0000-0000-0000-000000000011'::uuid,
  '82000000-0000-0000-0000-000000000002'::uuid,
  'like'
);
reset role;

select ok(
  (select status = 'finalized' from finalize_before_late_like)
  and (select status = 'pool_completed' from late_like_after_finalize)
  and (select winner_media_id = '82000000-0000-0000-0000-000000000001'::uuid from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000011'::uuid))
  and pg_temp.visible_match_count('22000000-0000-0000-0000-000000000011'::uuid) = 1,
  'finalization overrides a later like without persisting the late swipe or match'
);

-- Completion has to be immutable in BOTH directions. record_swipe already
-- refuses to add to a settled pool; undo deletes, so leaving it open would let
-- a member quietly remove the evidence behind a decision the group has already
-- made. The pass seeded in the fixtures is still undoable, so an unguarded
-- undo would really delete it here.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001202', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table undo_after_finalize on commit drop as
select * from pg_temp.undo_last_pass_result('22000000-0000-0000-0000-000000000011'::uuid);
reset role;

select ok(
  (select status = 'pool_completed' from undo_after_finalize)
  and pg_temp.visible_swipe_count('22000000-0000-0000-0000-000000000011'::uuid) = 1,
  'completed pool rejects undo and keeps the historical pass'
);

do $$
begin
  perform pg_temp.fixture_mark_finalized(
    '22000000-0000-0000-0000-000000000013'::uuid,
    '82000000-0000-0000-0000-000000000001'::uuid,
    timestamp with time zone '2026-08-20 21:00:00+00'
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001205', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table grace_final_state on commit drop as
select * from pg_temp.pool_winner_state('22000000-0000-0000-0000-000000000013'::uuid);
create temporary table grace_plan_state on commit drop as
select * from pg_temp.pool_planned_for_state('22000000-0000-0000-0000-000000000013'::uuid);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000001204', true);
create temporary table outsider_visible_final_pool on commit drop as
select pg_temp.visible_pool_row_count('22000000-0000-0000-0000-000000000013'::uuid) as count;
reset role;

select ok(
  public.group_access_state('12000000-0000-0000-0000-000000000003'::uuid) = 'grace'
  and (select lookup_status = 'ok' and status = 'completed' and winner_media_id = '82000000-0000-0000-0000-000000000001'::uuid from grace_final_state)
  and (select lookup_status = 'ok' and planned_for = timestamp with time zone '2026-08-20 21:00:00+00' from grace_plan_state),
  'grace preserves read access to completed pool winner and planned_for'
);
select is((select count from outsider_visible_final_pool), 0, 'outsider cannot read finalization state beyond existing pool RLS');

select * from finish();

rollback;
