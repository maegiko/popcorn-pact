-- Popcorn Pact: pool lifecycle status and latest-active recovery.
--
-- This is a black-box contract suite for how clients recover the pool a group
-- should resume from Home. The public read contract is a direct RLS-backed
-- SELECT against pools:
--
--   where group_id = :group_id
--     and status = 'active'
--   order by created_at desc
--   limit 1
--
-- There is deliberately no RPC in this slice. Pool rows are already readable to
-- members, writes remain trusted/backend-only, and several active pools may
-- coexist for one group.

set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(20);


-- ---------------------------------------------------------------------------
-- Test harness.
--
-- These helpers keep the suite reporting pgTAP failures before the lifecycle
-- column exists, rather than aborting at the first undefined-column error. They
-- still exercise only table behavior and the agreed direct SELECT lookup shape.
-- ---------------------------------------------------------------------------

create function pg_temp.visible_pool_status(p_pool_id uuid)
returns text
language plpgsql
as $$
declare
  v_status text;
begin
  execute 'select p.status from public.pools as p where p.id = $1'
  into v_status
  using p_pool_id;

  return v_status;
exception
  when undefined_column then return '__missing_status__';
  when insufficient_privilege then return '__permission_denied__';
end;
$$;

create function pg_temp.latest_active_pool(p_group_id uuid)
returns table (lookup_status text, pool_id uuid)
language plpgsql
as $$
declare
  v_pool_id uuid;
begin
  execute $query$
    select p.id
    from public.pools as p
    where p.group_id = $1
      and p.status = 'active'
    order by p.created_at desc
    limit 1
  $query$
  into v_pool_id
  using p_group_id;

  return query select 'ok'::text, v_pool_id;
exception
  when undefined_column then return query select '__missing_status__'::text, null::uuid;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::uuid;
end;
$$;

create function pg_temp.set_pool_status(p_pool_id uuid, p_status text)
returns text
language plpgsql
as $$
begin
  execute 'update public.pools set status = $1 where id = $2'
  using p_status, p_pool_id;

  return 'ok';
exception
  when undefined_column then return '__missing_status__';
  when check_violation then return '__check_violation__';
  when others then return '__error_' || sqlstate || '__';
end;
$$;

create function pg_temp.insert_pool_with_status(
  p_pool_id uuid,
  p_group_id uuid,
  p_created_by uuid,
  p_mode text,
  p_status text,
  p_created_at timestamptz
)
returns text
language plpgsql
as $$
begin
  execute $query$
    insert into public.pools (id, group_id, created_by, mode, status, created_at)
    values ($1, $2, $3, $4, $5, $6)
  $query$
  using p_pool_id, p_group_id, p_created_by, p_mode, p_status, p_created_at;

  return 'ok';
exception
  when undefined_column then return '__missing_status__';
  when check_violation then return '__check_violation__';
  when unique_violation then return '__unique_violation__';
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
    ('00000000-0000-0000-0000-000000000901'::uuid, 'user901@example.test', 'Lifecycle Owner'),
    ('00000000-0000-0000-0000-000000000902'::uuid, 'user902@example.test', 'Lifecycle Partner'),
    ('00000000-0000-0000-0000-000000000903'::uuid, 'user903@example.test', 'Lifecycle Stranger'),
    ('00000000-0000-0000-0000-000000000904'::uuid, 'user904@example.test', 'Recovery Owner'),
    ('00000000-0000-0000-0000-000000000905'::uuid, 'user905@example.test', 'Recovery Empty'),
    ('00000000-0000-0000-0000-000000000906'::uuid, 'user906@example.test', 'Grace Owner'),
    ('00000000-0000-0000-0000-000000000907'::uuid, 'user907@example.test', 'Grace Member A'),
    ('00000000-0000-0000-0000-000000000908'::uuid, 'user908@example.test', 'Grace Member B')
) as users(user_id, email, display_name);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000901', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table lifecycle_group on commit drop as select * from public.create_group();
create temporary table manual_pool on commit drop as
select * from public.create_pool((select group_id from lifecycle_group), 'manual');
create temporary table older_active_pool on commit drop as
select * from public.create_pool((select group_id from lifecycle_group), 'manual');
create temporary table newer_active_pool on commit drop as
select * from public.create_pool((select group_id from lifecycle_group), 'manual');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000902', true);
create temporary table lifecycle_partner_join on commit drop as
select * from public.join_group_with_invite((select invite_code from lifecycle_group));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000904', true);
create temporary table recovery_group on commit drop as select * from public.create_group();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000905', true);
create temporary table empty_group on commit drop as select * from public.create_group();

reset role;

insert into public.media (id, media_type, title)
values (
  '70000000-0000-0000-0000-000000000001'::uuid,
  'movie',
  'Lifecycle Generated Fixture'
);

insert into public.media_external_ids (media_id, media_type, provider, external_id)
values (
  '70000000-0000-0000-0000-000000000001'::uuid,
  'movie',
  'pgtap-pool-lifecycle',
  'generated-1'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000901', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table generated_pool on commit drop as
select * from public.create_generated_pool(
  (select group_id from lifecycle_group),
  $$[
    {
      "media_type": "movie",
      "title": "Lifecycle Generated Fixture",
      "external_ids": { "pgtap-pool-lifecycle": "generated-1" }
    }
  ]$$::jsonb
);

reset role;

update public.pools as p
set created_at = case p.id
  when (select pool_id from manual_pool) then timestamp with time zone '2026-08-13 08:00:00+00'
  when (select pool_id from generated_pool) then timestamp with time zone '2026-08-13 08:30:00+00'
  when (select pool_id from older_active_pool) then timestamp with time zone '2026-08-13 10:00:00+00'
  when (select pool_id from newer_active_pool) then timestamp with time zone '2026-08-13 11:00:00+00'
  else p.created_at
end
where p.id in (
  (select pool_id from manual_pool),
  (select pool_id from generated_pool),
  (select pool_id from older_active_pool),
  (select pool_id from newer_active_pool)
);


-- ---------------------------------------------------------------------------
-- Schema and lifecycle values.
-- ---------------------------------------------------------------------------

select has_column(
  'public',
  'pools',
  'status',
  'pools expose a lifecycle status'
);

select is(
  pg_temp.visible_pool_status((select pool_id from manual_pool)),
  'active',
  'newly created manual pool defaults to active'
);

select is(
  pg_temp.visible_pool_status((select pool_id from generated_pool)),
  'active',
  'newly created generated pool defaults to active'
);

insert into public.pools (id, group_id, created_by, mode, created_at)
values (
  '60000000-0000-0000-0000-000000000001'::uuid,
  (select group_id from lifecycle_group),
  '00000000-0000-0000-0000-000000000901'::uuid,
  'manual',
  timestamp with time zone '2026-08-13 09:00:00+00'
);

select is(
  pg_temp.visible_pool_status('60000000-0000-0000-0000-000000000001'::uuid),
  'active',
  'existing-style pool rows without status resolve to active'
);

select is(
  pg_temp.set_pool_status('60000000-0000-0000-0000-000000000001'::uuid, 'paused'),
  '__check_violation__',
  'invalid lifecycle values are rejected'
);

select is(
  pg_temp.set_pool_status('60000000-0000-0000-0000-000000000001'::uuid, 'completed'),
  'ok',
  'completed is a valid lifecycle value for privileged fixture updates'
);

select is(
  pg_temp.insert_pool_with_status(
    '60000000-0000-0000-0000-000000000002'::uuid,
    (select group_id from lifecycle_group),
    '00000000-0000-0000-0000-000000000901'::uuid,
    'manual',
    'completed',
    timestamp with time zone '2026-08-13 09:30:00+00'
  ),
  'ok',
  'completed is a valid lifecycle value for privileged fixture inserts'
);


-- ---------------------------------------------------------------------------
-- Multiple active pools.
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::integer
    from public.pools as p
    where p.group_id = (select group_id from lifecycle_group)
      and pg_temp.visible_pool_status(p.id) = 'active'
      and p.id in ((select pool_id from older_active_pool), (select pool_id from newer_active_pool))
  ),
  2,
  'two active pools may coexist in one group'
);

select ok(
  pg_temp.visible_pool_status((select pool_id from older_active_pool)) = 'active'
  and pg_temp.visible_pool_status((select pool_id from newer_active_pool)) = 'active',
  'creating a newer active pool does not mutate the older pool status'
);


-- ---------------------------------------------------------------------------
-- Recovery ordering.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000905', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table empty_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from empty_group));

reset role;

select ok(
  (select lookup_status = 'ok' from empty_recovery)
  and (select pool_id is null from empty_recovery),
  'no pools yields no active pool'
);

insert into public.pools (id, group_id, created_by, mode, created_at)
values (
  '60000000-0000-0000-0000-000000000101'::uuid,
  (select group_id from recovery_group),
  '00000000-0000-0000-0000-000000000904'::uuid,
  'manual',
  timestamp with time zone '2026-08-13 10:00:00+00'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000904', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table one_active_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from recovery_group));

reset role;

select ok(
  (select lookup_status = 'ok' from one_active_recovery)
  and (select pool_id = '60000000-0000-0000-0000-000000000101'::uuid from one_active_recovery),
  'one active pool is recoverable'
);

-- A DO block, not a bare SELECT: pg_temp.insert_pool_with_status() returns the
-- literal text 'ok' on the success path, and a bare top-level SELECT prints
-- that return value as its own output row. Piped through the pgTAP/prove
-- harness, a lone "ok" line is indistinguishable from a TAP result line and
-- desynchronizes the declared plan(20). PERFORM runs the same call for its
-- side effect and discards the return value, so nothing is printed. The
-- fixture is not asserted on here; the assertion is the recovery lookup below.
do $$
begin
  perform pg_temp.insert_pool_with_status(
    '60000000-0000-0000-0000-000000000102'::uuid,
    (select group_id from recovery_group),
    '00000000-0000-0000-0000-000000000904'::uuid,
    'manual',
    'active',
    timestamp with time zone '2026-08-13 11:00:00+00'
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000904', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table two_active_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from recovery_group));

reset role;

select ok(
  (select lookup_status = 'ok' from two_active_recovery)
  and (select pool_id = '60000000-0000-0000-0000-000000000102'::uuid from two_active_recovery),
  'newest of two active pools is selected'
);

-- See the earlier comment on this pattern: PERFORM inside a DO block runs the
-- fixture write without printing its 'ok' return value into the TAP stream.
do $$
begin
  perform pg_temp.insert_pool_with_status(
    '60000000-0000-0000-0000-000000000103'::uuid,
    (select group_id from recovery_group),
    '00000000-0000-0000-0000-000000000904'::uuid,
    'manual',
    'completed',
    timestamp with time zone '2026-08-13 12:00:00+00'
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000904', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table completed_after_active_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from recovery_group));

reset role;

select ok(
  (select lookup_status = 'ok' from completed_after_active_recovery)
  and (select pool_id = '60000000-0000-0000-0000-000000000102'::uuid from completed_after_active_recovery),
  'newest completed pool is ignored when an older active pool exists'
);

-- See the earlier comment on this pattern: PERFORM inside a DO block runs the
-- fixture write without printing its 'ok' return value into the TAP stream.
do $$
begin
  perform pg_temp.set_pool_status('60000000-0000-0000-0000-000000000101'::uuid, 'completed');
  perform pg_temp.set_pool_status('60000000-0000-0000-0000-000000000102'::uuid, 'completed');
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000904', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table completed_only_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from recovery_group));

reset role;

select ok(
  (select lookup_status = 'ok' from completed_only_recovery)
  and (select pool_id is null from completed_only_recovery),
  'completed-only history yields no active pool'
);

-- See the earlier comment on this pattern: PERFORM inside a DO block runs the
-- fixture write without printing its 'ok' return value into the TAP stream.
do $$
begin
  perform pg_temp.set_pool_status('60000000-0000-0000-0000-000000000102'::uuid, 'active');

  perform pg_temp.insert_pool_with_status(
    '60000000-0000-0000-0000-000000000104'::uuid,
    (select group_id from recovery_group),
    '00000000-0000-0000-0000-000000000904'::uuid,
    'manual',
    'completed',
    timestamp with time zone '2026-08-13 13:00:00+00'
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000904', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table surrounded_active_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from recovery_group));

reset role;

select ok(
  (select lookup_status = 'ok' from surrounded_active_recovery)
  and (select pool_id = '60000000-0000-0000-0000-000000000102'::uuid from surrounded_active_recovery),
  'newest active is selected when completed pools exist before and after it'
);


-- ---------------------------------------------------------------------------
-- Isolation, RLS and grace reads.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000901', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table member_group_scoped_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from lifecycle_group));
create temporary table member_other_group_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from recovery_group));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000903', true);
create temporary table stranger_recovery on commit drop as
select * from pg_temp.latest_active_pool((select group_id from lifecycle_group));

reset role;

select ok(
  (select lookup_status = 'ok' from member_group_scoped_recovery)
  and (select pool_id = (select pool_id from newer_active_pool) from member_group_scoped_recovery),
  'active pool lookup is group-scoped'
);

select ok(
  (select lookup_status = 'ok' from member_other_group_recovery)
  and (select pool_id is null from member_other_group_recovery),
  'member cannot recover another group''s pool'
);

select ok(
  (select lookup_status = 'ok' from stranger_recovery)
  and (select pool_id is null from stranger_recovery),
  'unrelated user sees no active pool from that group'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000903', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table stranger_status_read on commit drop as
select pg_temp.visible_pool_status((select pool_id from newer_active_pool)) as status;

reset role;

select ok(
  (select status is null from stranger_status_read),
  'lifecycle status does not weaken existing pool RLS'
);

insert into public.groups (id, created_by)
values (
  '10000000-0000-0000-0000-000000000901'::uuid,
  '00000000-0000-0000-0000-000000000906'::uuid
);

insert into public.group_members (group_id, user_id, joined_at)
values
  (
    '10000000-0000-0000-0000-000000000901'::uuid,
    '00000000-0000-0000-0000-000000000906'::uuid,
    timestamp with time zone '2026-08-13 10:00:00+00'
  ),
  (
    '10000000-0000-0000-0000-000000000901'::uuid,
    '00000000-0000-0000-0000-000000000907'::uuid,
    timestamp with time zone '2026-08-13 10:01:00+00'
  ),
  (
    '10000000-0000-0000-0000-000000000901'::uuid,
    '00000000-0000-0000-0000-000000000908'::uuid,
    timestamp with time zone '2026-08-13 10:02:00+00'
  );

insert into public.pools (id, group_id, created_by, mode, created_at)
values (
  '60000000-0000-0000-0000-000000000901'::uuid,
  '10000000-0000-0000-0000-000000000901'::uuid,
  '00000000-0000-0000-0000-000000000906'::uuid,
  'manual',
  timestamp with time zone '2026-08-13 10:03:00+00'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000906', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table grace_recovery on commit drop as
select * from pg_temp.latest_active_pool('10000000-0000-0000-0000-000000000901'::uuid);

reset role;

select ok(
  public.group_access_state('10000000-0000-0000-0000-000000000901'::uuid) = 'grace'
  and (select lookup_status = 'ok' from grace_recovery)
  and (select pool_id = '60000000-0000-0000-0000-000000000901'::uuid from grace_recovery),
  'grace-state member can still recover the active pool'
);

select * from finish();

rollback;
