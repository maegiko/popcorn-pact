-- Popcorn Pact: pool finalization and planned watch time.
--
-- Two related additions to the pool lifecycle:
--
--   planned_for       when the group intends to watch. Optional, editable, and
--                     deliberately independent of finalization -- a group may
--                     schedule before choosing, choose without scheduling, and
--                     reschedule after choosing.
--   finalization      the group's owner closes the pool on exactly one of its
--                     matches. One-way: it sets winner_media_id, finalized_at
--                     and status='completed', and nothing may undo it.
--
-- Finalization is where the pool's lifecycle stops being advisory. Up to now
-- 'completed' was a label the pool_lifecycle slice let a privileged writer set
-- and unset freely; a *finalized* pool is different, and the guard trigger
-- below distinguishes the two by finalized_at rather than by status, so the
-- earlier slice's "a pool may be reopened" behaviour survives untouched while
-- the finalized case becomes genuinely irreversible.
--
-- What finalization is NOT: it is not watching. It records that the group
-- decided, exactly as a match records that they agreed. Nothing here writes,
-- implies or reserves watched state, and swipes and matches survive as history.


-- ---------------------------------------------------------------------------
-- Columns.
-- ---------------------------------------------------------------------------

alter table public.pools
  add column planned_for timestamptz,
  add column winner_media_id uuid,
  add column finalized_at timestamptz;

comment on column public.pools.planned_for is
  'When the group intends to watch this pool''s pick. Optional, owner-editable, and independent of finalization -- it may be set before, without, or after choosing a winner.';
comment on column public.pools.winner_media_id is
  'The single match this pool was finalized on. Null until finalization; immutable afterwards.';
comment on column public.pools.finalized_at is
  'When the pool was finalized. Non-null is what makes a pool irreversibly completed, as opposed to merely carrying status=''completed''.';


-- A winner only exists on a completed pool. The converse deliberately does NOT
-- hold: the pool_lifecycle slice allows a pool to be completed without ever
-- being finalized, and that remains legal.
alter table public.pools
  add constraint pools_winner_requires_completed
  check (winner_media_id is null or status = 'completed');

-- The two halves of "this pool was finalized" are written together or not at
-- all, so no row can claim a winner with no timestamp or a timestamp with no
-- winner. This is also what lets the guard trigger key on finalized_at alone.
alter table public.pools
  add constraint pools_finalization_recorded_together
  check ((winner_media_id is null) = (finalized_at is null));

-- THE WINNER MUST BE A MATCH IN THIS POOL, stated declaratively rather than
-- trusted from the RPCs. matches is keyed on exactly (pool_id, media_id), so
-- this composite foreign key says "the winner is one of the titles this group
-- agreed on, in this pool" in the schema itself -- a winner drawn from another
-- pool cannot be stored even by a privileged writer.
--
-- NO ACTION rather than RESTRICT on purpose: NO ACTION is checked at end of
-- statement, so deleting a pool (or a group, which cascades to pools and then
-- to matches) still works -- the referencing pool row is already gone by the
-- time the check runs. RESTRICT would fire mid-cascade and block it.
alter table public.pools
  add constraint pools_winner_is_a_match_fkey
  foreign key (id, winner_media_id)
  references public.matches (pool_id, media_id);


-- ---------------------------------------------------------------------------
-- Finalization is irreversible.
--
-- A check constraint cannot express this: irreversibility is a statement about
-- a transition, not about a row. The trigger keys on OLD.finalized_at, so:
--
--   never finalized   every existing update still allowed, including the
--                     completed -> active reopen the pool_lifecycle slice
--                     relies on
--   finalized         status, winner and finalized_at are frozen; everything
--                     else (planned_for, created_by) stays editable
--
-- planned_for staying editable is the point of the column-level granularity:
-- rescheduling a night is not reopening a decision, and the owner must be able
-- to move the date after the pick without the pick being at risk.
-- ---------------------------------------------------------------------------

create function public.pools_guard_finalization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.finalized_at is null then
    return new;
  end if;

  if new.status is distinct from old.status then
    raise exception 'pool % is finalized and cannot change status', old.id
      using errcode = 'check_violation';
  end if;

  if new.winner_media_id is distinct from old.winner_media_id then
    raise exception 'pool % is finalized and its winner cannot change', old.id
      using errcode = 'check_violation';
  end if;

  if new.finalized_at is distinct from old.finalized_at then
    raise exception 'pool % is finalized and finalized_at cannot change', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.pools_guard_finalization() is
  'Freezes status, winner_media_id and finalized_at once a pool has been finalized. Pools that were never finalized are untouched, including the completed -> active reopen the pool lifecycle allows.';

create trigger pools_guard_finalization
  before update on public.pools
  for each row
  execute function public.pools_guard_finalization();


-- ---------------------------------------------------------------------------
-- Backfill: every pool's owner must be a current member of its group.
--
-- created_by has existed since the pools slice, but it meant only "who asked
-- for this". It now carries authority -- scheduling and finalization -- so a
-- value that predates that meaning has to be re-derived rather than trusted.
--
-- Two kinds of row are repaired, using the same rule ownership transfer uses
-- below (longest-standing current member, user_id as the tiebreak, matching
-- remove_member()'s ordering exactly):
--
--   created_by is null          left behind by the ON DELETE SET NULL when an
--                               owner's account was deleted
--   created_by is not a member  the owner left the group before this slice
--                               existed to transfer ownership
--
-- A pool whose group somehow has no members at all is deliberately left null.
-- Ownership is authority, and inventing an owner for an unusual dev row would
-- hand someone the ability to finalize a group's pool. Null fails closed: the
-- RPCs below compare the caller against created_by, and nobody equals null.
-- That is also why created_by stays nullable rather than becoming NOT NULL --
-- there is no safe value to invent for such a row, and the existing
-- ON DELETE SET NULL behaviour is deliberate (a pool belongs to the group, not
-- to whoever asked for it).
-- ---------------------------------------------------------------------------

update public.pools as p
set created_by = (
  select gm.user_id
  from public.group_members as gm
  where gm.group_id = p.group_id
  order by gm.joined_at, gm.user_id
  limit 1
)
where p.created_by is null
   or not exists (
     select 1
     from public.group_members as gm
     where gm.group_id = p.group_id
       and gm.user_id = p.created_by
   );


-- ---------------------------------------------------------------------------
-- Ownership transfer on departure.
--
-- remove_member() is already the single implementation of "this user is no
-- longer in this group", shared by leave_group() and by account deletion, and
-- it already reassigns group ownership to the longest-standing remaining
-- member. Pool ownership follows the same rule and the same ordering, in the
-- same function, for the same reason the group rule exists: a pool must never
-- be left pointing at a non-member, or its scheduling and finalization
-- controls become unreachable for everyone.
--
-- Only pools the departing member actually owned are moved. A pool created by
-- someone still in the group is not theirs to lose.
-- ---------------------------------------------------------------------------

create or replace function public.remove_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_owner boolean;
  v_next_owner uuid;
begin
  -- Lock the group first so two concurrent departures cannot both observe a
  -- remaining member and both decline to delete the group.
  select g.created_by = p_user_id
  into v_was_owner
  from public.groups as g
  where g.id = p_group_id
  for update;

  if not found then
    return;
  end if;

  delete from public.group_members as gm
  where gm.group_id = p_group_id
    and gm.user_id = p_user_id;

  select gm.user_id
  into v_next_owner
  from public.group_members as gm
  where gm.group_id = p_group_id
  order by gm.joined_at, gm.user_id
  limit 1;

  if v_next_owner is null then
    -- Last one out. Invites cascade, and so do pools -- there is no one left
    -- to inherit them.
    delete from public.groups as g where g.id = p_group_id;
    return;
  end if;

  if v_was_owner then
    -- Ownership passes to the longest-standing remaining member. Their
    -- entitlement now governs the group, which may put it into grace.
    update public.groups as g
    set created_by = v_next_owner
    where g.id = p_group_id;
  end if;

  -- Pool ownership follows the member, not the group: this runs whether or not
  -- the departing member owned the group, because a non-owner member can own
  -- pools. Finalized pools are included -- the guard trigger above permits a
  -- created_by change, since inheriting a settled pool is not reopening it.
  update public.pools as p
  set created_by = v_next_owner
  where p.group_id = p_group_id
    and p.created_by = p_user_id;
end;
$$;

revoke execute on function public.remove_member(uuid, uuid) from public;


-- ---------------------------------------------------------------------------
-- Planned watch time.
--
-- Owner-only, and deliberately allowed on a completed pool: "we're watching it
-- on Friday" is a decision about a night, not about the pick, so finalizing
-- must not strand the schedule and rescheduling must not disturb the winner.
-- The guard trigger enforces the second half of that.
--
-- No lifecycle lock is taken. planned_for is orthogonal to finalization -- it
-- is legal in both states -- so there is no check here that finalization could
-- invalidate, and two concurrent reschedules settling last-write-wins on a
-- single timestamp is the correct outcome rather than a race to prevent.
-- ---------------------------------------------------------------------------

create function public.set_pool_planned_for(p_pool_id uuid, p_planned_for timestamptz)
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
  v_owner uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  select p.group_id, p.created_by
  into v_group_id, v_owner
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

  -- IS DISTINCT FROM, not <>: an ownerless pool (see the backfill above) must
  -- refuse everyone rather than compare NULL and fall through.
  if v_owner is distinct from v_user then
    return query select 'not_creator'::text;
    return;
  end if;

  -- Group features are withheld while the group exceeds its owner's
  -- entitlement, as everywhere else. Recomputed here rather than trusted.
  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text;
    return;
  end if;

  update public.pools as p
  set planned_for = p_planned_for
  where p.id = p_pool_id;

  return query select 'updated'::text;
end;
$$;

comment on function public.set_pool_planned_for(uuid, timestamptz) is
  'Sets, changes or clears when the pool''s owner plans to watch. Allowed on a completed pool, which never disturbs the winner. Returns updated, not_a_member, not_creator or group_in_grace instead of raising.';


-- ---------------------------------------------------------------------------
-- Finalization.
--
-- THE POOL LIFECYCLE LOCK. Both functions below take `for update` on the pool
-- row before reading anything they then decide on, and record_swipe() /
-- undo_last_pass() take `for share` on the same row for the same reason. That
-- pair is the whole concurrency design:
--
--   for share (swipes)      many members may swipe one pool at once
--   for update (finalize)   finalizing excludes every swipe, and every swipe
--                           excludes finalizing
--
-- Checking pools.status without the lock would be a TOCTOU hole in both
-- directions: a swipe could read 'active', then finalization could commit, and
-- the swipe would then write into a settled pool. Reading the status *under*
-- the lock closes it, because whichever transaction acquires first commits
-- before the other is allowed to look. Postgres re-evaluates a blocked locking
-- SELECT against the newest committed row, so the loser sees 'completed'
-- rather than the stale row it queued on.
--
-- LOCK ORDER, identical in every function that takes more than one:
--
--   1. pool lifecycle       pools row, for share (swipes) / for update (finalize)
--   2. per-member swipe     lock_swipe_slot(pool_id, user_id)
--   3. per-title match      lock_match_evaluation(pool_id, media_id)
--
-- record_swipe takes 1 -> 2 -> 3, undo_last_pass takes 1 -> 2, and the two
-- finalizers take only 1. No function ever takes them out of order and none
-- upgrades a share lock to an exclusive one, so no cycle can form.
-- ---------------------------------------------------------------------------

create function public.finalize_pool(p_pool_id uuid, p_media_id uuid)
returns table (status text, media_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_group_id uuid;
  v_owner uuid;
  v_status text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- Lock first, read second. Everything below decides on v_status and on the
  -- match set, and both are only trustworthy while this lock is held.
  select p.group_id, p.created_by, p.status
  into v_group_id, v_owner, v_status
  from public.pools as p
  where p.id = p_pool_id
  for update;

  if v_group_id is null or not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = v_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text, null::uuid;
    return;
  end if;

  if v_owner is distinct from v_user then
    return query select 'not_creator'::text, null::uuid;
    return;
  end if;

  -- Read under the lock, so a finalization that committed while this call was
  -- queued is already visible here. This is the single point at which two
  -- racing finalizers -- manual against manual, manual against random -- are
  -- resolved into exactly one winner.
  if v_status = 'completed' then
    return query select 'already_completed'::text, null::uuid;
    return;
  end if;

  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text, null::uuid;
    return;
  end if;

  -- Reported separately from media_not_matched: "nobody has agreed on anything
  -- yet" and "that particular title is not one of your matches" are different
  -- problems with different fixes.
  if not exists (
    select 1
    from public.matches as m
    where m.pool_id = p_pool_id
  ) then
    return query select 'no_matches'::text, null::uuid;
    return;
  end if;

  -- Scoped to this pool, so a match the group made in a *different* pool is
  -- not a valid winner here. The composite foreign key on pools would reject it
  -- anyway; this turns that into a status rather than a constraint error.
  if p_media_id is null or not exists (
    select 1
    from public.matches as m
    where m.pool_id = p_pool_id
      and m.media_id = p_media_id
  ) then
    return query select 'media_not_matched'::text, null::uuid;
    return;
  end if;

  update public.pools as p
  set status = 'completed',
      winner_media_id = p_media_id,
      finalized_at = now()
  where p.id = p_pool_id;

  return query select 'finalized'::text, p_media_id;
end;
$$;

comment on function public.finalize_pool(uuid, uuid) is
  'Closes a pool on one of its own matches, chosen by the pool''s owner. One-way. Returns finalized, not_a_member, not_creator, already_completed, group_in_grace, no_matches or media_not_matched instead of raising.';


-- Identical contract, except the group is asking the database to choose. The
-- draw is uniform over the pool's current matches and consults nothing else --
-- no ranking, no taste signal, no provider or recency weighting. That is the
-- product promise of the button: it is a coin toss the pair agreed to abide by,
-- and anything that tilted it would make it a recommendation instead.
--
-- The choice is made server-side inside the same transaction and under the same
-- lock as the write, so the client can neither see the candidate set nor retry
-- until it likes the answer.
create function public.finalize_pool_random(p_pool_id uuid)
returns table (status text, media_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_group_id uuid;
  v_owner uuid;
  v_status text;
  v_media_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  select p.group_id, p.created_by, p.status
  into v_group_id, v_owner, v_status
  from public.pools as p
  where p.id = p_pool_id
  for update;

  if v_group_id is null or not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = v_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text, null::uuid;
    return;
  end if;

  if v_owner is distinct from v_user then
    return query select 'not_creator'::text, null::uuid;
    return;
  end if;

  if v_status = 'completed' then
    return query select 'already_completed'::text, null::uuid;
    return;
  end if;

  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text, null::uuid;
    return;
  end if;

  -- order by random() limit 1 over the pool's matches: one row, uniformly
  -- drawn, evaluated under the lock so the candidate set cannot grow between
  -- the draw and the write. With a single match this necessarily returns it.
  select m.media_id
  into v_media_id
  from public.matches as m
  where m.pool_id = p_pool_id
  order by random()
  limit 1;

  if v_media_id is null then
    return query select 'no_matches'::text, null::uuid;
    return;
  end if;

  update public.pools as p
  set status = 'completed',
      winner_media_id = v_media_id,
      finalized_at = now()
  where p.id = p_pool_id;

  return query select 'finalized'::text, v_media_id;
end;
$$;

comment on function public.finalize_pool_random(uuid) is
  'Closes a pool on one of its own matches, drawn uniformly at random server-side. Same one-way contract and statuses as finalize_pool, minus media_not_matched.';


-- ---------------------------------------------------------------------------
-- record_swipe(), with the pool lifecycle gate.
--
-- FINALIZATION OVERRIDES THE LIKE. The pool row is locked `for share` before
-- the status is read, and held for the rest of the transaction, so:
--
--   like commits first       finalization queues behind it and sees the match
--                            the like created -- a like that genuinely landed
--                            first is in the candidate set
--   finalize commits first   the like's locking SELECT unblocks against the
--                            newly committed row, reads 'completed', and
--                            returns pool_completed having written nothing
--
-- There is no interleaving in which a swipe reads 'active' and then writes
-- after finalization committed, because the read and the write are inside one
-- transaction that holds the share lock across both, and finalization cannot
-- take `for update` until that transaction ends.
--
-- PRECEDENCE. pool_completed sits after the request-shape checks and before the
-- group-state ones:
--
--   not_a_member / invalid_decision / media_not_in_pool   is this request coherent?
--   pool_completed                                        is this pool still open?
--   group_in_grace / group_too_small                      may this group act?
--
-- The middle question is about the narrowest object in play. Once the pool is
-- closed the group's entitlement and headcount cannot change the answer, which
-- is why a finalized pool in a one-member group answers pool_completed rather
-- than group_too_small.
-- ---------------------------------------------------------------------------

create or replace function public.record_swipe(
  p_pool_id uuid,
  p_media_id uuid,
  p_decision text
)
returns table (status text, match_created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_group_id uuid;
  v_pool_status text;
  v_existing text;
  v_member_count integer;
  v_liked_count integer;
  v_match_created boolean;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- LOCK 1: pool lifecycle, shared. Taken before the status is read and held
  -- for the transaction, so finalization cannot slip between this read and the
  -- writes below. Shared rather than exclusive because two members swiping the
  -- same deck do not conflict with each other -- only with finalization.
  select p.group_id, p.status
  into v_group_id, v_pool_status
  from public.pools as p
  where p.id = p_pool_id
  for share;

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

  -- The pool is settled. Nothing further is recorded in it -- no swipe, no
  -- undo eligibility change, no match -- and nothing already recorded is
  -- disturbed.
  if v_pool_status = 'completed' then
    return query select 'pool_completed'::text, false;
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
  if (
    select count(*) from public.group_members as gm where gm.group_id = v_group_id
  ) < 2 then
    return query select 'group_too_small'::text, false;
    return;
  end if;

  -- LOCK 2: this member's own writes in this pool.
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
    -- LOCK 3: this title's match evaluation in this pool.
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
  'Records the caller''s like or pass for a title in one of their pools, and creates a match when a new like completes every current member''s agreement. Returns recorded, already_recorded, like_final, pass_must_be_undone, invalid_decision, media_not_in_pool, pool_completed, not_a_member, group_in_grace or group_too_small instead of raising, plus match_created for the recorded case.';


-- ---------------------------------------------------------------------------
-- undo_last_pass(), with the same gate.
--
-- Undo is a delete, and a finalized pool's swipes are history. Leaving this
-- open would be a mutation backdoor into a settled pool: a member could not add
-- to it through record_swipe, but could still remove from it here, quietly
-- rewriting the evidence behind a decision the group has already made. The
-- same status is returned for the same reason, and the same lifecycle lock is
-- taken first so the check cannot be raced.
-- ---------------------------------------------------------------------------

create or replace function public.undo_last_pass(p_pool_id uuid)
returns table (status text, media_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_group_id uuid;
  v_pool_status text;
  v_media_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- LOCK 1: pool lifecycle, shared -- same order and same reasoning as
  -- record_swipe above.
  select p.group_id, p.status
  into v_group_id, v_pool_status
  from public.pools as p
  where p.id = p_pool_id
  for share;

  if v_group_id is null or not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = v_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text, null::uuid;
    return;
  end if;

  if v_pool_status = 'completed' then
    return query select 'pool_completed'::text, null::uuid;
    return;
  end if;

  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text, null::uuid;
    return;
  end if;

  -- LOCK 2: this member's own writes in this pool.
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
  'Removes the caller''s pass in a pool while it is still the decision just made, returning the title it freed. Returns nothing_to_undo once any later decision has retired it, plus not_a_member, pool_completed and group_in_grace.';


-- ---------------------------------------------------------------------------
-- Grants.
--
-- No new grants on pools: planned_for, winner_media_id and finalized_at are
-- columns on a table members already read through the existing policy, so
-- current members see them, grace still preserves those reads, and outsiders
-- see no row at all. Clients hold no UPDATE on pools and do not gain any here --
-- the three RPCs remain the only way this state is written.
-- ---------------------------------------------------------------------------

revoke execute on function public.set_pool_planned_for(uuid, timestamptz) from public;
revoke execute on function public.finalize_pool(uuid, uuid) from public;
revoke execute on function public.finalize_pool_random(uuid) from public;

grant execute on function public.set_pool_planned_for(uuid, timestamptz) to authenticated;
grant execute on function public.finalize_pool(uuid, uuid) to authenticated;
grant execute on function public.finalize_pool_random(uuid) to authenticated;
