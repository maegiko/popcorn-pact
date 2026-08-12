set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(26);

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
    ('00000000-0000-0000-0000-000000000401'::uuid, 'user401@example.test', 'Pool Owner'),
    ('00000000-0000-0000-0000-000000000402'::uuid, 'user402@example.test', 'Pool Partner'),
    ('00000000-0000-0000-0000-000000000403'::uuid, 'user403@example.test', 'Pool Stranger'),
    ('00000000-0000-0000-0000-000000000404'::uuid, 'user404@example.test', 'Grace Owner'),
    ('00000000-0000-0000-0000-000000000405'::uuid, 'user405@example.test', 'Grace Member A'),
    ('00000000-0000-0000-0000-000000000406'::uuid, 'user406@example.test', 'Grace Member B')
) as users(user_id, email, display_name);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000401', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table pool_group on commit drop as select * from public.create_group();
create temporary table owner_generated_pool on commit drop as
select * from public.create_pool((select group_id from pool_group), 'generated');
create temporary table owner_manual_pool on commit drop as
select * from public.create_pool((select group_id from pool_group), 'manual');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000402', true);
create temporary table partner_join on commit drop as
select * from public.join_group_with_invite((select invite_code from pool_group));
create temporary table partner_generated_pool on commit drop as
select * from public.create_pool((select group_id from pool_group), 'generated');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000403', true);
create temporary table stranger_pool_attempt on commit drop as
select * from public.create_pool((select group_id from pool_group), 'generated');

reset role;

select is(
  (select status from owner_generated_pool),
  'created',
  'current group member can create a generated pool'
);

select is(
  (select status from owner_manual_pool),
  'created',
  'current group member can create a manual pool'
);

select is(
  (select status from partner_generated_pool),
  'created',
  'group owner is not special for pool creation'
);

select is(
  (select status from stranger_pool_attempt),
  'not_a_member',
  'non-member cannot create a pool for a group'
);

select is(
  (
    select p.group_id
    from public.pools as p
    where p.id = (select pool_id from owner_generated_pool)
  ),
  (select group_id from pool_group),
  'created pool belongs to exactly one group'
);

select is(
  (
    select p.created_by
    from public.pools as p
    where p.id = (select pool_id from owner_generated_pool)
  ),
  '00000000-0000-0000-0000-000000000401'::uuid,
  'created pool records which user created it'
);

select bag_eq(
  $$
    select p.mode
    from public.pools as p
    where p.id in (
      (select pool_id from owner_generated_pool),
      (select pool_id from owner_manual_pool)
    )
  $$,
  $$ values ('generated'::text), ('manual'::text) $$,
  'pools distinguish generated and manual creation modes'
);

select is(
  (
    select count(*)::integer
    from public.pool_titles as pt
    where pt.pool_id = (select pool_id from owner_generated_pool)
  ),
  0,
  'newly created pool may temporarily contain zero titles'
);

-- Canonical media the pool tests below put into pools. Identity is the media
-- row; the provider mappings exist so the assertions can still talk about "the
-- same provider id as a movie and as a series", which is the property under
-- test.
insert into public.media (id, media_type, title)
values
  ('30000000-0000-0000-0000-000000000001'::uuid, 'movie', 'Pool Movie 123'),
  ('30000000-0000-0000-0000-000000000002'::uuid, 'movie', 'Pool Movie 456'),
  ('30000000-0000-0000-0000-000000000003'::uuid, 'tv', 'Pool Series 123');

-- A fixture provider slug rather than a real one. `provider` leads the primary
-- key of media_external_ids, so a slug nothing else writes makes these rows
-- unreachable from any data the edge suites leave behind in the same local
-- database -- and this file is about the identity rules, not about TMDB.
insert into public.media_external_ids (media_id, media_type, provider, external_id)
values
  ('30000000-0000-0000-0000-000000000001'::uuid, 'movie', 'pgtap-pools', '123'),
  ('30000000-0000-0000-0000-000000000002'::uuid, 'movie', 'pgtap-pools', '456'),
  ('30000000-0000-0000-0000-000000000003'::uuid, 'tv', 'pgtap-pools', '123');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000401', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table first_title_result on commit drop as
select * from public.add_pool_title(
  (select pool_id from owner_generated_pool),
  '30000000-0000-0000-0000-000000000001'::uuid
);
create temporary table second_title_result on commit drop as
select * from public.add_pool_title(
  (select pool_id from owner_generated_pool),
  '30000000-0000-0000-0000-000000000002'::uuid
);
create temporary table same_id_tv_result on commit drop as
select * from public.add_pool_title(
  (select pool_id from owner_generated_pool),
  '30000000-0000-0000-0000-000000000003'::uuid
);
create temporary table duplicate_title_result on commit drop as
select * from public.add_pool_title(
  (select pool_id from owner_generated_pool),
  '30000000-0000-0000-0000-000000000001'::uuid
);
create temporary table unknown_media_result on commit drop as
select * from public.add_pool_title(
  (select pool_id from owner_generated_pool),
  '30000000-0000-0000-0000-0000000009ff'::uuid
);
create temporary table same_title_other_pool_result on commit drop as
select * from public.add_pool_title(
  (select pool_id from owner_manual_pool),
  '30000000-0000-0000-0000-000000000001'::uuid
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000403', true);
create temporary table stranger_add_title_attempt on commit drop as
select * from public.add_pool_title(
  (select pool_id from owner_generated_pool),
  '30000000-0000-0000-0000-000000000002'::uuid
);

reset role;

select ok(
  (select status = 'added' from first_title_result)
  and (select status = 'added' from second_title_result)
  and (select count(*)::integer from public.pool_titles where pool_id = (select pool_id from owner_generated_pool)) = 3,
  'a pool may contain many titles'
);

select ok(
  (select status = 'added' from same_id_tv_result)
  and exists (
    select 1
    from public.pool_titles as movie_title
    join public.media_external_ids as movie_id
      on movie_id.media_id = movie_title.media_id
     and movie_id.media_type = 'movie'
    join public.media_external_ids as tv_id
      on tv_id.provider = movie_id.provider
     and tv_id.external_id = movie_id.external_id
     and tv_id.media_type = 'tv'
    join public.pool_titles as tv_title
      on tv_title.media_id = tv_id.media_id
     and tv_title.pool_id = movie_title.pool_id
    where movie_title.pool_id = (select pool_id from owner_generated_pool)
      and movie_id.provider = 'pgtap-pools'
      and movie_id.external_id = '123'
  ),
  'movie and tv sharing one provider ID are distinct titles inside a pool'
);

select is(
  (select status from duplicate_title_result),
  'duplicate_title',
  'the same canonical title cannot appear twice in the same pool'
);

select is(
  (select status from same_title_other_pool_result),
  'added',
  'same title may appear in different pools'
);

select is(
  (select status from unknown_media_result),
  'unknown_media',
  'a pool title must name a canonical media record that exists'
);

select is(
  (select status from stranger_add_title_attempt),
  'not_a_member',
  'users cannot add titles to pools outside their groups'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000402', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  exists (
    select 1
    from public.pools as p
    where p.id = (select pool_id from owner_generated_pool)
  ),
  'group members may read their group''s pools'
);

select ok(
  exists (
    select 1
    from public.pool_titles as pt
    where pt.pool_id = (select pool_id from owner_generated_pool)
      and pt.media_id = '30000000-0000-0000-0000-000000000001'::uuid
  ),
  'group members may read titles in their group''s pools'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000403', true);

select ok(
  not exists (
    select 1
    from public.pools as p
    where p.id = (select pool_id from owner_generated_pool)
  ),
  'unrelated users cannot read another group''s pools'
);

select ok(
  not exists (
    select 1
    from public.pool_titles as pt
    where pt.pool_id = (select pool_id from owner_generated_pool)
  ),
  'unrelated users cannot read another group''s pool titles'
);

select throws_ok(
  $$
    insert into public.pools (group_id, created_by, mode)
    values (
      (select group_id from pool_group),
      '00000000-0000-0000-0000-000000000403'::uuid,
      'generated'
    )
  $$,
  '42501',
  'permission denied for table pools',
  'authenticated client cannot directly insert into pools'
);

select throws_ok(
  $$
    insert into public.pool_titles (pool_id, media_id)
    values (
      (select pool_id from owner_generated_pool),
      '30000000-0000-0000-0000-000000000002'::uuid
    )
  $$,
  '42501',
  'permission denied for table pool_titles',
  'authenticated client cannot directly insert into pool titles'
);

select throws_ok(
  $$
    update public.pools
    set mode = 'manual'
    where id = (select pool_id from owner_generated_pool)
  $$,
  '42501',
  'permission denied for table pools',
  'authenticated client cannot directly update pool rows'
);

select throws_ok(
  $$
    delete from public.pool_titles
    where pool_id = (select pool_id from owner_generated_pool)
  $$,
  '42501',
  'permission denied for table pool_titles',
  'authenticated client cannot directly delete pool title rows'
);

reset role;

insert into public.groups (id, created_by)
values (
  '10000000-0000-0000-0000-000000000401'::uuid,
  '00000000-0000-0000-0000-000000000404'::uuid
);

insert into public.group_members (group_id, user_id, joined_at)
values
  ('10000000-0000-0000-0000-000000000401'::uuid, '00000000-0000-0000-0000-000000000404'::uuid, now()),
  ('10000000-0000-0000-0000-000000000401'::uuid, '00000000-0000-0000-0000-000000000405'::uuid, now() + interval '1 second'),
  ('10000000-0000-0000-0000-000000000401'::uuid, '00000000-0000-0000-0000-000000000406'::uuid, now() + interval '2 seconds');

insert into public.pools (id, group_id, created_by, mode)
values (
  '20000000-0000-0000-0000-000000000401'::uuid,
  '10000000-0000-0000-0000-000000000401'::uuid,
  '00000000-0000-0000-0000-000000000404'::uuid,
  'manual'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000404', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temporary table grace_create_pool_attempt on commit drop as
select * from public.create_pool('10000000-0000-0000-0000-000000000401'::uuid, 'manual');
create temporary table grace_add_title_attempt on commit drop as
select * from public.add_pool_title(
  '20000000-0000-0000-0000-000000000401'::uuid,
  '30000000-0000-0000-0000-000000000001'::uuid
);

reset role;

select is(
  (select status from grace_create_pool_attempt),
  'group_in_grace',
  'pool creation is refused while the group is in grace'
);

select is(
  (select status from grace_add_title_attempt),
  'group_in_grace',
  'pool population is refused while the group is in grace'
);

insert into public.pools (id, group_id, created_by, mode)
values (
  '20000000-0000-0000-0000-000000000402'::uuid,
  (select group_id from pool_group),
  '00000000-0000-0000-0000-000000000401'::uuid,
  'manual'
);

insert into public.pool_titles (pool_id, media_id)
values
  ('20000000-0000-0000-0000-000000000402'::uuid, '30000000-0000-0000-0000-000000000001'::uuid),
  ('20000000-0000-0000-0000-000000000402'::uuid, '30000000-0000-0000-0000-000000000003'::uuid);

delete from public.pools
where id = '20000000-0000-0000-0000-000000000402'::uuid;

select is(
  (
    select count(*)::integer
    from public.pool_titles as pt
    where pt.pool_id = '20000000-0000-0000-0000-000000000402'::uuid
  ),
  0,
  'deleting a pool removes its pool-title rows'
);

insert into public.pools (id, group_id, created_by, mode)
values (
  '20000000-0000-0000-0000-000000000403'::uuid,
  (select group_id from pool_group),
  '00000000-0000-0000-0000-000000000401'::uuid,
  'manual'
);

insert into public.pool_titles (pool_id, media_id)
values ('20000000-0000-0000-0000-000000000403'::uuid, '30000000-0000-0000-0000-000000000002'::uuid);

delete from public.groups
where id = (select group_id from pool_group);

select ok(
  not exists (
    select 1
    from public.pools as p
    where p.id = '20000000-0000-0000-0000-000000000403'::uuid
  )
  and not exists (
    select 1
    from public.pool_titles as pt
    where pt.pool_id = '20000000-0000-0000-0000-000000000403'::uuid
  ),
  'deleting a group cascades through its pools and pool titles'
);

select * from finish();

rollback;
