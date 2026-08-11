-- Popcorn Pact: generated-pool creation as a single transaction.
--
-- create_pool() plus a loop of add_pool_title() is the right shape for a manual
-- pool, where a member adds titles one at a time and a half-filled pool is
-- simply a pool someone is still working on.
--
-- A generated pool is the opposite. It is a snapshot, and a snapshot missing
-- half its titles because the caller died mid-loop is indistinguishable from a
-- complete one -- the group just sees a short pile. Nothing above the database
-- can repair that either: clients hold no delete on pools, by design, so an
-- Edge Function has no compensating cleanup available to it.
--
-- So the whole write lives here: the pool row and every title in one
-- transaction, all of it or none of it. Everything else matches create_pool() --
-- caller-derived identity, the same membership and grace checks, the same status
-- vocabulary -- because this is the same trusted write model, not a second one.

create function public.create_generated_pool(p_group_id uuid, p_titles jsonb)
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
  -- the caller promise that a failed generation left nothing behind.
  if p_titles is null
     or jsonb_typeof(p_titles) <> 'array'
     or jsonb_array_length(p_titles) = 0 then
    return query select 'no_candidates'::text, null::uuid;
    return;
  end if;

  insert into public.pools (group_id, created_by, mode)
  values (p_group_id, v_user, 'generated')
  returning id into v_pool_id;

  -- distinct collapses candidates the upstream repeated; on conflict is the
  -- backstop. Malformed entries are deliberately NOT filtered here -- the
  -- pool_titles check constraints reject them and abort the whole snapshot,
  -- because a caller sending a bad tmdb_id or media_type has a bug, and half a
  -- snapshot is worse than a loud failure.
  insert into public.pool_titles (pool_id, tmdb_id, media_type)
  select distinct
    v_pool_id,
    (t.value ->> 'tmdb_id')::integer,
    t.value ->> 'media_type'
  from jsonb_array_elements(p_titles) as t(value)
  on conflict (pool_id, tmdb_id, media_type) do nothing;

  return query select 'created'::text, v_pool_id;
end;
$$;

comment on function public.create_generated_pool(uuid, jsonb) is
  'Creates a generated pool and its titles atomically for a group the caller belongs to. Returns not_a_member, group_in_grace or no_candidates instead of raising, and creates nothing in those cases.';

-- Postgres grants EXECUTE to PUBLIC by default, so revoke first.
revoke execute on function public.create_generated_pool(uuid, jsonb) from public;
grant execute on function public.create_generated_pool(uuid, jsonb) to authenticated;
