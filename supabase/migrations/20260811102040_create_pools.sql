-- Popcorn Pact: title pools and their contents.
--
-- A "pool" is one shortlist of titles offered to a group. Pools are modelled as
-- their own table rather than as a flat per-group title list because a group has
-- more than one over its lifetime and they are not interchangeable:
--
--   generated  built server-side from the members' streaming services (Phase 4)
--   manual     assembled by a member picking titles by hand
--
-- Splitting pools from pool_titles is what makes "refresh the pile" a new row
-- rather than a destructive rewrite, and it keeps uniqueness per pool: the same
-- title may legitimately appear in a group's generated pool and in the manual
-- one at the same time. A single per-group title list keyed on
-- (group_id, tmdb_id, media_type) -- the earlier sketch -- cannot express that.
--
-- Note what is NOT here: pools carry no expiry and no size. A pool is exhausted
-- by being swiped through, not by a clock, and how many titles generation puts
-- in one is a tuning decision for the generator rather than a schema fact.
--
-- Only TMDB identifiers are stored. TMDB remains the source of truth for titles;
-- nothing here caches metadata.
--
-- Writes follow the shape established by groups: clients hold SELECT and nothing
-- else, and every mutation goes through a SECURITY DEFINER RPC that re-derives
-- membership and access state server-side. These are the first features to honour
-- the grace state the groups migration left as a note for Phase 4 -- a group over
-- its owner's entitlement keeps its existing pools readable but may not create or
-- populate any.


-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

create table public.pools (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  -- Who asked for this pool. Deliberately ON DELETE SET NULL rather than
  -- cascade: a pool belongs to the group, not to its creator, and a departing
  -- member must not take the surviving member's shortlist with them. Ownership
  -- of the group itself is reassigned by remove_member(); pools just outlive it.
  created_by uuid references public.profiles (id) on delete set null,
  -- text, not an enum: modes are product vocabulary that will gain entries
  -- (recommended, seasonal) and an enum makes each addition a migration with a
  -- transaction-boundary caveat. The check constraint is a backstop -- create_pool
  -- validates first and reports a status rather than raising.
  mode text not null,
  created_at timestamptz not null default now(),
  constraint pools_mode_valid check (mode in ('generated', 'manual'))
);

comment on table public.pools is
  'One shortlist of titles offered to a group. Written exclusively by create_pool(); clients hold SELECT only.';
comment on column public.pools.mode is
  'generated (built from the members'' streaming services) or manual (assembled by hand).';
comment on column public.pools.created_by is
  'The member who created the pool. Nulled rather than cascaded when that account is deleted, because the pool belongs to the group.';

-- Serves the RLS policy and "this group's pools", the only way pools are ever
-- listed, and backs the cascade from groups.
create index pools_group_id_idx on public.pools (group_id);

-- Not a query path, but an unindexed inbound foreign key makes every profile
-- deletion seq-scan this table.
create index pools_created_by_idx on public.pools (created_by);


create table public.pool_titles (
  pool_id uuid not null references public.pools (id) on delete cascade,
  -- The TMDB identifier pair, and nothing else. A movie and a series can share
  -- an id in TMDB, so media_type is part of the identity rather than a label.
  tmdb_id integer not null,
  media_type text not null,
  added_at timestamptz not null default now(),
  -- Doubles as the uniqueness rule the product needs -- a title appears at most
  -- once in a pool -- and as the pool_id-leading index every read and the cascade
  -- from pools require. A surrogate id would add a second index and identify
  -- nothing that this key does not.
  primary key (pool_id, tmdb_id, media_type),
  constraint pool_titles_media_type_valid check (media_type in ('movie', 'tv')),
  constraint pool_titles_tmdb_id_valid check (tmdb_id > 0)
);

comment on table public.pool_titles is
  'Titles in a pool, as TMDB identifiers only. Unique per pool, so the same title may appear in two of a group''s pools.';


-- ---------------------------------------------------------------------------
-- Client-facing RPCs.
--
-- Same contract as the group RPCs: a status row for expected outcomes ("you are
-- not in that group", "that title is already here"), RAISE reserved for genuine
-- faults. Both refuse to act on a group in grace -- this is the server-side
-- consequence of grace the groups migration anticipated.
-- ---------------------------------------------------------------------------

create function public.create_pool(p_group_id uuid, p_mode text)
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
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- Membership is checked before anything else, so a caller outside the group
  -- learns nothing about it -- not its access state, not whether it exists.
  if not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = p_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text, null::uuid;
    return;
  end if;

  -- Reported rather than left to the check constraint: a bad mode is a client
  -- bug worth naming, and an accidental 4xx from a constraint is a worse answer
  -- than a deliberate status.
  if p_mode is null or p_mode not in ('generated', 'manual') then
    return query select 'invalid_mode'::text, null::uuid;
    return;
  end if;

  -- Group features are withheld while the group exceeds its owner's
  -- entitlement. Recomputed here rather than trusted from the client.
  if public.group_access_state(p_group_id) <> 'active' then
    return query select 'group_in_grace'::text, null::uuid;
    return;
  end if;

  insert into public.pools (group_id, created_by, mode)
  values (p_group_id, v_user, p_mode)
  returning id into v_pool_id;

  return query select 'created'::text, v_pool_id;
end;
$$;

comment on function public.create_pool(uuid, text) is
  'Creates an empty pool for a group the caller belongs to. Returns not_a_member, invalid_mode or group_in_grace instead of raising.';


create function public.add_pool_title(
  p_pool_id uuid,
  p_tmdb_id integer,
  p_media_type text
)
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

  if p_media_type is null or p_media_type not in ('movie', 'tv') then
    return query select 'invalid_media_type'::text;
    return;
  end if;

  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text;
    return;
  end if;

  -- ON CONFLICT rather than a preceding existence check: adding the same title
  -- twice is an ordinary race between two members swiping the same deck, and
  -- this settles it in one statement instead of a read-then-write window.
  insert into public.pool_titles (pool_id, tmdb_id, media_type)
  values (p_pool_id, p_tmdb_id, p_media_type)
  on conflict (pool_id, tmdb_id, media_type) do nothing;

  if not found then
    return query select 'duplicate_title'::text;
    return;
  end if;

  return query select 'added'::text;
end;
$$;

comment on function public.add_pool_title(uuid, integer, text) is
  'Adds one TMDB title to a pool in the caller''s group. Idempotent: a title already present returns duplicate_title rather than erroring.';


-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Read-only for clients, as everywhere else in this schema. Reads are NOT gated
-- on access state: a group in grace keeps its data visible and loses only the
-- ability to create and populate pools, which is enforced in the RPCs above.
-- ---------------------------------------------------------------------------

alter table public.pools enable row level security;
alter table public.pool_titles enable row level security;

create policy "Members can read their groups' pools"
  on public.pools
  for select
  to authenticated
  using (group_id = any ((select public.current_user_group_ids())::uuid[]));

-- Phrased as an uncorrelated IN rather than a correlated EXISTS so the planner
-- can hoist the whole subquery into a hashed InitPlan evaluated once per
-- statement. The inner read of pools is itself subject to the policy above,
-- which selects exactly the same groups, so the double filter changes nothing.
create policy "Members can read their groups' pool titles"
  on public.pool_titles
  for select
  to authenticated
  using (
    pool_id in (
      select p.id
      from public.pools as p
      where p.group_id = any ((select public.current_user_group_ids())::uuid[])
    )
  );


-- ---------------------------------------------------------------------------
-- Grants.
--
-- New public tables are not auto-exposed to the Data API roles. Writes are
-- granted nowhere: create_pool() and add_pool_title() are the only path, so a
-- direct insert, update or delete from a client fails on privileges before RLS
-- is ever consulted.
-- ---------------------------------------------------------------------------

grant select on public.pools to authenticated;
grant select on public.pool_titles to authenticated;

-- Postgres grants EXECUTE to PUBLIC by default, so each is revoked first.
revoke execute on function public.create_pool(uuid, text) from public;
revoke execute on function public.add_pool_title(uuid, integer, text) from public;

grant execute on function public.create_pool(uuid, text) to authenticated;
grant execute on function public.add_pool_title(uuid, integer, text) to authenticated;
