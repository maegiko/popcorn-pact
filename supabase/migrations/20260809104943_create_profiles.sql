-- Popcorn Pact: application-specific user data.
--
-- auth.users remains the sole owner of authentication identity and credentials.
-- public.profiles holds only product data, keyed 1:1 by the auth user id.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  -- Nullable only until onboarding completes. null means "this user has not
  -- chosen a Popcorn Pact name yet", which is the sole signal the app uses to
  -- gate entry to the main experience.
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Once present, reject blank and whitespace-only names: the stored value must
  -- already be trimmed, which also makes ' ' and '' fail the length floor.
  -- "absent" and "blank" are deliberately different states.
  constraint profiles_display_name_valid check (
    display_name is null
    or (
      display_name = btrim(display_name)
      and char_length(display_name) between 1 and 50
    )
  )
);

comment on table public.profiles is
  'Popcorn Pact profile for an auth.users identity. One row per user, created automatically on signup.';
comment on column public.profiles.id is
  'Matches auth.users.id. Deleting the auth user deletes the profile.';
comment on column public.profiles.display_name is
  'Name shown to a paired partner. null until the user chooses one during onboarding; never derived from an email address or an Apple/OAuth real name.';

-- No extra indexes: every read and write is by primary key, and the primary key
-- index also covers the foreign key to auth.users.


-- ---------------------------------------------------------------------------
-- updated_at is maintained by the database so clients cannot backdate it.
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- Onboarding is one-way: a display name may be changed, but never cleared.
--
-- The check constraint cannot express this because it has no access to the old
-- row. Without the guard, the client's column-level update grant would let a
-- user null their own name and re-enter onboarding, so "profile completed" is
-- enforced here rather than trusted to the app.
-- ---------------------------------------------------------------------------

create function public.prevent_display_name_reset()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.display_name is not null and new.display_name is null then
    -- check_violation so PostgREST answers 4xx rather than a 500.
    raise exception 'display_name cannot be cleared once it has been set'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Fires before profiles_set_updated_at: triggers run in name order.
create trigger profiles_prevent_display_name_reset
  before update on public.profiles
  for each row
  execute function public.prevent_display_name_reset();


-- ---------------------------------------------------------------------------
-- Automatic profile creation on signup.
--
-- Every auth.users row gets a profile row immediately, whatever the provider.
-- display_name is sourced strictly from the signup metadata the client sends as
-- options.data.display_name, and is left null when that key is missing, blank,
-- or whitespace-only. It is never derived from an email address or from a real
-- name supplied by Apple or any other OAuth provider.
--
-- That split is what lets one trigger serve both flows:
--   email/password -- the form collects the name, so the profile is complete
--                     on arrival and the user goes straight into the app
--   Apple/OAuth    -- no name exists yet, so display_name stays null and the
--                     app routes the user to the display-name screen
--
-- This trigger runs inside the auth.users insert transaction, so it must not
-- raise: anything that does aborts registration and surfaces to the client as
-- "Database error saving new user". Keep the body total.
--
-- Runs as SECURITY DEFINER because the signing-up user has no session yet and
-- no client-facing insert policy exists. search_path is pinned to '' and every
-- object is schema-qualified so the definer context cannot be hijacked.
-- ---------------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    -- Trim, cap at the constraint's 50 characters, then trim again so a cut
    -- landing on a space cannot leave trailing whitespace. The outer nullif
    -- turns a missing or whitespace-only name into null rather than a
    -- constraint violation, leaving the profile incomplete for onboarding.
    nullif(btrim(left(btrim(new.raw_user_meta_data ->> 'display_name'), 50)), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Trigger functions cannot be invoked directly, but keep the definer function
-- off the default PUBLIC execute grant anyway. Postgres checks EXECUTE at
-- CREATE TRIGGER time, not when the trigger fires.
revoke execute on function public.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Backfill accounts created while testing auth before this migration existed.
-- Every user gets a row so the 1:1 invariant holds from the start; accounts
-- with no display_name metadata get a null name and pass through the
-- display-name screen on their next sign-in.
insert into public.profiles (id, display_name)
select
  u.id,
  nullif(btrim(left(btrim(u.raw_user_meta_data ->> 'display_name'), 50)), '')
from auth.users as u
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- A user may read and update only their own profile. Inserts and deletes are
-- intentionally not exposed: rows are created by the signup trigger and removed
-- by the cascade from auth.users.
--
-- RLS is enabled but not FORCEd, so the SECURITY DEFINER signup trigger can
-- still insert without a client-facing insert policy.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

-- auth.uid() is wrapped in a subquery so the planner evaluates it once per
-- statement instead of once per row.
create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "Users can update their own profile"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- New public tables are not auto-exposed to the Data API roles, so grant
-- explicitly. Updates are limited to display_name at the column level; id,
-- created_at and updated_at are not client-writable.
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
