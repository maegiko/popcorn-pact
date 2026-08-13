-- Popcorn Pact: pool lifecycle status.
--
-- A group's Home screen needs to resume "the pool you were swiping through"
-- without an RPC: a plain RLS-backed SELECT ordered by recency. That requires
-- pools to say whether they are still current.
--
--   active       the pool a group may still be swiping through
--   completed    a pool that is done and should not be offered for recovery
--
-- Deliberately unopinionated about *how* a pool becomes completed: no trigger,
-- no RPC here marks anything complete, and creating a newer pool never touches
-- the status of an older one. Several active pools may coexist for one group --
-- that is normal, not a bug, and this migration does not resolve it. The write
-- path for status transitions is a later slice; this one only adds the column,
-- its default, the constraint and the index the recovery query needs:
--
--   select * from pools
--   where group_id = :group_id and status = 'active'
--   order by created_at desc
--   limit 1
--
-- text-with-check, matching every other lifecycle-ish column in this schema
-- (pools.mode, media.media_type): an enum turns each future value (e.g.
-- 'archived') into a migration with a transaction-boundary caveat.

alter table public.pools
  add column status text not null default 'active';

alter table public.pools
  add constraint pools_status_valid check (status in ('active', 'completed'));

comment on column public.pools.status is
  'Lifecycle state for Home-screen recovery: active (may still be swiped) or completed. Existing rows and every create_pool()/create_generated_pool() write default to active; nothing here transitions a pool to completed.';

-- Serves the recovery lookup directly: group_id equality, status equality,
-- created_at DESC LIMIT 1. created_at is stored DESC so the planner can walk
-- the index in the query's own order instead of sorting a filtered set.
create index pools_group_status_created_at_idx
  on public.pools (group_id, status, created_at desc);

-- No RLS change: "Members can read their groups' pools" already scopes pools
-- by group membership alone, unconditional on group_access_state. Grace keeps
-- data readable and only withholds writes (enforced in create_pool() and
-- create_generated_pool()), and lifecycle status is read through that same
-- policy -- so a grace-state member can still recover their active pool, and a
-- stranger still sees nothing.
