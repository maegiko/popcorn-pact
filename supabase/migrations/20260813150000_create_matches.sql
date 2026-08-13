-- Popcorn Pact: match creation from pool-scoped likes.
--
-- A match is a group's agreement on one canonical title inside one pool: every
-- member current at the moment a like completes the set has liked that same
-- (pool_id, media_id). It is created by nothing but the trusted swipe path --
-- clients never assert a match, and it is evaluated only off a NEW like, never
-- off a pass, a duplicate/rejected swipe, or a membership change by itself.
--
-- Once created, a match is permanent historical state. Nothing in this schema
-- deletes or invalidates one when membership later changes -- a partner who
-- joins after the fact was not part of the agreement, and one who leaves does
-- not retroactively un-agree. See matches.group_id below for what "current
-- member" means at evaluation time.


-- ---------------------------------------------------------------------------
-- Table.
-- ---------------------------------------------------------------------------

create table public.matches (
  -- pool_id leads the key: a match is scoped to the pool it was agreed in, the
  -- same reasoning swipes carries -- the same title matching again in a later
  -- pool is a second, independent agreement, not a duplicate of this one.
  pool_id uuid not null,
  -- Denormalised from the pool, exactly like swipes.group_id: history and RLS
  -- read this without joining through pools on every row, and the composite
  -- foreign key below (reusing pools_id_group_id_key from the swipes
  -- migration) makes it structurally impossible for this to disagree with the
  -- pool's actual group.
  group_id uuid not null,
  -- Canonical identity, restrict like pool_titles and swipes: media is a
  -- replaceable cache, and evicting a cached record must never silently erase
  -- a group's match history.
  media_id uuid not null references public.media (id) on delete restrict,
  created_at timestamptz not null default now(),
  -- One match per title per pool. This is also the whole of the idempotency
  -- story: two concurrent "final like" calls for the same (pool_id, media_id)
  -- can both attempt this insert, and only one may ever succeed -- see
  -- record_swipe() below for how the loser learns that without erroring.
  primary key (pool_id, media_id),
  -- The invariant, not a convention: a match's group is its pool's group.
  -- Deleting the pool takes its matches with it, same as swipes.
  constraint matches_pool_group_fkey
    foreign key (pool_id, group_id)
    references public.pools (id, group_id)
    on delete cascade
);

comment on table public.matches is
  'A group''s agreement on one title inside one pool. Written exclusively by record_swipe(); permanent once created regardless of later membership changes.';
comment on column public.matches.group_id is
  'The pool''s group, denormalised for RLS and history. A composite foreign key guarantees it cannot disagree with pools.group_id.';

-- Provenance and "this group's match history" without joining pools -- the
-- same role swipes_group_id_idx and pools_group_id_idx play.
create index matches_group_id_idx on public.matches (group_id);

-- An unindexed inbound foreign key makes every media deletion seq-scan this
-- table.
create index matches_media_id_idx on public.matches (media_id);


-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Read-only for clients, scoped to current group membership -- the same shape
-- pools and pool_titles use. Unconditional on access state: a match already
-- made is historical fact, and grace withholds group *features*, not a
-- group's own past. Matches carry no per-user decision data (that stays on
-- swipes, which keeps its own stricter read-your-own policy untouched), so
-- there is nothing here for a partner's raw swipes to leak through.
--
-- RLS is enabled but not FORCEd, matching every other table in this schema, so
-- record_swipe()'s SECURITY DEFINER insert below can write without a
-- client-facing write policy. There is deliberately no insert/update/delete
-- policy or grant: the trusted swipe path is the only way a row is ever
-- written.
-- ---------------------------------------------------------------------------

alter table public.matches enable row level security;

create policy "Members can read their groups' matches"
  on public.matches
  for select
  to authenticated
  using (group_id = any ((select public.current_user_group_ids())::uuid[]));

grant select on public.matches to authenticated;
grant all privileges on table public.matches to service_role;


-- ---------------------------------------------------------------------------
-- Serialising match evaluation for one (pool, media) pair.
--
-- lock_swipe_slot() (see the swipes migration) serialises one member's own
-- writes, keyed on (pool_id, user_id). It does nothing for two DIFFERENT
-- members racing to complete the same match: each holds their own distinct
-- swipe-slot lock, so neither blocks the other, and under READ COMMITTED
-- neither transaction's vote-count can see the other's still-uncommitted
-- insert. If both happen to be the group's last two missing voters, both can
-- compute "not everyone yet" and neither ever creates the match -- a real,
-- permanently missed update, not a hypothetical one.
--
-- This lock closes that gap by keying on (pool_id, media_id) instead of the
-- user: whichever call gets here first finishes and commits before the second
-- is allowed to even count votes, so the second always tallies the true,
-- current state. The key material is namespaced ('match:' + pool id) so this
-- lock domain cannot collide with lock_swipe_slot's (pool id, user id) one.
-- ---------------------------------------------------------------------------

create function public.lock_match_evaluation(p_pool_id uuid, p_media_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('match:' || p_pool_id::text),
    pg_catalog.hashtext(p_media_id::text)
  );
$$;

comment on function public.lock_match_evaluation(uuid, uuid) is
  'Serialises match evaluation for one (pool, media) pair within the current transaction. Internal to record_swipe().';

revoke execute on function public.lock_match_evaluation(uuid, uuid) from public;


-- ---------------------------------------------------------------------------
-- record_swipe(), extended with the minimum-group-size gate and match
-- creation.
--
-- The return shape changes (an added match_created column), which CREATE OR
-- REPLACE cannot do for a function with OUT/table columns -- so this drops and
-- recreates it, the same move the media-identity migration made for
-- add_pool_title(). Every existing status and its meaning is unchanged;
-- callers that only ever read `status` see no behavioural difference.
-- ---------------------------------------------------------------------------

drop function public.record_swipe(uuid, uuid, text);

create function public.record_swipe(
  p_pool_id uuid,
  p_media_id uuid,
  p_decision text
)
returns table (status text, match_created boolean)
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
  v_group_id uuid;
  v_existing text;
  v_member_count integer;
  v_liked_count integer;
  v_match_created boolean;
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
    return query select 'not_a_member'::text, false;
    return;
  end if;

  -- Reported rather than left to the check constraint, for the same reason
  -- create_pool reports invalid_mode: a deliberate status beats an accidental
  -- 4xx from a constraint.
  if p_decision is null or p_decision not in ('like', 'pass') then
    return query select 'invalid_decision'::text, false;
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
    return query select 'media_not_in_pool'::text, false;
    return;
  end if;

  -- Group features are withheld while the group exceeds its owner's
  -- entitlement. Recomputed here rather than trusted from the client. Reads are
  -- deliberately NOT gated on this: a member in grace keeps their own history.
  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text, false;
    return;
  end if;

  -- The shared-decision loop has nothing to share below two people. This is a
  -- structural precondition of matching, not an entitlement question -- a
  -- solo group is not over anyone's limit, it simply cannot produce a match
  -- yet -- so it is its own gate rather than folded into grace above.
  -- Recomputed from current membership, never trusted from the client.
  if (
    select count(*) from public.group_members as gm where gm.group_id = v_group_id
  ) < 2 then
    return query select 'group_too_small'::text, false;
    return;
  end if;

  perform public.lock_swipe_slot(p_pool_id, v_user);

  select s.decision
  into v_existing
  from public.swipes as s
  where s.pool_id = p_pool_id
    and s.user_id = v_user
    and s.media_id = p_media_id;

  -- EVERY BRANCH HERE LEAVES STATE UNTOUCHED, including undo eligibility and
  -- match state. A duplicate tap and a rejected transition are not new
  -- decisions -- the member has told us nothing they had not already said --
  -- so neither may consume the previous swipe's undo, and neither may
  -- re-evaluate a match that either already exists or was never eligible.
  if found then
    if v_existing = p_decision then
      return query select 'already_recorded'::text, false;
    elsif v_existing = 'like' then
      -- A like is half of a match. It is not withdrawn by swiping the other way.
      return query select 'like_final'::text, false;
    else
      -- A pass is reversible, but only deliberately, through undo_last_pass().
      return query select 'pass_must_be_undone'::text, false;
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

  -- Match evaluation follows only a brand-new like. A pass has nothing to
  -- agree on, and every other outcome above already returned.
  if p_decision = 'like' then
    perform public.lock_match_evaluation(p_pool_id, p_media_id);

    select count(*)
    into v_member_count
    from public.group_members as gm
    where gm.group_id = v_group_id;

    select count(*)
    into v_liked_count
    from public.group_members as gm
    join public.swipes as s
      on s.pool_id = p_pool_id
     and s.user_id = gm.user_id
     and s.media_id = p_media_id
     and s.decision = 'like'
    where gm.group_id = v_group_id;

    -- Re-checked here, not just at the gate above: the two reads are separate
    -- statements, so a concurrent departure between them is possible in
    -- principle, and this is what stops a group that dropped to one member
    -- from "matching" against itself.
    if v_member_count >= 2 and v_liked_count = v_member_count then
      -- ON CONFLICT DO NOTHING is the idempotency backstop the (pool_id,
      -- media_id) primary key exists for: even if this branch is somehow
      -- reached twice for the same title, only one insert can ever succeed.
      -- The missing RETURNING row on a conflict is exactly how a retry (or
      -- the loser of the lock above) reports match_created = false instead of
      -- raising.
      insert into public.matches (pool_id, group_id, media_id)
      values (p_pool_id, v_group_id, p_media_id)
      on conflict (pool_id, media_id) do nothing
      returning true into v_match_created;
    end if;
  end if;

  return query select 'recorded'::text, coalesce(v_match_created, false);
end;
$$;

comment on function public.record_swipe(uuid, uuid, text) is
  'Records the caller''s like or pass for a title in one of their pools, and creates a match when a new like completes every current member''s agreement. Returns recorded, already_recorded, like_final, pass_must_be_undone, invalid_decision, media_not_in_pool, not_a_member, group_in_grace or group_too_small instead of raising, plus match_created for the recorded case.';

revoke execute on function public.record_swipe(uuid, uuid, text) from public;
grant execute on function public.record_swipe(uuid, uuid, text) to authenticated;
