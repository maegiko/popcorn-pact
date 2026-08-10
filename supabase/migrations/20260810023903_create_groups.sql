-- Popcorn Pact: groups, membership, and invite codes.
--
-- A "group" is a shared Popcorn Pact relationship. The MVP pairs exactly two
-- people, but nothing here hard-codes that: membership is modelled as its own
-- table, and both size limits are business logic rather than cardinality.
--
-- Two rules that shape everything below:
--
--   free tier    one active group per user, two members per group
--   premium      several groups, and eventually more than two members
--
-- Neither limit is expressed as a constraint or a unique index, because both are
-- meant to change per-user at runtime once RevenueCat is wired up. They live in
-- group_limit_for_user() and member_limit_for_group() -- the two "entitlement
-- seams" -- and are enforced only in the trusted RPCs below.
--
-- Consequently a group can drift OUT of compliance without anyone doing anything
-- wrong: a premium owner leaves a four-person group, ownership passes to a free
-- member, and the group is suddenly over its owner's limit. That is the 'grace'
-- state (see group_access_state). A group in grace keeps its data and members but
-- loses group features until its owner upgrades. Leaving is never blocked, so
-- grace can always be escaped.

create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  -- The owner, not merely a record of who typed the button. This user's
  -- entitlement decides how many members the group may hold, and later drives
  -- group management generally.
  --
  -- Mutable: remove_member() reassigns it when the owner leaves, so a group is
  -- never left pointing at a non-member. The cascade is a backstop only -- the
  -- before-delete trigger on profiles reassigns ownership first.
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.groups is
  'A shared Popcorn Pact group. Two members in the MVP; the limit is enforced in the join RPCs, not by this schema.';
comment on column public.groups.created_by is
  'The current owner. Reassigned to the longest-standing remaining member when the owner leaves. The owner''s entitlement determines the group''s member limit.';

-- Serves member_limit_for_group() and "groups I own" lookups.
create index groups_created_by_idx on public.groups (created_by);

create trigger groups_set_updated_at
  before update on public.groups
  for each row
  execute function public.set_updated_at();


create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  -- References profiles rather than auth.users on purpose. profiles.id already
  -- cascades from auth.users, so integrity is identical -- but PostgREST can
  -- only embed across a foreign key it can see in the exposed schema, and this
  -- is what lets the client load a group and its members' display names in one
  -- request.
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  -- Prevents the same user appearing twice in one group. Deliberately says
  -- nothing about how many groups a user may join.
  primary key (group_id, user_id)
);

comment on table public.group_members is
  'Membership of a group. Rows are immutable once written; departure is a delete via remove_member().';

-- NOT unique: a user may belong to several groups (premium). The free-tier
-- limit of one lives in group_limit_for_user(). This index exists because the
-- primary key is led by group_id and therefore cannot answer "which groups am
-- I in" -- the single hottest query in the feature, run by every RLS check.
create index group_members_user_id_idx on public.group_members (user_id);


create table public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  code text not null unique,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid references public.profiles (id) on delete set null,
  revoked_at timestamptz,
  -- Crockford base32: the full alphabet minus I, L, O and U, which are the
  -- characters people mistype when a code is read aloud or copied by hand.
  constraint group_invites_code_valid check (code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  constraint group_invites_consumed_together
    check ((consumed_at is null) = (consumed_by is null))
);

comment on table public.group_invites is
  'Single-use invite codes. A code is spent by join_group_with_invite() or superseded by a newer one; it is never reusable.';

-- At most one live invite per group. expires_at cannot appear in the predicate
-- (not immutable), so an expired-but-unrevoked invite still occupies the slot --
-- which is exactly why create_group_invite() revokes the previous one rather
-- than relying on expiry.
create unique index group_invites_one_live_per_group
  on public.group_invites (group_id)
  where consumed_at is null and revoked_at is null;

-- Serves the client's "invites for my groups" read and the cascade from groups.
create index group_invites_group_id_idx on public.group_invites (group_id);


-- ---------------------------------------------------------------------------
-- Entitlement seams.
--
-- These two functions are the whole of the freemium policy. When RevenueCat is
-- integrated, only their bodies change: no migration to the tables above, no
-- policy change, no client change. They are readable by clients so the UI can
-- render honest copy ("2 of 4 seats used"), but they are never trusted --
-- enforcement happens exclusively in the RPCs, which recompute server-side.
--
-- Neither is SECURITY DEFINER. They read RLS-protected tables, so an invoker
-- call naturally cannot see another user's data, and calls from inside the
-- definer RPCs run as the owner and see everything they need.
-- ---------------------------------------------------------------------------

create function public.group_limit_for_user(p_user_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  -- ENTITLEMENT SEAM: how many groups this user may belong to.
  -- Free tier is one. Replace the literal with a lookup against synced
  -- entitlement state keyed on p_user_id.
  select case when p_user_id is null then 0 else 1 end;
$$;

comment on function public.group_limit_for_user(uuid) is
  'Entitlement seam: maximum concurrent group memberships for a user. Returns the free-tier value until RevenueCat is integrated.';

create function public.member_limit_for_group(p_group_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  -- ENTITLEMENT SEAM: how many members this group may hold.
  -- Determined by the OWNER's entitlement, which is why this reads groups
  -- rather than taking a user id. Replace the literal with a lookup keyed on
  -- g.created_by.
  select 2
  from public.groups as g
  where g.id = p_group_id;
$$;

comment on function public.member_limit_for_group(uuid) is
  'Entitlement seam: maximum members for a group, determined by its owner''s entitlement. Returns the free-tier value until RevenueCat is integrated.';

create function public.group_access_state(p_group_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  -- Derived, never stored: a pure function of member count and owner
  -- entitlement, both of which change independently. A stored column would need
  -- invalidating on join, leave, ownership transfer AND every subscription
  -- webhook.
  select case
    when (
      select count(*)
      from public.group_members as gm
      where gm.group_id = p_group_id
    ) > coalesce(public.member_limit_for_group(p_group_id), 0)
    then 'grace'
    else 'active'
  end;
$$;

comment on function public.group_access_state(uuid) is
  'active when the group fits its owner''s entitlement, grace when it exceeds it. Group features must be withheld in grace; leaving must not be.';


-- ---------------------------------------------------------------------------
-- RLS helpers.
--
-- Both are SECURITY DEFINER because they exist precisely to break recursion: a
-- group_members policy that queries group_members would recurse forever.
-- ---------------------------------------------------------------------------

-- Returns an array rather than a boolean membership test on purpose. Wrapped as
-- `(select public.current_user_group_ids())::uuid[]` in a policy, the planner
-- evaluates it once per statement as an InitPlan and each row costs only an
-- `= any(...)`. A boolean helper taking the row's id could not be hoisted and
-- would run once per row.
--
-- The cast is load-bearing: `= any (subquery)` and `= any (array)` are distinct
-- parse forms, and without it the parser reads the parenthesised select as a
-- subquery of uuid and fails with "operator does not exist: uuid = uuid[]".
-- Calling the function bare -- `= any (public.current_user_group_ids())` --
-- also parses, but gives up the InitPlan.
--
-- Phase 4's swipes/matches/title_pool policies reuse this verbatim.
create function public.current_user_group_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(gm.group_id), '{}'::uuid[])
  from public.group_members as gm
  where gm.user_id = (select auth.uid());
$$;

revoke execute on function public.current_user_group_ids() from public;

create function public.shares_group_with_current_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members as mine
    join public.group_members as theirs on theirs.group_id = mine.group_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

revoke execute on function public.shares_group_with_current_user(uuid) from public;


-- ---------------------------------------------------------------------------
-- Invite code generation.
-- ---------------------------------------------------------------------------

create function public.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea := extensions.gen_random_bytes(8);
  result text := '';
  i integer;
begin
  -- A guessed code joins a stranger's group, so this uses the CSPRNG rather
  -- than random(). 256 is a multiple of 32, so masking a uniform byte with 31
  -- stays uniform -- no modulo bias.
  for i in 0..7 loop
    result := result || substr(alphabet, 1 + (get_byte(bytes, i) & 31), 1);
  end loop;

  return result;
end;
$$;

-- Internal: reachable only from the definer RPCs, which run as the owner.
revoke execute on function public.generate_invite_code() from public;


-- ---------------------------------------------------------------------------
-- Departure.
--
-- remove_member() is the single implementation of "this user is no longer in
-- this group", shared by leave_group() and by account deletion. Those two paths
-- must never disagree: without the shared implementation, leaving transfers
-- ownership while deleting an account would let the FK cascade destroy the
-- whole group -- taking the other member's group with it.
-- ---------------------------------------------------------------------------

create function public.remove_member(p_group_id uuid, p_user_id uuid)
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
    -- Last one out. Invites cascade.
    delete from public.groups as g where g.id = p_group_id;
  elsif v_was_owner then
    -- Ownership passes to the longest-standing remaining member. Their
    -- entitlement now governs the group, which may put it into grace.
    update public.groups as g
    set created_by = v_next_owner
    where g.id = p_group_id;
  end if;
end;
$$;

revoke execute on function public.remove_member(uuid, uuid) from public;


-- Account deletion must behave exactly like leaving every group. This runs
-- BEFORE the cascade from profiles, so ownership is reassigned while the rows
-- still exist and the cascade then finds nothing pointing at the deleted user.
create function public.handle_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_id uuid;
begin
  for v_group_id in
    select gm.group_id from public.group_members as gm where gm.user_id = old.id
    union
    select g.id from public.groups as g where g.created_by = old.id
  loop
    perform public.remove_member(v_group_id, old.id);
  end loop;

  return old;
end;
$$;

revoke execute on function public.handle_profile_delete() from public;

create trigger profiles_handle_delete
  before delete on public.profiles
  for each row
  execute function public.handle_profile_delete();


-- ---------------------------------------------------------------------------
-- Client-facing RPCs.
--
-- Every write goes through one of these. The client holds SELECT on the tables
-- and nothing else -- no insert, update or delete policy or grant exists -- so
-- these functions are the only way group state changes, and the only place the
-- freemium limits need enforcing.
--
-- They return a status row rather than raising for expected outcomes ("that
-- code expired", "you are at your group limit"). Those are ordinary data, not
-- faults, and a status column gives the client a discriminated union instead of
-- error-string matching. RAISE is reserved for genuine faults, with
-- errcode = 'check_violation' so PostgREST answers 4xx rather than 500.
-- ---------------------------------------------------------------------------

create function public.create_group_invite(p_group_id uuid)
returns table (status text, code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
-- OUT parameters (status, code, expires_at) shadow same-named columns in this
-- body. Every column reference below is table-qualified; this pragma makes the
-- ambiguity resolve to the column rather than erroring if one is ever missed.
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_code text;
  v_expires timestamptz := now() + interval '7 days';
  v_attempt integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- Any member may issue a code, not just the owner: in a two-person group the
  -- invitee must be able to re-invite when the owner's code expires.
  if not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = p_group_id
      and gm.user_id = v_user
  ) then
    return query select 'not_a_member'::text, null::text, null::timestamptz;
    return;
  end if;

  perform 1 from public.groups as g where g.id = p_group_id for update;

  -- Also covers grace, where the count already exceeds the limit.
  if (
    select count(*) from public.group_members as gm where gm.group_id = p_group_id
  ) >= coalesce(public.member_limit_for_group(p_group_id), 0) then
    return query select 'group_full'::text, null::text, null::timestamptz;
    return;
  end if;

  -- Revoking rather than waiting for expiry is what keeps the one-live-invite
  -- partial unique index satisfiable.
  update public.group_invites as gi
  set revoked_at = now()
  where gi.group_id = p_group_id
    and gi.consumed_at is null
    and gi.revoked_at is null;

  for v_attempt in 1..5 loop
    begin
      v_code := public.generate_invite_code();

      insert into public.group_invites (group_id, code, created_by, expires_at)
      values (p_group_id, v_code, v_user, v_expires);

      return query select 'created'::text, v_code, v_expires;
      return;
    exception when unique_violation then
      -- Astronomically unlikely at 32^8; retry rather than fail the request.
    end;
  end loop;

  raise exception 'could not allocate a unique invite code'
    using errcode = 'check_violation';
end;
$$;


create function public.create_group()
returns table (status text, group_id uuid, invite_code text, invite_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_group_id uuid;
  v_invite record;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- A count against a limit, not a uniqueness violation. This is the free-tier
  -- one-group rule, and relaxing it for premium is a one-line change in
  -- group_limit_for_user().
  if (
    select count(*) from public.group_members as gm where gm.user_id = v_user
  ) >= public.group_limit_for_user(v_user) then
    return query select 'group_limit_reached'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  insert into public.groups (created_by)
  values (v_user)
  returning id into v_group_id;

  insert into public.group_members (group_id, user_id)
  values (v_group_id, v_user);

  select * into v_invite from public.create_group_invite(v_group_id);

  return query select 'created'::text, v_group_id, v_invite.code, v_invite.expires_at;
end;
$$;


create function public.join_group_with_invite(p_code text)
returns table (status text, group_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_code text;
  v_invite public.group_invites%rowtype;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  -- Accept what a human would actually type or paste: lowercase, spaces, the
  -- dash from a formatted "7GK2-N4QX".
  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));

  select * into v_invite
  from public.group_invites as gi
  where gi.code = v_code;

  if not found
     or v_invite.consumed_at is not null
     or v_invite.revoked_at is not null then
    return query select 'invalid_code'::text, null::uuid;
    return;
  end if;

  -- Distinguished from invalid_code deliberately: the caller already holds a
  -- real code, so this leaks nothing and "ask for a new one" is far better copy.
  if v_invite.expires_at <= now() then
    return query select 'expired'::text, null::uuid;
    return;
  end if;

  -- Serializes concurrent joins. Without this lock two callers can both read a
  -- member count below the limit and both insert, overfilling the group.
  perform 1 from public.groups as g where g.id = v_invite.group_id for update;

  if exists (
    select 1
    from public.group_members as gm
    where gm.group_id = v_invite.group_id
      and gm.user_id = v_user
  ) then
    -- Idempotent, and deliberately does not burn the invite.
    return query select 'already_member'::text, v_invite.group_id;
    return;
  end if;

  if (
    select count(*) from public.group_members as gm where gm.user_id = v_user
  ) >= public.group_limit_for_user(v_user) then
    return query select 'group_limit_reached'::text, null::uuid;
    return;
  end if;

  if (
    select count(*) from public.group_members as gm where gm.group_id = v_invite.group_id
  ) >= coalesce(public.member_limit_for_group(v_invite.group_id), 0) then
    return query select 'group_full'::text, null::uuid;
    return;
  end if;

  insert into public.group_members (group_id, user_id)
  values (v_invite.group_id, v_user);

  update public.group_invites as gi
  set consumed_at = now(),
      consumed_by = v_user
  where gi.id = v_invite.id;

  return query select 'joined'::text, v_invite.group_id;
end;
$$;


-- Never gated on access state: a group in grace must always be abandonable, and
-- that escape hatch is what stops grace from being a trap.
create function public.leave_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'check_violation';
  end if;

  if not exists (
    select 1
    from public.group_members as gm
    where gm.group_id = p_group_id
      and gm.user_id = v_user
  ) then
    return;
  end if;

  perform public.remove_member(p_group_id, v_user);
end;
$$;


-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Read-only for clients. Rows are written exclusively by the RPCs above, so no
-- insert/update/delete policy exists -- the same shape as profiles, where rows
-- are trigger-created.
--
-- RLS is enabled but not FORCEd so the SECURITY DEFINER functions can operate
-- without client-facing write policies.
-- ---------------------------------------------------------------------------

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;

create policy "Members can read their groups"
  on public.groups
  for select
  to authenticated
  using (id = any ((select public.current_user_group_ids())::uuid[]));

create policy "Members can read their groups' memberships"
  on public.group_members
  for select
  to authenticated
  using (group_id = any ((select public.current_user_group_ids())::uuid[]));

create policy "Members can read their groups' invites"
  on public.group_invites
  for select
  to authenticated
  using (group_id = any ((select public.current_user_group_ids())::uuid[]));

-- Without this a partner's display name is unreadable and the pairing UI has
-- nothing to show. Policies are OR'd, so the existing own-profile policy from
-- the profiles migration is untouched.
--
-- Unlike the policies above this takes the row's id, so it evaluates per row
-- rather than as an InitPlan. The number of profiles reachable through it is
-- bounded by the caller's own group members.
create policy "Users can read the profiles of their group members"
  on public.profiles
  for select
  to authenticated
  using (public.shares_group_with_current_user(id));


-- ---------------------------------------------------------------------------
-- Derived state, as a view.
--
-- security_invoker is load-bearing: it makes the querying user's policies apply
-- to the underlying tables, so a user sees only their own groups. A default
-- (definer) view would expose every group in the table.
-- ---------------------------------------------------------------------------

create view public.group_access
with (security_invoker = true) as
select
  g.id as group_id,
  g.created_by,
  (
    select count(*)::integer
    from public.group_members as gm
    where gm.group_id = g.id
  ) as member_count,
  public.member_limit_for_group(g.id) as member_limit,
  public.group_access_state(g.id) as state
from public.groups as g;

comment on view public.group_access is
  'Per-group seat usage and access state for the current user''s groups. Read-only; the RPCs recompute all of it server-side when enforcing.';


-- ---------------------------------------------------------------------------
-- Grants.
--
-- New public tables are not auto-exposed to the Data API roles, so every one is
-- granted explicitly. Writes are granted nowhere: the RPCs are the only path.
-- ---------------------------------------------------------------------------

grant select on public.groups to authenticated;
grant select on public.group_members to authenticated;
grant select on public.group_invites to authenticated;
grant select on public.group_access to authenticated;

-- Postgres grants EXECUTE to PUBLIC by default, so each is revoked first.
revoke execute on function public.group_limit_for_user(uuid) from public;
revoke execute on function public.member_limit_for_group(uuid) from public;
revoke execute on function public.group_access_state(uuid) from public;
revoke execute on function public.create_group() from public;
revoke execute on function public.create_group_invite(uuid) from public;
revoke execute on function public.join_group_with_invite(text) from public;
revoke execute on function public.leave_group(uuid) from public;

-- The RLS helpers must be executable by the querying role: policies run as the
-- caller, not as the policy author.
grant execute on function public.current_user_group_ids() to authenticated;
grant execute on function public.shares_group_with_current_user(uuid) to authenticated;

-- The seams are readable so the UI can say "2 of 4 seats used" and explain a
-- grace state honestly. They are never trusted: enforcement is in the RPCs,
-- which recompute server-side on every call, so a client that lies to itself
-- about its own limit gains nothing by it.
grant execute on function public.group_limit_for_user(uuid) to authenticated;
grant execute on function public.member_limit_for_group(uuid) to authenticated;
grant execute on function public.group_access_state(uuid) to authenticated;

grant execute on function public.create_group() to authenticated;
grant execute on function public.create_group_invite(uuid) to authenticated;
grant execute on function public.join_group_with_invite(text) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;

-- generate_invite_code, remove_member and handle_profile_delete are granted to
-- nobody. remove_member in particular takes an arbitrary p_user_id and is
-- reached only through leave_group() and the profile-delete trigger.


-- ---------------------------------------------------------------------------
-- Note for Phase 4.
--
-- The swipe, match and title-pool RPCs must call group_access_state(group_id)
-- and refuse to operate on a group in 'grace'. The client-side grace screen is
-- UX, not enforcement -- there is currently no server-side consequence to grace
-- because no group features exist yet.
-- ---------------------------------------------------------------------------
