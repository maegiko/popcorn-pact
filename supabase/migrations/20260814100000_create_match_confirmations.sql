-- Popcorn Pact: per-user match confirmations and unanimous auto-finalization.
--
-- A confirmation is one member's "I want to watch this!" for one matched title
-- in one pool. It is a second, stronger signal than the like that produced the
-- match: a like is "I'd watch this", a confirmation is "let's watch this one".
--
-- Three properties separate it from a swipe:
--
--   irreversible    there is no un-confirm. A like is already final; the
--                   commitment built on top of it cannot be weaker.
--   per-match       a member may confirm several of a pool's matches. They are
--                   not ranking them, they are saying which they would accept,
--                   and the group lands on the first title everyone accepts.
--   consequential   the confirmation that completes current-member unanimity
--                   finalizes the pool on that title, through exactly the same
--                   one-way lifecycle transition finalize_pool() performs.
--
-- That last property is why this is not merely another swipe table. Three
-- paths now close a pool -- unanimous confirmation, the owner's manual pick,
-- and the owner's random draw -- and EXACTLY ONE of them may ever win. The
-- concurrency section below is the whole of how that is guaranteed.
--
-- Membership is evaluated at confirmation time, from group_members, on every
-- new confirmation. A departure or a join never finalizes anything by itself:
-- it only changes what the *next* confirmation counts. Historical rows from
-- someone who has since left survive as history and are excluded from the
-- tally by the join against current membership.


-- ---------------------------------------------------------------------------
-- Table.
--
-- The smallest schema that is still structurally strong. In particular there is
-- deliberately NO denormalised group_id here, unlike swipes and matches, and
-- the reason is that it would buy nothing on either count it buys there:
--
--   RLS       this table's policy is read-your-own (see below), which needs
--             user_id alone. It never asks which group a row belongs to.
--   history   "this group's confirmations" is not a query the product makes.
--             The client asks "which of THIS POOL's matches have I confirmed",
--             which the primary key answers directly.
--
-- Provenance is not weakened by leaving it out: (pool_id, media_id) references
-- matches, whose own composite key already guarantees its group is its pool's
-- group. A group_id column here would be a third copy of a fact already
-- enforced twice, with a third chance to disagree.
-- ---------------------------------------------------------------------------

create table public.match_confirmations (
  -- The pool leads the key, as it does on swipes and matches: a confirmation is
  -- scoped to the agreement it was made in, and the same title confirmed again
  -- in a later pool is a new decision rather than a duplicate of this one.
  pool_id uuid not null,
  media_id uuid not null,
  -- profiles rather than auth.users, matching group_members and swipes:
  -- profiles.id already cascades from auth.users, and PostgREST can only embed
  -- across a foreign key it can see in the exposed schema.
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- ONE CONFIRMATION PER MEMBER PER MATCH, which is also the whole of the
  -- idempotency story: a retried or double-tapped confirmation collides here
  -- and is reported as already_confirmed rather than inserted twice, and a
  -- unanimity tally can therefore never double-count one member.
  primary key (pool_id, media_id, user_id),
  -- THE CONFIRMATION BELONGS TO A REAL MATCH IN THIS EXACT POOL, stated
  -- declaratively rather than trusted from the RPC. matches is keyed on exactly
  -- (pool_id, media_id), so this says "you may only confirm something this
  -- group actually agreed on, here" in the schema itself -- a match the group
  -- made in a different pool cannot be confirmed against this one even by a
  -- privileged writer.
  --
  -- CASCADE, matching what matches itself does: matches cascade from pools and
  -- pools from groups, so deleting a group takes its confirmations with it.
  -- Nothing else deletes a match, so this cascade never fires on its own.
  -- media deletion stays blocked upstream by matches' own ON DELETE RESTRICT,
  -- which is what keeps a cache eviction from erasing this history.
  constraint match_confirmations_match_fkey
    foreign key (pool_id, media_id)
    references public.matches (pool_id, media_id)
    on delete cascade
);

comment on table public.match_confirmations is
  'One member''s irreversible "I want to watch this" for one matched title in one pool. Written exclusively by confirm_match(); readable only by its own author.';
comment on column public.match_confirmations.user_id is
  'The confirming member. Rows survive that member later leaving the group -- history is kept, but the unanimity tally joins against current membership, so a departed member''s confirmation never counts toward it.';

-- An unindexed inbound foreign key makes every profile (and therefore every
-- account) deletion seq-scan this table. The primary key is led by pool_id and
-- cannot serve it.
create index match_confirmations_user_id_idx on public.match_confirmations (user_id);


-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Read-your-own, the same policy shape swipes uses and for a related reason:
-- the product never needs to show a member WHICH partner has confirmed. It
-- needs to show that the group landed on a title, which is the pool's winner --
-- public group state already readable through pools.
--
-- Exposing partner confirmations would recreate exactly the pressure the swipe
-- privacy rule exists to prevent, one step later in the loop: seeing "they
-- confirmed this" turns a free choice into a prompt to agree. The unanimity
-- tally still reads every row, but it reads them inside confirm_match(), which
-- is SECURITY DEFINER -- computing on data is not the same as disclosing it.
--
-- Reads are NOT gated on access state: a group in grace keeps its members'
-- own history visible and loses only the ability to write, which the RPC
-- enforces. Outsiders match no row at all, since their id never appears.
--
-- No insert/update/delete policy and no write grant: confirm_match() is the
-- only writer, so a direct write from a client fails on privileges before RLS
-- is consulted. There is no delete path by design -- confirmation is
-- irreversible, and an undo would let a member withdraw a commitment the group
-- may already have acted on.
-- ---------------------------------------------------------------------------

alter table public.match_confirmations enable row level security;

create policy "Users can read only their own match confirmations"
  on public.match_confirmations
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on public.match_confirmations to authenticated;
grant all privileges on table public.match_confirmations to service_role;


-- ---------------------------------------------------------------------------
-- The lifecycle transition, in one place.
--
-- finalize_pool(), finalize_pool_random() and now confirm_match() all end in
-- the same three-column write, and it is the one write in this schema that can
-- never be corrected afterwards -- the guard trigger freezes status, winner and
-- finalized_at the moment finalized_at becomes non-null. Three hand-maintained
-- copies of an irreversible write is where drift starts, so there is one.
--
-- It deliberately checks NOTHING. Authority (who may finalize), eligibility
-- (is this title a match here) and lifecycle state (is the pool still open) are
-- different questions per caller, and each caller answers them under the pool
-- lock before getting here. Making this the sole writer of the transition is
-- what keeps the three paths identical; making it the sole *validator* would
-- flatten three genuinely different authorization rules into one.
-- ---------------------------------------------------------------------------

create function public.complete_pool_with_winner(p_pool_id uuid, p_media_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.pools as p
  set status = 'completed',
      winner_media_id = p_media_id,
      finalized_at = now()
  where p.id = p_pool_id;
$$;

comment on function public.complete_pool_with_winner(uuid, uuid) is
  'The one-way pool lifecycle transition shared by finalize_pool(), finalize_pool_random() and confirm_match(). Validates nothing: callers must hold the pool row FOR UPDATE and have checked authority, eligibility and status first.';

revoke execute on function public.complete_pool_with_winner(uuid, uuid) from public;


-- ---------------------------------------------------------------------------
-- confirm_match().
--
-- THE LOCK MODE IS `for update`, NOT `for share`, and that is the single most
-- important line in this file. A confirmation is not like a swipe: a swipe can
-- only ever add to a pool, so many may proceed in parallel under a shared lock,
-- but a confirmation MAY COMPLETE THE POOL. It therefore belongs on the same
-- side of the lifecycle lock as the two finalizers.
--
-- LOCK ORDER, unchanged from the finalization migration:
--
--   1. pool lifecycle       pools row, for share (swipes) / for update
--                           (finalize_pool, finalize_pool_random, confirm_match)
--   2. per-member swipe     lock_swipe_slot(pool_id, user_id)
--   3. per-title match      lock_match_evaluation(pool_id, media_id)
--
-- confirm_match takes only 1, exactly like the two finalizers. It needs neither
-- 2 nor 3: an exclusive lock on the pool row already serialises every
-- confirmation in that pool against every other one, so the per-member and
-- per-title advisory locks would be strictly redundant. Nothing here upgrades a
-- shared lock to an exclusive one -- the exclusive lock is taken first, before
-- anything is read -- so no cycle can form with record_swipe(), which takes 1
-- shared and then 2 and 3.
--
-- WHY TWO WINNERS ARE IMPOSSIBLE. Every path that can complete a pool now takes
-- `for update` on that pool's row before reading its status, and holds it until
-- commit. So for any two such transactions, one acquires first and commits
-- before the other is permitted to look. Postgres re-evaluates a blocked
-- locking SELECT against the newest committed row version, so the loser reads
-- 'completed' -- never the stale row it queued on -- and returns without
-- writing. This covers, identically:
--
--   confirmation vs manual finalize       loser sees completed
--   confirmation vs random finalize       loser sees completed
--   confirmation vs confirmation, same title
--   confirmation vs confirmation, DIFFERENT titles, both at unanimity
--
-- The last one is the interesting case and it needs no special handling: the
-- second transaction's unanimity tally is never even reached, because the
-- status check above it has already returned pool_completed.
--
-- WHY NO LATE CONFIRMATION ROW CAN PERSIST. The status is read under the
-- exclusive lock and the insert happens later in the same transaction, while
-- that lock is still held. There is no interleaving in which this function
-- observes 'active' and then inserts after another transaction completed the
-- pool, because that other transaction cannot acquire the lock until this one
-- ends. A confirmation that loses the race writes nothing at all, rather than
-- writing and being reconciled afterwards.
--
-- Ordinary swiping is unaffected in kind: record_swipe() already excludes and
-- is excluded by `for update` holders, so a like that creates a new match
-- either commits before a finalization (and its match is a legitimate
-- candidate) or finds the pool completed and returns pool_completed. A match
-- cannot appear in a pool after that pool has been closed.
-- ---------------------------------------------------------------------------

create function public.confirm_match(p_pool_id uuid, p_media_id uuid)
returns table (status text, finalized boolean, media_id uuid)
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
  v_pool_status text;
  v_member_count integer;
  v_confirmed_count integer;
  v_inserted boolean;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- LOCK 1: pool lifecycle, EXCLUSIVE. Taken before anything is read, because
  -- every decision below -- the status, the match set, the tally -- is only
  -- trustworthy while it is held, and this call may itself complete the pool.
  select p.group_id, p.status
  into v_group_id, v_pool_status
  from public.pools as p
  where p.id = p_pool_id
  for update;

  -- A pool that does not exist and a pool in someone else's group are the same
  -- answer on purpose: this function runs as the table owner, so distinguishing
  -- them would turn it into an existence oracle for arbitrary pool ids.
  --
  -- ANY member may confirm, not only the pool's owner. That asymmetry with
  -- finalize_pool() is the point of the feature: the confirmation path is the
  -- group reaching unanimity, the manual and random paths are the owner
  -- exercising lifecycle control when they have not.
  if v_group_id is null or not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = v_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text, false, null::uuid;
    return;
  end if;

  -- Only an actual match in THIS pool can be confirmed. A title merely present
  -- in the pool has no agreement to commit to, and a match the group made in a
  -- different pool is a different agreement -- both are match_not_found here,
  -- and the composite foreign key would reject either anyway. Checked before
  -- the lifecycle and group-state gates for the same reason record_swipe checks
  -- media_not_in_pool first: it is a question about the request's coherence
  -- rather than about the pool or the group.
  if p_media_id is null or not exists (
    select 1
    from public.matches as m
    where m.pool_id = p_pool_id
      and m.media_id = p_media_id
  ) then
    return query select 'match_not_found'::text, false, null::uuid;
    return;
  end if;

  -- The pool is settled, by whichever of the three paths got here first.
  -- Nothing further is recorded in it -- not even a confirmation that would
  -- have been unanimous -- and nothing already recorded is disturbed. Read
  -- under the lock, so a finalization that committed while this call was queued
  -- is already visible.
  if v_pool_status = 'completed' then
    return query select 'pool_completed'::text, false, null::uuid;
    return;
  end if;

  -- Group features are withheld while the group exceeds its owner's
  -- entitlement, as everywhere else. Recomputed here rather than trusted, and
  -- deliberately not applied to reads: a member in grace keeps their history.
  if public.group_access_state(v_group_id) <> 'active' then
    return query select 'group_in_grace'::text, false, null::uuid;
    return;
  end if;

  -- The same structural precondition record_swipe enforces, for the same
  -- reason and with the same status. Unanimity among one person is not
  -- unanimity -- it is a single member closing a shared pool on their own --
  -- and without this gate a group that had dropped to one member could
  -- self-finalize on a match made back when it had two.
  if (
    select count(*) from public.group_members as gm where gm.group_id = v_group_id
  ) < 2 then
    return query select 'group_too_small'::text, false, null::uuid;
    return;
  end if;

  -- ON CONFLICT DO NOTHING against the primary key is what makes a retry
  -- idempotent. The missing RETURNING row on a conflict is how the duplicate
  -- reports already_confirmed instead of raising.
  insert into public.match_confirmations (pool_id, media_id, user_id)
  values (p_pool_id, p_media_id, v_user)
  on conflict (pool_id, media_id, user_id) do nothing
  returning true into v_inserted;

  -- A DUPLICATE IS NOT A CONFIRMATION EVENT, so it returns before the tally.
  -- The member has told the group nothing they had not already said, and only a
  -- NEW confirmation may finalize. Re-evaluating here would make a retry that
  -- happened to follow a departure finalize the pool -- which is precisely the
  -- "membership change alone finalizes" behaviour the product forbids.
  if not coalesce(v_inserted, false) then
    return query select 'already_confirmed'::text, false, null::uuid;
    return;
  end if;

  -- UNANIMITY IS EVALUATED AGAINST CURRENT MEMBERSHIP, at this moment, from
  -- group_members -- never from a snapshot taken when the match was created and
  -- never from anything the client sent. The join is what excludes a departed
  -- member's surviving historical row from the tally, and what includes a
  -- member who joined after the earlier confirmations were made.
  select count(*)
  into v_member_count
  from public.group_members as gm
  where gm.group_id = v_group_id;

  select count(*)
  into v_confirmed_count
  from public.group_members as gm
  join public.match_confirmations as mc
    on mc.pool_id = p_pool_id
   and mc.media_id = p_media_id
   and mc.user_id = gm.user_id
  where gm.group_id = v_group_id;

  -- Re-checked rather than relying on the gate above, exactly as record_swipe
  -- re-checks before creating a match: the reads are separate statements and
  -- group_members is not covered by the pool lock, so a departure between them
  -- is possible in principle. This is what stops a group that dropped to one
  -- member mid-call from closing its own pool.
  if v_member_count >= 2 and v_confirmed_count = v_member_count then
    perform public.complete_pool_with_winner(p_pool_id, p_media_id);
    return query select 'confirmed'::text, true, p_media_id;
    return;
  end if;

  -- Recorded, and the group is not there yet. media_id is null rather than the
  -- confirmed title: this column answers "what did the pool finalize on", so
  -- returning a title that has not won would be a second meaning for it.
  return query select 'confirmed'::text, false, null::uuid;
end;
$$;

comment on function public.confirm_match(uuid, uuid) is
  'Records the caller''s irreversible "I want to watch this" for one of their pool''s matches, and finalizes the pool on that title when every current member has confirmed it. Returns confirmed, already_confirmed, match_not_found, pool_completed, not_a_member, group_in_grace or group_too_small instead of raising, plus finalized and the winning media_id.';

revoke execute on function public.confirm_match(uuid, uuid) from public;
grant execute on function public.confirm_match(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- The two existing finalizers, routed through the shared transition.
--
-- Bodies are otherwise byte-identical to the finalization migration: same
-- authority checks, same statuses, same order, same lock. The only change is
-- that the final UPDATE is now the single shared write above, so the three
-- paths that can close a pool cannot drift apart.
-- ---------------------------------------------------------------------------

create or replace function public.finalize_pool(p_pool_id uuid, p_media_id uuid)
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
  -- queued is already visible here. This is the single point at which racing
  -- finalizers -- manual against manual, manual against random, and now manual
  -- against a unanimous confirmation -- are resolved into exactly one winner.
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

  perform public.complete_pool_with_winner(p_pool_id, p_media_id);

  return query select 'finalized'::text, p_media_id;
end;
$$;

comment on function public.finalize_pool(uuid, uuid) is
  'Closes a pool on one of its own matches, chosen by the pool''s owner. One-way. Returns finalized, not_a_member, not_creator, already_completed, group_in_grace, no_matches or media_not_matched instead of raising.';


create or replace function public.finalize_pool_random(p_pool_id uuid)
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

  perform public.complete_pool_with_winner(p_pool_id, v_media_id);

  return query select 'finalized'::text, v_media_id;
end;
$$;

comment on function public.finalize_pool_random(uuid) is
  'Closes a pool on one of its own matches, drawn uniformly at random server-side. Same one-way contract and statuses as finalize_pool, minus media_not_matched.';
