-- Popcorn Pact: pool-scoped swipe persistence.
--
-- This is a black-box contract suite for the public swipe operations. Swipes
-- belong to a pool, a user and a canonical media row; they are private raw
-- decisions, not group-visible social activity. Match detection can later read
-- them through trusted backend logic, but clients should only see their own.

set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(49);

-- ---------------------------------------------------------------------------
-- Test harness.
--
-- These wrappers let the suite fail as pgTAP assertions before the production
-- swipes table/RPCs exist, rather than aborting at the first undefined object.
-- They still exercise only the public API and client-visible table behavior.
-- ---------------------------------------------------------------------------

create function pg_temp.record_swipe_status(p_pool_id uuid, p_media_id uuid, p_decision text)
returns text
language plpgsql
as $$
declare
  v_status text;
begin
  execute 'select status from public.record_swipe($1, $2, $3)'
  into v_status
  using p_pool_id, p_media_id, p_decision;

  return v_status;
exception
  when undefined_function then return '__missing_function__';
  when insufficient_privilege then return '__permission_denied__';
  when others then return '__error_' || sqlstate || '__';
end;
$$;

create function pg_temp.undo_last_pass_result(p_pool_id uuid)
returns table (status text, media_id uuid)
language plpgsql
as $$
begin
  return query execute 'select status, media_id from public.undo_last_pass($1)' using p_pool_id;
exception
  when undefined_function then return query select '__missing_function__'::text, null::uuid;
  when insufficient_privilege then return query select '__permission_denied__'::text, null::uuid;
  when others then return query select ('__error_' || sqlstate || '__')::text, null::uuid;
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

create function pg_temp.visible_swipe_count_exact(
  p_pool_id uuid,
  p_group_id uuid,
  p_user_id uuid,
  p_media_id uuid,
  p_decision text
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
    where s.pool_id = $1
      and s.group_id = $2
      and s.user_id = $3
      and s.media_id = $4
      and s.decision = $5
  $query$
  into v_count
  using p_pool_id, p_group_id, p_user_id, p_media_id, p_decision;

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
  $query$
  using p_pool_id, p_group_id, p_user_id, p_media_id, p_decision;
exception
  when undefined_table or undefined_column then return;
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
    ('00000000-0000-0000-0000-000000000701'::uuid, 'user701@example.test', 'Swipe Owner'),
    ('00000000-0000-0000-0000-000000000702'::uuid, 'user702@example.test', 'Swipe Partner'),
    ('00000000-0000-0000-0000-000000000703'::uuid, 'user703@example.test', 'Swipe Stranger'),
    ('00000000-0000-0000-0000-000000000704'::uuid, 'user704@example.test', 'Grace Owner'),
    ('00000000-0000-0000-0000-000000000705'::uuid, 'user705@example.test', 'Grace Member A'),
    ('00000000-0000-0000-0000-000000000706'::uuid, 'user706@example.test', 'Grace Member B')
) as users(user_id, email, display_name);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table swipe_group on commit drop as select * from public.create_group();
create temporary table swipe_pool_one on commit drop as
select * from public.create_pool((select group_id from swipe_group), 'manual');
create temporary table swipe_pool_two on commit drop as
select * from public.create_pool((select group_id from swipe_group), 'manual');
-- A pool of its own for the immediate-only undo scenarios, so they can run a
-- long sequence of decisions without disturbing the assertions above.
create temporary table swipe_pool_three on commit drop as
select * from public.create_pool((select group_id from swipe_group), 'manual');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000702', true);
create temporary table swipe_partner_join on commit drop as
select * from public.join_group_with_invite((select invite_code from swipe_group));

reset role;

insert into public.media (id, media_type, title)
values
  ('50000000-0000-0000-0000-000000000001'::uuid, 'movie', 'Swipe Movie A'),
  ('50000000-0000-0000-0000-000000000002'::uuid, 'movie', 'Swipe Movie B'),
  ('50000000-0000-0000-0000-000000000003'::uuid, 'tv', 'Swipe Series C'),
  ('50000000-0000-0000-0000-000000000004'::uuid, 'movie', 'Not In Pool');

insert into public.media_external_ids (media_id, media_type, provider, external_id)
values
  ('50000000-0000-0000-0000-000000000001'::uuid, 'movie', 'pgtap-swipes', 'a'),
  ('50000000-0000-0000-0000-000000000002'::uuid, 'movie', 'pgtap-swipes', 'b'),
  ('50000000-0000-0000-0000-000000000003'::uuid, 'tv', 'pgtap-swipes', 'c'),
  ('50000000-0000-0000-0000-000000000004'::uuid, 'movie', 'pgtap-swipes', 'outside');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table add_a_to_pool_one on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000001'::uuid
);
create temporary table add_b_to_pool_one on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000002'::uuid
);
create temporary table add_c_to_pool_one on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000003'::uuid
);
create temporary table add_a_to_pool_two on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_two),
  '50000000-0000-0000-0000-000000000001'::uuid
);
create temporary table add_b_to_pool_two on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_two),
  '50000000-0000-0000-0000-000000000002'::uuid
);
create temporary table add_c_to_pool_two on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_two),
  '50000000-0000-0000-0000-000000000003'::uuid
);
create temporary table add_a_to_pool_three on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000001'::uuid
);
create temporary table add_b_to_pool_three on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000002'::uuid
);
create temporary table add_c_to_pool_three on commit drop as
select * from public.add_pool_title(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000003'::uuid
);
reset role;

insert into public.groups (id, created_by)
values (
  '10000000-0000-0000-0000-000000000701'::uuid,
  '00000000-0000-0000-0000-000000000704'::uuid
);

insert into public.group_members (group_id, user_id, joined_at)
values
  ('10000000-0000-0000-0000-000000000701'::uuid, '00000000-0000-0000-0000-000000000704'::uuid, now()),
  ('10000000-0000-0000-0000-000000000701'::uuid, '00000000-0000-0000-0000-000000000705'::uuid, now() + interval '1 second'),
  ('10000000-0000-0000-0000-000000000701'::uuid, '00000000-0000-0000-0000-000000000706'::uuid, now() + interval '2 seconds');

insert into public.pools (id, group_id, created_by, mode)
values (
  '20000000-0000-0000-0000-000000000701'::uuid,
  '10000000-0000-0000-0000-000000000701'::uuid,
  '00000000-0000-0000-0000-000000000704'::uuid,
  'manual'
);

insert into public.pool_titles (pool_id, media_id)
values
  ('20000000-0000-0000-0000-000000000701'::uuid, '50000000-0000-0000-0000-000000000001'::uuid),
  ('20000000-0000-0000-0000-000000000701'::uuid, '50000000-0000-0000-0000-000000000002'::uuid);

select pg_temp.seed_swipe(
  '20000000-0000-0000-0000-000000000701'::uuid,
  '10000000-0000-0000-0000-000000000701'::uuid,
  '00000000-0000-0000-0000-000000000705'::uuid,
  '50000000-0000-0000-0000-000000000001'::uuid,
  'pass'
);
select pg_temp.seed_swipe(
  '20000000-0000-0000-0000-000000000701'::uuid,
  '10000000-0000-0000-0000-000000000701'::uuid,
  '00000000-0000-0000-0000-000000000706'::uuid,
  '50000000-0000-0000-0000-000000000002'::uuid,
  'like'
);


-- ---------------------------------------------------------------------------
-- Public surface.
-- ---------------------------------------------------------------------------

select has_table('public', 'swipes', 'swipes are persisted in a public table with RLS');
select has_function(
  'public',
  'record_swipe',
  array['uuid', 'uuid', 'text'],
  'record_swipe(pool_id, media_id, decision) is the public write operation'
);
select has_function(
  'public',
  'undo_last_pass',
  array['uuid'],
  'undo_last_pass(pool_id) is the public undo operation'
);


-- ---------------------------------------------------------------------------
-- Creation and pool-scoped identity.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

create temporary table owner_like_a on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'like'
) as status;

select ok(
  (select status = 'recorded' from owner_like_a)
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'like'
  ) = 1,
  'member can like media in a pool'
);

select is(
  pg_temp.visible_swipe_count_exact(
    (select pool_id from swipe_pool_one),
    (select group_id from swipe_group),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'like'
  ),
  1,
  'persisted swipe row records pool, group, caller, media and decision'
);

create temporary table owner_pass_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'pass'
) as status;

select ok(
  (select status = 'recorded' from owner_pass_b)
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000002'::uuid,
    'pass'
  ) = 1,
  'member can pass media in a pool'
);

create temporary table owner_pool_two_pass_a on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_two),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'pass'
) as status;

select ok(
  (select status = 'recorded' from owner_pool_two_pass_a)
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'like'
  ) = 1
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_two),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'pass'
  ) = 1,
  'same user and media may have different verdicts in different pools'
);


-- ---------------------------------------------------------------------------
-- Idempotency and final verdicts.
-- ---------------------------------------------------------------------------

create temporary table duplicate_like_a on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'like'
) as status;

select is(
  (select status from duplicate_like_a),
  'already_recorded',
  'duplicate like returns already_recorded'
);

select is(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    null
  ),
  1,
  'duplicate like does not create a second swipe row'
);

create temporary table duplicate_pass_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'pass'
) as status;

select is(
  (select status from duplicate_pass_b),
  'already_recorded',
  'duplicate pass returns already_recorded'
);

select is(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000002'::uuid,
    null
  ),
  1,
  'duplicate pass does not create a second swipe row'
);

create temporary table pass_after_like_a on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'pass'
) as status;

select is(
  (select status from pass_after_like_a),
  'like_final',
  'a like cannot be overwritten by a pass'
);

select is(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'like'
  ),
  1,
  'like remains after attempted pass'
);

create temporary table like_after_pass_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'like'
) as status;

select is(
  (select status from like_after_pass_b),
  'pass_must_be_undone',
  'a pass cannot be overwritten by a like without explicit undo'
);

select is(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000002'::uuid,
    'pass'
  ),
  1,
  'pass remains after attempted like'
);

create temporary table owner_pool_one_like_c on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000003'::uuid,
  'like'
) as status;
create temporary table undo_after_like on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_one));

select is(
  (select status from undo_after_like),
  'nothing_to_undo',
  'explicit undo cannot remove a like'
);

select is(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000003'::uuid,
    'like'
  ),
  1,
  'like remains after explicit undo attempt'
);


-- ---------------------------------------------------------------------------
-- Undo is pool-local, pass-only and deterministic.
-- ---------------------------------------------------------------------------

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000702', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

create temporary table partner_pass_a on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'pass'
) as status;
create temporary table partner_pass_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'pass'
) as status;
create temporary table partner_undo_two_passes on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_one));

select ok(
  (select status = 'undone' from partner_undo_two_passes)
  and (select media_id = '50000000-0000-0000-0000-000000000002'::uuid from partner_undo_two_passes),
  'undo removes the most recent pass in that pool'
);

select ok(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000702'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'pass'
  ) = 1
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000702'::uuid,
    '50000000-0000-0000-0000-000000000002'::uuid,
    null
  ) = 0,
  'older pass remains after undo removes the later pass'
);

create temporary table partner_like_b_after_undo on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'like'
) as status;
create temporary table partner_undo_after_like on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_one));

select is(
  (select status from partner_undo_after_like),
  'nothing_to_undo',
  'if the most recent swipe is a like, undo does not remove an older pass'
);

select ok(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000702'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'pass'
  ) = 1
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000702'::uuid,
    '50000000-0000-0000-0000-000000000002'::uuid,
    'like'
  ) = 1,
  'pass A then like B then undo leaves both verdicts intact'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

create temporary table owner_pool_two_undo_single on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_two));

select ok(
  (select status = 'undone' from owner_pool_two_undo_single)
  and (select media_id = '50000000-0000-0000-0000-000000000001'::uuid from owner_pool_two_undo_single),
  'single pass can be undone in its pool'
);

select is(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_two),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    null
  ),
  0,
  'undo removes the pass row and returns the title to unresolved'
);

create temporary table owner_pool_two_like_a_after_undo on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_two),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'like'
) as status;

select ok(
  (select status = 'recorded' from owner_pool_two_like_a_after_undo)
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_two),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'like'
  ) = 1,
  'after undo, the same title can be liked normally'
);

create temporary table owner_pool_two_pass_b_for_repass on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_two),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'pass'
) as status;
create temporary table owner_pool_two_undo_b_for_repass on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_two));
create temporary table owner_pool_two_repass_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_two),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'pass'
) as status;

select ok(
  (select status = 'recorded' from owner_pool_two_repass_b)
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_two),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000002'::uuid,
    'pass'
  ) = 1,
  'after undo, the same title can be passed again normally'
);


-- ---------------------------------------------------------------------------
-- Undo is immediate-only.
--
-- Undo reverses the decision the member is still looking at, and nothing older.
-- Once any further decision is recorded in that pool the earlier pass is
-- settled: no later undo can reach it, and undoing the newer decision does not
-- hand eligibility back to it. Retries that say nothing new -- a duplicate tap,
-- a transition the rules reject -- must not consume it either.
--
-- All of this runs in pool three, so the sequence is readable on its own.
-- ---------------------------------------------------------------------------

create temporary table p3_pass_a on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'pass'
) as status;
create temporary table p3_pass_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'pass'
) as status;
create temporary table p3_undo_first on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_three));
create temporary table p3_undo_second on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_three));

select ok(
  (select status = 'undone' from p3_undo_first)
  and (select media_id = '50000000-0000-0000-0000-000000000002'::uuid from p3_undo_first),
  'undo reverses the pass just made'
);

select is(
  (select status from p3_undo_second),
  'nothing_to_undo',
  'a second undo cannot reach the pass made before it'
);

select ok(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_three),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'pass'
  ) = 1
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_three),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000002'::uuid,
    null
  ) = 0,
  'the older pass survives both undo attempts and the undone pass stays gone'
);

create temporary table p3_repass_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'pass'
) as status;
create temporary table p3_undo_repass on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_three));
create temporary table p3_undo_after_repass on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_three));

select ok(
  (select status = 'undone' from p3_undo_repass)
  and (select media_id = '50000000-0000-0000-0000-000000000002'::uuid from p3_undo_repass),
  'a fresh pass on a previously undone title is undoable in its own right'
);

select ok(
  (select status = 'nothing_to_undo' from p3_undo_after_repass)
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_three),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'pass'
  ) = 1,
  'undoing the newer pass does not restore eligibility to the older one'
);

create temporary table p3_pass_c on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000003'::uuid,
  'pass'
) as status;
create temporary table p3_duplicate_pass_c on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000003'::uuid,
  'pass'
) as status;
create temporary table p3_undo_after_duplicate_pass on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_three));

select ok(
  (select status = 'already_recorded' from p3_duplicate_pass_c)
  and (select status = 'undone' from p3_undo_after_duplicate_pass)
  and (select media_id = '50000000-0000-0000-0000-000000000003'::uuid
       from p3_undo_after_duplicate_pass),
  'a duplicate pass retry does not consume undo eligibility'
);

create temporary table p3_repass_c on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000003'::uuid,
  'pass'
) as status;
create temporary table p3_rejected_like_c on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000003'::uuid,
  'like'
) as status;
create temporary table p3_undo_after_rejected_like on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_three));

select ok(
  (select status = 'pass_must_be_undone' from p3_rejected_like_c)
  and (select status = 'undone' from p3_undo_after_rejected_like)
  and (select media_id = '50000000-0000-0000-0000-000000000003'::uuid
       from p3_undo_after_rejected_like),
  'a rejected like on a passed title does not consume undo eligibility'
);

create temporary table p3_like_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'like'
) as status;
create temporary table p3_pass_c_again on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000003'::uuid,
  'pass'
) as status;
create temporary table p3_duplicate_like_b on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_three),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'like'
) as status;
create temporary table p3_undo_after_duplicate_like on commit drop as
select * from pg_temp.undo_last_pass_result((select pool_id from swipe_pool_three));

select ok(
  (select status = 'already_recorded' from p3_duplicate_like_b)
  and (select status = 'undone' from p3_undo_after_duplicate_like)
  and (select media_id = '50000000-0000-0000-0000-000000000003'::uuid
       from p3_undo_after_duplicate_like),
  'a duplicate like retry does not consume undo eligibility'
);


-- ---------------------------------------------------------------------------
-- Security, validity and private raw rows.
-- ---------------------------------------------------------------------------

create temporary table invalid_decision on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000003'::uuid,
  'maybe'
) as status;

select is(
  (select status from invalid_decision),
  'invalid_decision',
  'decision must be like or pass'
);

select is(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    '50000000-0000-0000-0000-000000000003'::uuid,
    'maybe'
  ),
  0,
  'invalid decision creates no swipe row'
);

create temporary table media_not_in_pool on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_two),
  '50000000-0000-0000-0000-000000000004'::uuid,
  'like'
) as status;

select is(
  (select status from media_not_in_pool),
  'media_not_in_pool',
  'users cannot swipe media that is not in the pool'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000703', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

create temporary table stranger_swipe_attempt on commit drop as
select pg_temp.record_swipe_status(
  (select pool_id from swipe_pool_one),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'like'
) as status;

select is(
  (select status from stranger_swipe_attempt),
  'not_a_member',
  'nonmember cannot swipe a pool'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    null,
    null
  ) > 0
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000702'::uuid,
    null,
    null
  ) = 0,
  'raw swipes are private: partner rows are not visible to the owner'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000702', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000702'::uuid,
    null,
    null
  ) > 0
  and pg_temp.visible_swipe_count(
    (select pool_id from swipe_pool_one),
    '00000000-0000-0000-0000-000000000701'::uuid,
    null,
    null
  ) = 0,
  'raw swipes are private: owner rows are not visible to the partner'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000703', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is(
  pg_temp.visible_swipe_count((select pool_id from swipe_pool_one), null, null, null),
  0,
  'unrelated user cannot read another group''s swipes'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select throws_ok(
  $$
    insert into public.swipes (pool_id, group_id, user_id, media_id, decision)
    values (
      (select pool_id from swipe_pool_one),
      (select group_id from swipe_group),
      '00000000-0000-0000-0000-000000000701'::uuid,
      '50000000-0000-0000-0000-000000000001'::uuid,
      'like'
    )
  $$,
  '42501',
  null,
  'authenticated clients cannot directly insert swipes'
);

select throws_ok(
  $$
    update public.swipes
    set decision = 'pass'
    where pool_id = (select pool_id from swipe_pool_one)
  $$,
  '42501',
  null,
  'authenticated clients cannot directly update swipes'
);

select throws_ok(
  $$
    delete from public.swipes
    where pool_id = (select pool_id from swipe_pool_one)
  $$,
  '42501',
  null,
  'authenticated clients cannot directly delete swipes'
);


-- The pool/group invariant belongs to the database, not to the RPC that happens
-- to maintain it. Asserted as a privileged writer -- the one identity that could
-- otherwise insert a swipe whose group disagrees with its pool's -- because a
-- client is already stopped by privileges long before a constraint is consulted.
reset role;

select throws_ok(
  $$
    insert into public.swipes (pool_id, group_id, user_id, media_id, decision)
    values (
      (select pool_id from swipe_pool_one),
      '10000000-0000-0000-0000-000000000701'::uuid,
      '00000000-0000-0000-0000-000000000703'::uuid,
      '50000000-0000-0000-0000-000000000003'::uuid,
      'like'
    )
  $$,
  '23503',
  null,
  'a swipe cannot claim a group other than its pool''s'
);


-- ---------------------------------------------------------------------------
-- Grace keeps existing private rows readable, but blocks new swipe mutations.
-- ---------------------------------------------------------------------------

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000705', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is(
  pg_temp.visible_swipe_count(
    '20000000-0000-0000-0000-000000000701'::uuid,
    '00000000-0000-0000-0000-000000000705'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'pass'
  ),
  1,
  'user can still read their own existing swipes while group is in grace'
);

select is(
  pg_temp.visible_swipe_count(
    '20000000-0000-0000-0000-000000000701'::uuid,
    '00000000-0000-0000-0000-000000000706'::uuid,
    null,
    null
  ),
  0,
  'grace does not make another member''s raw swipes visible'
);

create temporary table grace_record_attempt on commit drop as
select pg_temp.record_swipe_status(
  '20000000-0000-0000-0000-000000000701'::uuid,
  '50000000-0000-0000-0000-000000000002'::uuid,
  'pass'
) as status;

select is(
  (select status from grace_record_attempt),
  'group_in_grace',
  'swipe creation is blocked while the group is in grace'
);

create temporary table grace_undo_attempt on commit drop as
select * from pg_temp.undo_last_pass_result('20000000-0000-0000-0000-000000000701'::uuid);

select is(
  (select status from grace_undo_attempt),
  'group_in_grace',
  'undo is blocked while the group is in grace'
);

select is(
  pg_temp.visible_swipe_count(
    '20000000-0000-0000-0000-000000000701'::uuid,
    '00000000-0000-0000-0000-000000000705'::uuid,
    '50000000-0000-0000-0000-000000000001'::uuid,
    'pass'
  ),
  1,
  'blocked grace undo leaves the existing pass row intact'
);

reset role;

select * from finish();

rollback;
