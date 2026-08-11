set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(17);

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
    ('00000000-0000-0000-0000-000000000101'::uuid, 'user101@example.test', 'User 101'),
    ('00000000-0000-0000-0000-000000000102'::uuid, 'user102@example.test', 'User 102'),
    ('00000000-0000-0000-0000-000000000103'::uuid, 'user103@example.test', 'User 103'),
    ('00000000-0000-0000-0000-000000000104'::uuid, 'user104@example.test', 'User 104'),
    ('00000000-0000-0000-0000-000000000105'::uuid, 'user105@example.test', 'User 105'),
    ('00000000-0000-0000-0000-000000000106'::uuid, 'user106@example.test', 'User 106'),
    ('00000000-0000-0000-0000-000000000107'::uuid, 'user107@example.test', 'User 107'),
    ('00000000-0000-0000-0000-000000000108'::uuid, 'user108@example.test', 'User 108'),
    ('00000000-0000-0000-0000-000000000109'::uuid, 'user109@example.test', 'User 109'),
    ('00000000-0000-0000-0000-000000000110'::uuid, 'user110@example.test', 'User 110'),
    ('00000000-0000-0000-0000-000000000111'::uuid, 'user111@example.test', 'User 111'),
    ('00000000-0000-0000-0000-000000000112'::uuid, 'user112@example.test', 'User 112'),
    ('00000000-0000-0000-0000-000000000113'::uuid, 'user113@example.test', 'User 113'),
    ('00000000-0000-0000-0000-000000000114'::uuid, 'user114@example.test', 'User 114'),
    ('00000000-0000-0000-0000-000000000115'::uuid, 'user115@example.test', 'User 115'),
    ('00000000-0000-0000-0000-000000000116'::uuid, 'user116@example.test', 'User 116'),
    ('00000000-0000-0000-0000-000000000117'::uuid, 'user117@example.test', 'User 117'),
    ('00000000-0000-0000-0000-000000000118'::uuid, 'user118@example.test', 'User 118'),
    ('00000000-0000-0000-0000-000000000119'::uuid, 'user119@example.test', 'User 119'),
    ('00000000-0000-0000-0000-000000000120'::uuid, 'user120@example.test', 'User 120'),
    ('00000000-0000-0000-0000-000000000121'::uuid, 'user121@example.test', 'User 121'),
    ('00000000-0000-0000-0000-000000000122'::uuid, 'user122@example.test', 'User 122'),
    ('00000000-0000-0000-0000-000000000123'::uuid, 'user123@example.test', 'User 123'),
    ('00000000-0000-0000-0000-000000000124'::uuid, 'user124@example.test', 'User 124'),
    ('00000000-0000-0000-0000-000000000125'::uuid, 'user125@example.test', 'User 125'),
    ('00000000-0000-0000-0000-000000000126'::uuid, 'user126@example.test', 'User 126')
) as users(user_id, email, display_name);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table owner_group on commit drop as select * from public.create_group();

reset role;

select ok(
  exists (
    select 1
    from public.group_members as gm
    join owner_group as og on og.group_id = gm.group_id
    where gm.user_id = '00000000-0000-0000-0000-000000000101'::uuid
  ),
  'creating a group makes the caller the first member'
);

select is(
  (select g.created_by from public.groups as g join owner_group as og on og.group_id = g.id),
  '00000000-0000-0000-0000-000000000101'::uuid,
  'creating a group sets the caller as owner'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table second_group_attempt on commit drop as select * from public.create_group();

reset role;

select is(
  (select status from second_group_attempt),
  'group_limit_reached',
  'free user cannot create a second group'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table valid_join_group on commit drop as select * from public.create_group();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000103', true);
create temporary table valid_join_result on commit drop as
select * from public.join_group_with_invite((select invite_code from valid_join_group));

reset role;

select ok(
  (select status = 'joined' from valid_join_result)
  and exists (
    select 1
    from public.group_members as gm
    join valid_join_group as vg on vg.group_id = gm.group_id
    where gm.user_id = '00000000-0000-0000-0000-000000000103'::uuid
  ),
  'second user can join with a valid invite'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000104', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table already_member_group on commit drop as select * from public.create_group();
create temporary table already_member_result on commit drop as
select * from public.join_group_with_invite((select invite_code from already_member_group));

reset role;

select is(
  (select status from already_member_result),
  'already_member',
  'same user joining twice returns already_member'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000105', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table full_group on commit drop as select * from public.create_group();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000106', true);
create temporary table full_group_second_join on commit drop as
select * from public.join_group_with_invite((select invite_code from full_group));

reset role;

insert into public.group_invites (group_id, code, created_by, expires_at)
select group_id, 'A1B2C3D4', '00000000-0000-0000-0000-000000000105'::uuid, now() + interval '7 days'
from full_group;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000107', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table third_join_result on commit drop as select * from public.join_group_with_invite('A1B2C3D4');

reset role;

select is(
  (select status from third_join_result),
  'group_full',
  'third user is blocked when member limit is 2'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000108', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table invalid_invite_result on commit drop as select * from public.join_group_with_invite('ZZZZZZZZ');

reset role;

select is(
  (select status from invalid_invite_result),
  'invalid_code',
  'invalid invite returns invalid_code'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000109', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table expired_group on commit drop as select * from public.create_group();

reset role;

update public.group_invites as gi
set expires_at = now() - interval '1 second'
from expired_group as eg
where gi.code = eg.invite_code;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000110', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table expired_invite_result on commit drop as
select * from public.join_group_with_invite((select invite_code from expired_group));

reset role;

select is(
  (select status from expired_invite_result),
  'expired',
  'expired invite returns expired'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table consumed_group on commit drop as select * from public.create_group();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000112', true);
create temporary table consumed_first_join on commit drop as
select * from public.join_group_with_invite((select invite_code from consumed_group));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000113', true);
create temporary table consumed_reuse_result on commit drop as
select * from public.join_group_with_invite((select invite_code from consumed_group));

reset role;

select is(
  (select status from consumed_reuse_result),
  'invalid_code',
  'consumed invite cannot be reused'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000114', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table revoked_group on commit drop as select * from public.create_group();

reset role;

update public.group_invites as gi
set revoked_at = now()
from revoked_group as rg
where gi.code = rg.invite_code;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000115', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table revoked_invite_result on commit drop as
select * from public.join_group_with_invite((select invite_code from revoked_group));

reset role;

select is(
  (select status from revoked_invite_result),
  'invalid_code',
  'revoked invite cannot be reused'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000116', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table reinvite_group on commit drop as select * from public.create_group();
create temporary table reinvite_result on commit drop as
select * from public.create_group_invite((select group_id from reinvite_group));

reset role;

select ok(
  exists (
    select 1
    from public.group_invites as gi
    join reinvite_group as rg on rg.group_id = gi.group_id
    where gi.code = rg.invite_code
      and gi.revoked_at is not null
  )
  and exists (
    select 1
    from public.group_invites as gi
    join reinvite_group as rg on rg.group_id = gi.group_id
    join reinvite_result as rr on rr.code = gi.code
    where gi.consumed_at is null
      and gi.revoked_at is null
  ),
  'creating a new invite revokes the old live invite'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000117', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table normalized_group on commit drop as select * from public.create_group();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000118', true);
create temporary table normalized_join_result on commit drop as
select *
from public.join_group_with_invite(
  lower(
    substr((select invite_code from normalized_group), 1, 4)
    || ' - '
    || substr((select invite_code from normalized_group), 5, 4)
  )
);

reset role;

select is(
  (select status from normalized_join_result),
  'joined',
  'invite-code normalization works for lowercase/spaces/dashes'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000119', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table leave_group_case on commit drop as select * from public.create_group();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000120', true);
create temporary table leave_join_result on commit drop as
select * from public.join_group_with_invite((select invite_code from leave_group_case));
select public.leave_group((select group_id from leave_group_case));

reset role;

select ok(
  not exists (
    select 1
    from public.group_members as gm
    join leave_group_case as lg on lg.group_id = gm.group_id
    where gm.user_id = '00000000-0000-0000-0000-000000000120'::uuid
  )
  and exists (
    select 1
    from public.group_members as gm
    join leave_group_case as lg on lg.group_id = gm.group_id
    where gm.user_id = '00000000-0000-0000-0000-000000000119'::uuid
  ),
  'leaving removes only that membership'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000121', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table owner_leave_group on commit drop as select * from public.create_group();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000122', true);
create temporary table owner_leave_join_result on commit drop as
select * from public.join_group_with_invite((select invite_code from owner_leave_group));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000121', true);
select public.leave_group((select group_id from owner_leave_group));

reset role;

select is(
  (select g.created_by from public.groups as g join owner_leave_group as olg on olg.group_id = g.id),
  '00000000-0000-0000-0000-000000000122'::uuid,
  'owner leaving transfers ownership'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000123', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table last_leave_group on commit drop as select * from public.create_group();
select public.leave_group((select group_id from last_leave_group));

reset role;

select ok(
  not exists (
    select 1
    from public.groups as g
    join last_leave_group as llg on llg.group_id = g.id
  ),
  'last member leaving deletes the group'
);

insert into public.groups (id, created_by)
values (
  '10000000-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000124'::uuid
);

insert into public.group_members (group_id, user_id, joined_at)
values
  ('10000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000124'::uuid, now()),
  ('10000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000125'::uuid, now() + interval '1 second'),
  ('10000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000126'::uuid, now() + interval '2 seconds');

select is(
  public.group_access_state('10000000-0000-0000-0000-000000000001'::uuid),
  'grace',
  'group state becomes grace if member count exceeds the owner-derived limit'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000126', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select public.leave_group('10000000-0000-0000-0000-000000000001'::uuid);

reset role;

select ok(
  not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = '10000000-0000-0000-0000-000000000001'::uuid
      and gm.user_id = '00000000-0000-0000-0000-000000000126'::uuid
  )
  and public.group_access_state('10000000-0000-0000-0000-000000000001'::uuid) = 'active',
  'leaving is still allowed while in grace'
);

select * from finish();

rollback;
