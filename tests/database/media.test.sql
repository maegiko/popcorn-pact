-- Popcorn Pact: canonical media identity.
--
-- These are the properties that make provider portability real rather than
-- nominal. Every one of them is about identity: what makes two provider records
-- the same title, what makes them different titles, and who is allowed to say.
--
-- The fixtures use invented provider slugs (pgtap-a, pgtap-b, pgtap-c) rather
-- than tmdb/tvdb/imdb for two reasons: `provider` leads the primary key of
-- media_external_ids, so an invented slug cannot collide with rows the edge
-- suites leave behind in the same local database, and none of these rules is
-- about a particular provider in the first place.

set search_path = public, extensions;

create extension if not exists pgtap with schema extensions;

begin;

select plan(16);

select has_column(
  'public',
  'media',
  'overview',
  'canonical media stores provider-independent overview metadata'
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
    ('00000000-0000-0000-0000-000000000501'::uuid, 'user501@example.test', 'Media Reader')
) as users(user_id, email, display_name);


-- ---------------------------------------------------------------------------
-- The same number, from different providers and for different media types.
-- ---------------------------------------------------------------------------

insert into public.media (id, media_type, title)
values
  ('40000000-0000-0000-0000-000000000001'::uuid, 'movie', 'Provider A Movie 42'),
  ('40000000-0000-0000-0000-000000000002'::uuid, 'movie', 'Provider B Movie 42'),
  ('40000000-0000-0000-0000-000000000003'::uuid, 'tv', 'Provider A Series 42');

insert into public.media_external_ids (media_id, media_type, provider, external_id)
values
  ('40000000-0000-0000-0000-000000000001'::uuid, 'movie', 'pgtap-a', '42'),
  ('40000000-0000-0000-0000-000000000002'::uuid, 'movie', 'pgtap-b', '42'),
  ('40000000-0000-0000-0000-000000000003'::uuid, 'tv', 'pgtap-a', '42');

select is(
  (
    select count(distinct mei.media_id)::integer
    from public.media_external_ids as mei
    where mei.external_id = '42'
      and mei.provider in ('pgtap-a', 'pgtap-b')
  ),
  3,
  'the same id from two providers, and across movie and tv, names three distinct titles'
);

select throws_ok(
  $$
    insert into public.media_external_ids (media_id, media_type, provider, external_id)
    values ('40000000-0000-0000-0000-000000000002'::uuid, 'movie', 'pgtap-a', '42')
  $$,
  '23505',
  null,
  'one provider id cannot be claimed by two canonical titles'
);

select lives_ok(
  $$
    insert into public.media_external_ids (media_id, media_type, provider, external_id)
    values ('40000000-0000-0000-0000-000000000001'::uuid, 'movie', 'pgtap-c', 'tt0000042')
  $$,
  'one title may carry mappings for several providers at once'
);

-- The composite foreign key, not a trigger: the mapping's media_type has to
-- agree with the media row's, so a tv mapping cannot be hung off a film.
select throws_ok(
  $$
    insert into public.media_external_ids (media_id, media_type, provider, external_id)
    values ('40000000-0000-0000-0000-000000000001'::uuid, 'tv', 'pgtap-b', '9001')
  $$,
  '23503',
  null,
  'an external id cannot disagree with its media row about movie or tv'
);

select throws_ok(
  $$
    insert into public.media (media_type, title)
    values ('podcast', 'Not A Thing')
  $$,
  '23514',
  null,
  'media_type is restricted to movie and tv'
);


-- ---------------------------------------------------------------------------
-- Identity resolution. This is what stops a provider switch from turning one
-- title into two.
-- ---------------------------------------------------------------------------

create temporary table recognised on commit drop as
select public.upsert_media($${
  "media_type": "movie",
  "title": "Provider A Movie 42",
  "release_year": 1999,
  "overview": "Provider-independent summary from the resolving provider.",
  "external_ids": { "pgtap-c": "tt0000042", "pgtap-b": "77" }
}$$::jsonb) as media_id;

select is(
  (select media_id from recognised),
  '40000000-0000-0000-0000-000000000001'::uuid,
  'a record recognised by any one of its mappings resolves to the title already held'
);

select ok(
  exists (
    select 1
    from public.media_external_ids as mei
    where mei.media_id = '40000000-0000-0000-0000-000000000001'::uuid
      and mei.provider = 'pgtap-b'
      and mei.external_id = '77'
  ),
  'resolving a record learns the mappings it carried that we did not have'
);

select is(
  (
    select m.overview
    from public.media as m
    where m.id = (select media_id from recognised)
  ),
  'Provider-independent summary from the resolving provider.',
  'upsert_media stores overview on the canonical media row'
);

create temporary table unrecognised on commit drop as
select public.upsert_media($${
  "media_type": "movie",
  "title": "Never Seen Before",
  "external_ids": { "pgtap-a": "9zzz" }
}$$::jsonb) as media_id;

select isnt(
  (select media_id from unrecognised),
  '40000000-0000-0000-0000-000000000001'::uuid,
  'a record sharing no mapping with anything known becomes its own title'
);

select throws_ok(
  $$ select public.upsert_media('{"media_type":"movie","external_ids":{}}'::jsonb) $$,
  '23514',
  null,
  'a record with no external ids has no identity and is refused'
);

select lives_ok(
  $$ delete from public.media where id = '40000000-0000-0000-0000-000000000003'::uuid $$,
  'an unused media row can be deleted'
);

select is(
  (
    select count(*)::integer
    from public.media_external_ids as mei
    where mei.media_id = '40000000-0000-0000-0000-000000000003'::uuid
  ),
  0,
  'deleting a media row removes its external id mappings'
);


-- ---------------------------------------------------------------------------
-- Client access. The catalogue is readable; writing it is server-side only.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000501', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  exists (
    select 1
    from public.media as m
    where m.id = '40000000-0000-0000-0000-000000000001'::uuid
  ),
  'authenticated clients can read the media catalogue'
);

select throws_ok(
  $$
    insert into public.media (media_type, title)
    values ('movie', 'Forged Title')
  $$,
  '42501',
  'permission denied for table media',
  'authenticated clients cannot write canonical media'
);

select throws_ok(
  $$
    select public.upsert_media('{"media_type":"movie","external_ids":{"pgtap-a":"1"}}'::jsonb)
  $$,
  '42501',
  'permission denied for function upsert_media',
  'authenticated clients cannot resolve identity directly'
);

reset role;

select * from finish();

rollback;
