set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(13);

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
    ('00000000-0000-0000-0000-000000000201'::uuid, 'user201@example.test', 'RLS Owner'),
    ('00000000-0000-0000-0000-000000000202'::uuid, 'user202@example.test', 'RLS Partner'),
    ('00000000-0000-0000-0000-000000000203'::uuid, 'user203@example.test', 'RLS Stranger')
) as users(user_id, email, display_name);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table rls_group on commit drop as select * from public.create_group();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
create temporary table rls_join on commit drop as
select * from public.join_group_with_invite((select invite_code from rls_group));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);

select ok(
  exists (
    select 1
    from public.groups as g
    where g.id = (select group_id from rls_group)
  ),
  'member can read their own group'
);

select is(
  (
    select count(*)::integer
    from public.group_members as gm
    where gm.group_id = (select group_id from rls_group)
  ),
  2,
  'member can read all memberships in their group'
);

select ok(
  exists (
    select 1
    from public.group_invites as gi
    where gi.group_id = (select group_id from rls_group)
  ),
  'member can read their group''s invite'
);

select ok(
  exists (
    select 1
    from public.profiles as p
    where p.id = '00000000-0000-0000-0000-000000000202'::uuid
      and p.display_name = 'RLS Partner'
  ),
  'members of the same group can read each other''s profiles.display_name'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);

select ok(
  not exists (
    select 1
    from public.groups as g
    where g.id = (select group_id from rls_group)
  ),
  'unrelated user cannot read the group'
);

select is(
  (
    select count(*)::integer
    from public.group_members as gm
    where gm.group_id = (select group_id from rls_group)
  ),
  0,
  'unrelated user cannot read memberships'
);

select is(
  (
    select count(*)::integer
    from public.group_invites as gi
    where gi.group_id = (select group_id from rls_group)
  ),
  0,
  'unrelated user cannot read invites'
);

select ok(
  not exists (
    select 1
    from public.profiles as p
    where p.id = '00000000-0000-0000-0000-000000000201'::uuid
      and p.display_name = 'RLS Owner'
  ),
  'unrelated users cannot read each other''s profiles'
);

select throws_ok(
  $$
    insert into public.groups (created_by)
    values ('00000000-0000-0000-0000-000000000203'::uuid)
  $$,
  '42501',
  'permission denied for table groups',
  'client role cannot directly insert into groups'
);

select throws_ok(
  $$
    insert into public.group_members (group_id, user_id)
    values ((select group_id from rls_group), '00000000-0000-0000-0000-000000000203'::uuid)
  $$,
  '42501',
  'permission denied for table group_members',
  'client role cannot directly insert into group_members'
);

select throws_ok(
  $$
    update public.groups
    set created_by = '00000000-0000-0000-0000-000000000203'::uuid
    where id = (select group_id from rls_group)
  $$,
  '42501',
  'permission denied for table groups',
  'client role cannot directly update group rows'
);

select throws_ok(
  $$
    delete from public.group_members
    where group_id = (select group_id from rls_group)
      and user_id = '00000000-0000-0000-0000-000000000201'::uuid
  $$,
  '42501',
  'permission denied for table group_members',
  'client role cannot directly delete group membership rows'
);

select throws_ok(
  $$
    select public.remove_member(
      (select group_id from rls_group),
      '00000000-0000-0000-0000-000000000201'::uuid
    )
  $$,
  '42501',
  'permission denied for function remove_member',
  'internal helper functions such as arbitrary-member removal are not callable by authenticated clients'
);

reset role;

select * from finish();

rollback;
