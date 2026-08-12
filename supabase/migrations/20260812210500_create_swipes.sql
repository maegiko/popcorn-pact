-- Popcorn Pact: pool-scoped swipe persistence.
--
-- A swipe is one member's decision about one title inside one pool. Three
-- properties of that sentence are load-bearing, and each of them is enforced
-- here rather than trusted from a client:
--
--   pool-scoped     The same person may honestly decide differently about the
--                   same title in a different pool. A pass on Tuesday's pile is
--                   a verdict on the title *in that context*, not forever, so
--                   the uniqueness key is (pool_id, user_id, media_id) and not
--                   (group_id, user_id, media_id).
--   private         Raw swipe rows are the member's own. A partner must never
--                   read them: seeing "they passed on this" before a match is
--                   exactly the social pressure the product exists to avoid.
--                   Match detection will read them later through trusted
--                   server-side logic, which is not the same as exposing them.
--   canonical       Identity is media.id. No provider id appears here, so the
--                   core loop survives a change of media provider.
--
-- Verdict transitions are deliberately asymmetric:
--
--   (nothing) -> like     recorded
--   (nothing) -> pass     recorded
--   like      -> like     already_recorded      idempotent, not an error
--   pass      -> pass     already_recorded
--   like      -> pass     like_final            a like is a commitment
--   pass      -> like     pass_must_be_undone   requires an explicit undo
--
-- A like is final because it is half of a match: allowing it to be silently
-- withdrawn would let one member retract agreement the other has already been
-- told about. A pass is reversible, but only through undo_last_pass(), and only
-- for as long as it is the decision just made -- see `undoable` below.


-- ---------------------------------------------------------------------------
-- A pool's group, as something the database can check.
--
-- swipes carries group_id denormalised, so that history and future match queries
-- do not join through pools on every row. Denormalised provenance is only safe
-- while it cannot drift, and "the RPC always sets it correctly" is not a
-- guarantee -- it is a promise about code that will be edited by someone who has
-- not read this file.
--
-- This unique constraint is redundant on its own, since id is already the
-- primary key. It exists to give swipes a composite key to reference, which is
-- what lets a foreign key state the invariant declaratively: a swipe's group is
-- its pool's group, or the row does not exist. Same device as
-- media_external_ids' (media_id, media_type).
-- ---------------------------------------------------------------------------

alter table public.pools
  add constraint pools_id_group_id_key unique (id, group_id);


-- ---------------------------------------------------------------------------
-- Table.
-- ---------------------------------------------------------------------------

create table public.swipes (
  id uuid primary key default gen_random_uuid(),
  -- The pool is the unit of context, so it leads every key and index here.
  pool_id uuid not null,
  -- Derived from the pool by record_swipe() and never taken from a caller. The
  -- composite foreign key below is what makes that structurally true rather
  -- than merely intended.
  group_id uuid not null,
  -- profiles rather than auth.users, matching group_members: profiles.id already
  -- cascades from auth.users, and PostgREST can only embed across a foreign key
  -- it can see in the exposed schema.
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Canonical identity. restrict, like pool_titles: media is a replaceable
  -- cache, and evicting a cached record must never silently erase someone's
  -- decisions.
  media_id uuid not null references public.media (id) on delete restrict,
  decision text not null,
  -- UNDO ELIGIBILITY. True on exactly the pass a member could still take back:
  -- the one they just made. Recording any *new* decision in the same pool clears
  -- it, which is what makes undo immediate-only.
  --
  -- This has to be stored rather than derived. The rule is "the pass just made",
  -- and after pass A -> pass B -> undo, A is once again the member's newest
  -- surviving row in that pool -- so no ordering over the surviving rows can
  -- tell it apart from a pass that was genuinely just made. The fact that B ever
  -- existed is precisely what must be remembered, and deleting B destroys every
  -- trace of it except this flag on A.
  --
  -- Clients may read it on their own rows, so a deck can offer or hide undo
  -- without asking the server what would happen.
  undoable boolean not null default false,
  -- Deterministic order of a member's decisions. now() is transaction start
  -- time, so several swipes made in one transaction -- or two landing in the
  -- same millisecond -- are indistinguishable by created_at. An identity column
  -- is assigned from a sequence per insert and is therefore a total order over
  -- insertions.
  --
  -- Undo no longer reads this; `undoable` answers that question directly. It is
  -- kept because decision order is unrecoverable if it is not captured as it
  -- happens, and everything later built on swipe history -- taste profiles,
  -- "what did we do last night", debugging a deck that behaved oddly -- needs
  -- it. Eight bytes and a sequence is a cheap price for a fact that cannot be
  -- reconstructed afterwards.
  --
  -- Gaps are expected and harmless. Sequences are non-transactional, so a
  -- rolled-back swipe burns a value; nothing here reads seq as a count.
  seq bigint not null generated always as identity,
  created_at timestamptz not null default now(),
  constraint swipes_decision_valid check (decision in ('like', 'pass')),
  -- Only a pass is ever reversible, so a like carrying undo eligibility would be
  -- a contradiction rather than a harmless oddity.
  constraint swipes_only_pass_is_undoable check (not undoable or decision = 'pass'),
  -- One current verdict per title per pool per member. This is what makes a
  -- second swipe a transition to be judged rather than a duplicate row.
  constraint swipes_one_verdict_per_pool_title unique (pool_id, user_id, media_id),
  -- The invariant, not a convention: a swipe's group is its pool's group.
  -- Deleting the pool takes its swipes with it, which also carries the cascade
  -- from groups, since deleting a group already cascades to its pools.
  constraint swipes_pool_group_fkey
    foreign key (pool_id, group_id)
    references public.pools (id, group_id)
    on delete cascade
);

comment on table public.swipes is
  'One member''s private decision about one title inside one pool. Written exclusively by record_swipe() and undo_last_pass(); readable only by its own author.';
comment on column public.swipes.group_id is
  'The pool''s group, denormalised for history and match queries. A composite foreign key guarantees it cannot disagree with pools.group_id.';
comment on column public.swipes.undoable is
  'True on the one pass this member could still take back in this pool. Cleared by any subsequent decision, which is what makes undo immediate-only.';
comment on column public.swipes.seq is
  'Monotonic insertion order for a member''s decisions. Not read by undo; kept because decision order cannot be reconstructed later.';

-- AT MOST ONE UNDOABLE PASS per member per pool, enforced by the database
-- rather than by the two functions that happen to maintain it. If a future
-- writer forgets to clear the previous flag, this rejects the write instead of
-- quietly making two passes undoable.
create unique index swipes_one_undoable_per_pool_user
  on public.swipes (pool_id, user_id)
  where undoable;

-- Provenance and history: "everything this group decided" without joining pools,
-- which is the whole reason group_id is carried here.
create index swipes_group_id_idx on public.swipes (group_id);

-- An unindexed inbound foreign key makes every media deletion seq-scan this
-- table.
create index swipes_media_id_idx on public.swipes (media_id);

-- The unique constraint above is led by pool_id, so it cannot answer "everything
-- this member has ever decided" -- the query a taste profile will be built from.
create index swipes_user_id_idx on public.swipes (user_id);


-- ---------------------------------------------------------------------------
-- Serialising one member's writes within one pool.
--
-- Both functions below read the member's current state in a pool and then write
-- based on what they found, which is only safe if no other write for the same
-- member and pool can land in between. An advisory lock is the cheapest way to
-- say that: it is held for the transaction, released automatically, and both
-- functions take exactly one, so there is no lock ordering to get wrong.
--
-- Contention is effectively nil -- it serialises one person swiping one deck
-- against themselves, which is what a double-tap or two signed-in devices
-- produce. It is not a table lock and does not touch other members or pools.
-- ---------------------------------------------------------------------------

create function public.lock_swipe_slot(p_pool_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_pool_id::text),
    pg_catalog.hashtext(p_user_id::text)
  );
$$;

comment on function public.lock_swipe_slot(uuid, uuid) is
  'Serialises one member''s swipe writes within one pool for the current transaction. Internal to record_swipe() and undo_last_pass().';


-- ---------------------------------------------------------------------------
-- Recording a decision.
--
-- Same contract as the pool RPCs: a status row for expected outcomes, RAISE
-- reserved for genuine faults. Caller identity comes from auth.uid() and from
-- nowhere else, so there is no user id to forge.
-- ---------------------------------------------------------------------------

create function public.record_swipe(
  p_pool_id uuid,
  p_media_id uuid,
  p_decision text
)
returns table (status text)
language plpgsql
security definer
set search_path = ''
as $$
-- The OUT parameter shadows a same-named column in this body; every column
-- reference is table-qualified, and this pragma resolves any that is missed to
-- the column rather than erroring.
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_group_id uuid;
  v_existing text;
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

  -- Reported rather than left to the check constraint, for the same reason
  -- create_pool reports invalid_mode: a deliberate status beats an accidental
  -- 4xx from a constraint.
  if p_decision is null or p_decision not in ('like', 'pass') then
    return query select 'invalid_decision'::text;
    return;
  end if;

  -- The pool is the unit of context, so a title outside it has no verdict to
  -- record. Checked before grace because it is a question about the request
  -- rather than about the group's entitlement.
  if p_media_id is null or not exists (
    select 1
    from public.pool_titles as pt
    where pt.pool_id = p_pool_id
      and pt.media_id = p_media_id
  ) then
    return query select 'media_not_in_pool'::text;
    return;
  end if;

  -- Group features are withheld while the group exceeds its owner's
  -- entitlement. Recomputed here rather than trusted from the client. Reads are
  -- deliberately NOT gated on this: a member in grace keeps their own history.
  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text;
    return;
  end if;

  perform public.lock_swipe_slot(p_pool_id, v_user);

  select s.decision
  into v_existing
  from public.swipes as s
  where s.pool_id = p_pool_id
    and s.user_id = v_user
    and s.media_id = p_media_id;

  -- EVERY BRANCH HERE LEAVES STATE UNTOUCHED, including undo eligibility. A
  -- duplicate tap and a rejected transition are not new decisions -- the member
  -- has told us nothing they had not already said -- so neither may consume the
  -- undo the previous swipe earned.
  if found then
    if v_existing = p_decision then
      return query select 'already_recorded'::text;
    elsif v_existing = 'like' then
      -- A like is half of a match. It is not withdrawn by swiping the other way.
      return query select 'like_final'::text;
    else
      -- A pass is reversible, but only deliberately, through undo_last_pass().
      return query select 'pass_must_be_undone'::text;
    end if;

    return;
  end if;

  -- Past this point the member has genuinely decided something new, which is
  -- what retires the previous pass's undo. Cleared before the insert, so the
  -- one-undoable-per-pool index is never momentarily violated.
  update public.swipes as s
  set undoable = false
  where s.pool_id = p_pool_id
    and s.user_id = v_user
    and s.undoable;

  -- group_id comes from the pool, never from the caller; the composite foreign
  -- key would reject it otherwise.
  insert into public.swipes (pool_id, group_id, user_id, media_id, decision, undoable)
  values (p_pool_id, v_group_id, v_user, p_media_id, p_decision, p_decision = 'pass');

  return query select 'recorded'::text;
end;
$$;

comment on function public.record_swipe(uuid, uuid, text) is
  'Records the caller''s like or pass for a title in one of their pools. Returns recorded, already_recorded, like_final, pass_must_be_undone, invalid_decision, media_not_in_pool, not_a_member or group_in_grace instead of raising.';


-- ---------------------------------------------------------------------------
-- Undoing the pass just made.
--
-- Immediate-only: it reverses the decision the member is still looking at, and
-- nothing older. Once any further decision is recorded in that pool, the earlier
-- pass is settled for the life of the pool -- it can be met again only in a
-- later pool, which is what pool-scoping is for.
--
-- This is deliberately not "remove my most recent pass". A member who passed on
-- A and then liked B has moved on, and reaching back to delete A would undo
-- something they are no longer looking at. Undo is a correction to the card just
-- swiped, not a history editor.
-- ---------------------------------------------------------------------------

create function public.undo_last_pass(p_pool_id uuid)
returns table (status text, media_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_group_id uuid;
  v_media_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  select p.group_id
  into v_group_id
  from public.pools as p
  where p.id = p_pool_id;

  if v_group_id is null or not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = v_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text, null::uuid;
    return;
  end if;

  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text, null::uuid;
    return;
  end if;

  perform public.lock_swipe_slot(p_pool_id, v_user);

  -- At most one row can match, by the partial unique index. Deleting it leaves
  -- nothing undoable in this pool, so a second undo finds nothing -- eligibility
  -- is consumed by being used, never handed back to an older pass.
  delete from public.swipes as s
  where s.pool_id = p_pool_id
    and s.user_id = v_user
    and s.undoable
  returning s.media_id into v_media_id;

  if v_media_id is null then
    return query select 'nothing_to_undo'::text, null::uuid;
    return;
  end if;

  -- The row is gone, so the title is unresolved again and may be liked or
  -- passed normally. A fresh pass on it becomes undoable in its own right.
  return query select 'undone'::text, v_media_id;
end;
$$;

comment on function public.undo_last_pass(uuid) is
  'Removes the caller''s pass in a pool while it is still the decision just made, returning the title it freed. Returns nothing_to_undo once any later decision has retired it, plus not_a_member and group_in_grace.';


-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Read-your-own, and nothing else. This is stricter than every other table in
-- the schema, which scope reads to the caller's groups: a swipe is not group
-- data. A partner learning "they passed on this" outside a match is the one
-- disclosure that would change how people swipe, so the policy does not consult
-- group membership at all.
--
-- Reads are NOT gated on access state. A group in grace keeps its members' own
-- history visible and loses only the ability to record and undo, which is
-- enforced in the RPCs above.
-- ---------------------------------------------------------------------------

alter table public.swipes enable row level security;

create policy "Users can read only their own swipes"
  on public.swipes
  for select
  to authenticated
  using (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- Grants.
--
-- Writes are granted nowhere: record_swipe() and undo_last_pass() are the only
-- path, so a direct insert, update or delete from a client fails on privileges
-- before RLS is ever consulted.
-- ---------------------------------------------------------------------------

grant select on public.swipes to authenticated;
grant all privileges on table public.swipes to service_role;

-- Postgres grants EXECUTE to PUBLIC by default, so each is revoked first.
revoke execute on function public.lock_swipe_slot(uuid, uuid) from public;
revoke execute on function public.record_swipe(uuid, uuid, text) from public;
revoke execute on function public.undo_last_pass(uuid) from public;

-- lock_swipe_slot is internal plumbing with no caller-side checks of its own;
-- only the definer functions above may run it.
grant execute on function public.record_swipe(uuid, uuid, text) to authenticated;
grant execute on function public.undo_last_pass(uuid) to authenticated;
