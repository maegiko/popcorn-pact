set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(6);

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
values (
  '00000000-0000-0000-0000-000000000301'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'user301@example.test',
  extensions.crypt('password', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Profile User"}'::jsonb,
  now(),
  now()
);

select ok(
  exists (
    select 1
    from public.profiles as p
    where p.id = '00000000-0000-0000-0000-000000000301'::uuid
  ),
  'new auth user automatically gets a profiles row'
);

select is(
  (
    select p.id
    from public.profiles as p
    where p.id = '00000000-0000-0000-0000-000000000301'::uuid
  ),
  '00000000-0000-0000-0000-000000000301'::uuid,
  'profile ID matches auth user ID'
);

select throws_ok(
  $$
    insert into public.profiles (id, display_name)
    values ('00000000-0000-0000-0000-000000000302'::uuid, '   ')
  $$,
  '23514',
  'new row for relation "profiles" violates check constraint "profiles_display_name_valid"',
  'blank/whitespace display names are rejected'
);

select throws_ok(
  $$
    insert into public.profiles (id, display_name)
    values (
      '00000000-0000-0000-0000-000000000303'::uuid,
      repeat('x', 51)
    )
  $$,
  '23514',
  'new row for relation "profiles" violates check constraint "profiles_display_name_valid"',
  'overlong display names are rejected'
);

select throws_ok(
  $$
    update public.profiles
    set display_name = null
    where id = '00000000-0000-0000-0000-000000000301'::uuid
  $$,
  '23514',
  'display_name cannot be cleared once it has been set',
  'completed display name cannot be reset to null'
);

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
values (
  '00000000-0000-0000-0000-000000000304'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'user304@example.test',
  extensions.crypt('password', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Other User"}'::jsonb,
  now(),
  now()
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000304', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

update public.profiles
set display_name = 'Hijacked'
where id = '00000000-0000-0000-0000-000000000301'::uuid;

reset role;

select is(
  (
    select p.display_name
    from public.profiles as p
    where p.id = '00000000-0000-0000-0000-000000000301'::uuid
  ),
  'Profile User',
  'user cannot update someone else''s profile'
);

select * from finish();

rollback;
