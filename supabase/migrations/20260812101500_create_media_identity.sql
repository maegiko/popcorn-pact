-- Popcorn Pact: provider-neutral media identity.
--
-- pool_titles previously stored (tmdb_id, media_type), which made TMDB the
-- application's identity system rather than one of its data sources. Every
-- feature built on top of a pool -- swipes, matches, watched state -- would have
-- inherited that column, and changing data provider would then have meant
-- rewriting the core loop rather than swapping an adapter. Development is moving
-- to TVDB and launch may use Streaming Availability, so the identity has to stop
-- being any one provider's.
--
-- The replacement is two tables:
--
--   media                 the canonical record: what Popcorn Pact thinks a title
--                         is. Its id is ours, and it is what pools (and later
--                         swipes, matches and watches) point at.
--   media_external_ids    how each provider names that same title. One media row
--                         may carry tvdb, tmdb, imdb and Streaming Availability
--                         mappings at once.
--
-- Two properties do the real work:
--
--   * movie and tv stay distinct even when providers reuse a number. media_type
--     is part of the external-id key, and a composite foreign key makes the
--     database guarantee the mapping's media_type matches the media row's rather
--     than trusting the writer.
--   * ids cannot collide across providers, because provider is part of the key.
--     tvdb 123 and tmdb 123 are two different rows and may be two different
--     films.
--
-- What this is NOT: a mirror of anyone's catalogue. A media row exists only
-- because a title actually entered a pool, and it holds the handful of fields the
-- swipe UI needs. Artwork is stored as the provider's CDN URL, not as bytes --
-- the Free tier has 500 MB and none of it should go to posters we do not own.


-- ---------------------------------------------------------------------------
-- Canonical media.
-- ---------------------------------------------------------------------------

create table public.media (
  id uuid primary key default gen_random_uuid(),
  -- text with a check, matching pool_titles' original reasoning: an enum makes
  -- every future addition a migration with a transaction-boundary caveat.
  media_type text not null,
  -- Nullable on purpose. Identity is media_type plus at least one external id;
  -- everything below is metadata a provider may or may not supply, and a row
  -- migrated from the tmdb_id-only schema genuinely has none of it. NULL means
  -- "not known yet", and the UI must render that rather than assume it cannot
  -- happen.
  title text,
  release_year integer,
  overview text,
  -- Provider/CDN URLs, never blobs. Replaceable along with the provider.
  poster_url text,
  backdrop_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_media_type_valid check (media_type in ('movie', 'tv')),
  constraint media_release_year_valid
    check (release_year is null or release_year between 1870 and 2200),
  -- Redundant on its own -- id is already unique -- but it gives
  -- media_external_ids a composite key to reference, which is what lets the
  -- database enforce that a mapping's media_type agrees with its media row's.
  constraint media_id_media_type_key unique (id, media_type)
);

comment on table public.media is
  'Canonical Popcorn Pact title record. Identity for pools and everything built on them; providers map into it through media_external_ids.';
comment on column public.media.title is
  'Best-effort metadata. NULL means no provider has supplied a title for this record yet.';
comment on column public.media.poster_url is
  'Absolute provider/CDN URL. Artwork is never copied into Supabase Storage.';


create table public.media_external_ids (
  media_id uuid not null,
  -- Denormalised from media so it can take part in the key below. The composite
  -- foreign key stops it ever disagreeing with the media row.
  media_type text not null,
  -- A short slug: 'tmdb', 'tvdb', 'imdb', 'streaming-availability', 'anilist'.
  provider text not null,
  -- text rather than integer: TVDB and TMDB use numbers, IMDb uses tt0133093,
  -- and Streaming Availability uses opaque strings. Storing the provider's own
  -- spelling is what keeps the mapping honest.
  external_id text not null,
  created_at timestamptz not null default now(),
  -- One provider id names at most one title. media_type is in the key because
  -- a provider may hand the same number to a film and a series.
  constraint media_external_ids_pkey primary key (provider, media_type, external_id),
  constraint media_external_ids_media_fkey
    foreign key (media_id, media_type)
    references public.media (id, media_type)
    on delete cascade,
  constraint media_external_ids_provider_valid check (provider ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  constraint media_external_ids_external_id_valid check (length(external_id) between 1 and 128)
);

comment on table public.media_external_ids is
  'How each provider names a canonical media row. Keyed by (provider, media_type, external_id), so ids never collide across providers and movie/tv stay distinct.';

-- The reverse lookup ("what is this title called elsewhere") and the index the
-- inbound foreign key wants.
create index media_external_ids_media_id_idx on public.media_external_ids (media_id);


-- ---------------------------------------------------------------------------
-- pool_titles moves onto canonical identity.
--
-- Existing rows are preserved: every distinct (tmdb_id, media_type) already in a
-- pool becomes one media row plus one 'tmdb' mapping, and the pool keeps
-- pointing at the same title. No metadata is invented for them -- they simply
-- have none until a provider supplies some.
-- ---------------------------------------------------------------------------

alter table public.pool_titles add column media_id uuid;

with keyed as materialized (
  select
    distinct_titles.tmdb_id,
    distinct_titles.media_type,
    gen_random_uuid() as media_id
  from (
    select distinct pt.tmdb_id, pt.media_type
    from public.pool_titles as pt
  ) as distinct_titles
),
created_media as (
  insert into public.media (id, media_type)
  select k.media_id, k.media_type
  from keyed as k
  returning id
),
created_mappings as (
  insert into public.media_external_ids (media_id, media_type, provider, external_id)
  select k.media_id, k.media_type, 'tmdb', k.tmdb_id::text
  from keyed as k
  returning media_id
)
update public.pool_titles as pt
set media_id = k.media_id
from keyed as k
where pt.tmdb_id = k.tmdb_id
  and pt.media_type = k.media_type;

alter table public.pool_titles drop constraint pool_titles_pkey;

-- Dropping the columns takes their check constraints with them.
alter table public.pool_titles drop column tmdb_id;
alter table public.pool_titles drop column media_type;

alter table public.pool_titles alter column media_id set not null;

-- restrict, not cascade: media is a replaceable cache, and deleting a cached
-- record must never quietly empty a group's pool. Nothing deletes media today,
-- and this is what makes any future eviction job announce itself.
alter table public.pool_titles
  add constraint pool_titles_media_id_fkey
  foreign key (media_id) references public.media (id) on delete restrict;

-- Same role the old key played: uniqueness per pool, plus the pool_id-leading
-- index every read and the cascade from pools require.
alter table public.pool_titles add primary key (pool_id, media_id);

create index pool_titles_media_id_idx on public.pool_titles (media_id);

comment on table public.pool_titles is
  'Titles in a pool, as canonical media ids. Unique per pool, so the same title may appear in two of a group''s pools.';


-- ---------------------------------------------------------------------------
-- Resolving a provider record to canonical identity.
--
-- Takes one canonical media record as JSON -- media_type, optional metadata, and
-- the external ids the provider knew -- and returns the media row it refers to,
-- creating it if this is the first time Popcorn Pact has seen the title.
--
-- Not callable by clients. It is the trusted half of pool generation, invoked
-- only from create_generated_pool() below.
-- ---------------------------------------------------------------------------

create function public.upsert_media(p_media jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media_type text := p_media ->> 'media_type';
  v_external jsonb := coalesce(p_media -> 'external_ids', '{}'::jsonb);
  v_media_id uuid;
begin
  -- Raises rather than returning a status: every caller is trusted server-side
  -- code, so a malformed record is a bug in the adapter, and half a snapshot is
  -- worse than a loud failure. This mirrors how the old pool_titles check
  -- constraints aborted a bad generated pool.
  if v_media_type is null or v_media_type not in ('movie', 'tv') then
    raise exception 'upsert_media: invalid media_type %', coalesce(v_media_type, '<null>')
      using errcode = 'check_violation';
  end if;

  if jsonb_typeof(v_external) <> 'object' or v_external = '{}'::jsonb then
    raise exception 'upsert_media: media record carries no external ids'
      using errcode = 'check_violation';
  end if;

  -- Identity first. Any one mapping that already resolves settles it: a record
  -- carrying both a tvdb and a tmdb id for a title we already know under either
  -- is that title, not a new one.
  select mei.media_id
  into v_media_id
  from jsonb_each_text(v_external) as e(provider, external_id)
  join public.media_external_ids as mei
    on mei.provider = e.provider
   and mei.external_id = e.external_id
   and mei.media_type = v_media_type
  limit 1;

  if v_media_id is null then
    insert into public.media (media_type, title, release_year, overview, poster_url, backdrop_url)
    values (
      v_media_type,
      nullif(p_media ->> 'title', ''),
      (p_media ->> 'release_year')::integer,
      nullif(p_media ->> 'overview', ''),
      nullif(p_media ->> 'poster_url', ''),
      nullif(p_media ->> 'backdrop_url', '')
    )
    returning id into v_media_id;
  else
    -- coalesce in this direction so a provider that knows less than the last one
    -- cannot erase what we already have. Fresh values win; absent ones do not.
    update public.media as m
    set
      title = coalesce(nullif(p_media ->> 'title', ''), m.title),
      release_year = coalesce((p_media ->> 'release_year')::integer, m.release_year),
      overview = coalesce(nullif(p_media ->> 'overview', ''), m.overview),
      poster_url = coalesce(nullif(p_media ->> 'poster_url', ''), m.poster_url),
      backdrop_url = coalesce(nullif(p_media ->> 'backdrop_url', ''), m.backdrop_url),
      updated_at = now()
    where m.id = v_media_id;
  end if;

  -- Learn every mapping this record carried, including ones we did not have.
  -- ON CONFLICT rather than a preceding check: two generations running at once
  -- for different groups will race on exactly these rows. A conflict means some
  -- other row already claims that provider id -- normally this same media row,
  -- occasionally a separate record we once created from a different provider.
  -- Leaving the existing claim alone is the conservative answer; merging two
  -- canonical records is not something to do implicitly.
  insert into public.media_external_ids (media_id, media_type, provider, external_id)
  select v_media_id, v_media_type, e.provider, e.external_id
  from jsonb_each_text(v_external) as e(provider, external_id)
  where e.external_id is not null
    and e.external_id <> ''
  on conflict (provider, media_type, external_id) do nothing;

  return v_media_id;
end;
$$;

comment on function public.upsert_media(jsonb) is
  'Resolves one canonical media record (media_type, metadata, external ids) to a media row, creating it on first sight. Server-side only.';


-- ---------------------------------------------------------------------------
-- create_generated_pool, on canonical identity.
--
-- Same contract as before -- caller-derived identity, the same membership and
-- grace checks, the same status vocabulary, the whole snapshot in one
-- transaction. Only the shape of p_titles changes: entries are now canonical
-- media records rather than TMDB ids.
--
--   [{ "media_type": "movie",
--      "title": "…", "release_year": 1995,
--      "overview": "…", "poster_url": "…", "backdrop_url": "…",
--      "external_ids": { "tvdb": "1234", "imdb": "tt0113277" } }]
--
-- Everything except media_type and a non-empty external_ids object is optional.
-- ---------------------------------------------------------------------------

create or replace function public.create_generated_pool(p_group_id uuid, p_titles jsonb)
returns table (status text, pool_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
-- The OUT parameters shadow same-named columns in this body; every column
-- reference is table-qualified, and this pragma resolves any that is missed to
-- the column rather than erroring.
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_pool_id uuid;
  v_title jsonb;
  v_media_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- Membership first, so a caller outside the group learns nothing about it.
  if not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = p_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text, null::uuid;
    return;
  end if;

  -- Group features are withheld while the group exceeds its owner's
  -- entitlement. Recomputed here rather than trusted from the caller.
  if public.group_access_state(p_group_id) <> 'active' then
    return query select 'group_in_grace'::text, null::uuid;
    return;
  end if;

  -- An empty generated pool is never worth creating: it would present as an
  -- already-exhausted pile the moment it was opened. Refusing here is what lets
  -- the caller promise that a failed generation left nothing behind -- and it
  -- also means no media row is created for a generation that produces no pool.
  if p_titles is null
     or jsonb_typeof(p_titles) <> 'array'
     or jsonb_array_length(p_titles) = 0 then
    return query select 'no_candidates'::text, null::uuid;
    return;
  end if;

  insert into public.pools (group_id, created_by, mode)
  values (p_group_id, v_user, 'generated')
  returning id into v_pool_id;

  -- A loop rather than one set-based insert, because resolving identity is a
  -- read-then-write per title. It is still one transaction: the pool row, every
  -- media row it needed and every pool_titles row commit together or not at all.
  for v_title in select value from jsonb_array_elements(p_titles)
  loop
    v_media_id := public.upsert_media(v_title);

    -- Two candidates that turned out to be the same title collapse here, which
    -- is the canonical-identity version of the DISTINCT this function used to do
    -- on (tmdb_id, media_type).
    insert into public.pool_titles (pool_id, media_id)
    values (v_pool_id, v_media_id)
    on conflict (pool_id, media_id) do nothing;
  end loop;

  return query select 'created'::text, v_pool_id;
end;
$$;

comment on function public.create_generated_pool(uuid, jsonb) is
  'Creates a generated pool and its titles atomically for a group the caller belongs to, resolving each canonical media record to a media row. Returns not_a_member, group_in_grace or no_candidates instead of raising, and creates nothing in those cases.';


-- ---------------------------------------------------------------------------
-- add_pool_title, on canonical identity.
--
-- The manual-pool counterpart. It takes a media id that already exists rather
-- than provider fields, because a member picking a title by hand will have found
-- it through a search that already resolved it. The old (uuid, integer, text)
-- signature is dropped: leaving a TMDB-shaped overload in place would be an open
-- invitation for new code to depend on TMDB identity again.
-- ---------------------------------------------------------------------------

drop function public.add_pool_title(uuid, integer, text);

create function public.add_pool_title(p_pool_id uuid, p_media_id uuid)
returns table (status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_group_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  select p.group_id
  into v_group_id
  from public.pools as p
  where p.id = p_pool_id;

  -- A pool that does not exist and a pool in someone else's group are the same
  -- answer on purpose: this function runs as the table owner, so distinguishing
  -- them would turn it into an existence oracle for arbitrary pool ids.
  if v_group_id is null or not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = v_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text;
    return;
  end if;

  -- Reported rather than left to the foreign key, for the same reason
  -- create_pool reports invalid_mode: a client-visible status beats an
  -- accidental 4xx from a constraint. media is not private, so naming a
  -- non-existent record reveals nothing.
  if p_media_id is null or not exists (
    select 1
    from public.media as m
    where m.id = p_media_id
  ) then
    return query select 'unknown_media'::text;
    return;
  end if;

  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text;
    return;
  end if;

  -- ON CONFLICT rather than a preceding existence check: adding the same title
  -- twice is an ordinary race between two members editing the same pool, and
  -- this settles it in one statement instead of a read-then-write window.
  insert into public.pool_titles (pool_id, media_id)
  values (p_pool_id, p_media_id)
  on conflict (pool_id, media_id) do nothing;

  if not found then
    return query select 'duplicate_title'::text;
    return;
  end if;

  return query select 'added'::text;
end;
$$;

comment on function public.add_pool_title(uuid, uuid) is
  'Adds one canonical media record to a pool in the caller''s group. Idempotent: a title already present returns duplicate_title rather than erroring.';


-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- media and media_external_ids are catalogue data, not user data: they say what
-- a film is called, not who liked it. Which titles Popcorn Pact happens to have
-- cached reveals nothing about any group, so the read policy is unconditional
-- rather than a join back through pools -- that join would run on every card the
-- swipe deck renders and would protect nothing.
--
-- Writes remain server-side only, as everywhere else in this schema.
-- ---------------------------------------------------------------------------

alter table public.media enable row level security;
alter table public.media_external_ids enable row level security;

create policy "Authenticated users can read the media catalogue"
  on public.media
  for select
  to authenticated
  using (true);

create policy "Authenticated users can read media external ids"
  on public.media_external_ids
  for select
  to authenticated
  using (true);


-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------

grant select on public.media to authenticated;
grant select on public.media_external_ids to authenticated;

grant all privileges on table public.media to service_role;
grant all privileges on table public.media_external_ids to service_role;

-- upsert_media is trusted server-side plumbing with no caller-side checks of its
-- own; only the definer functions above may run it.
revoke execute on function public.upsert_media(jsonb) from public;

revoke execute on function public.add_pool_title(uuid, uuid) from public;
grant execute on function public.add_pool_title(uuid, uuid) to authenticated;
