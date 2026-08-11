-- Popcorn Pact: trusted-backend access for the service role.
--
-- config.toml leaves auto_expose_new_tables unset, which is the current cloud
-- default and means a table created by postgres is reachable by NO Data API role
-- until it is granted explicitly. The earlier migrations granted `authenticated`
-- and stopped there, so service_role -- the server-only key used by trusted
-- backend jobs, admin tooling and integration tests -- currently cannot read or
-- write a single application table.
--
-- That is an omission rather than a policy. service_role bypasses RLS by design,
-- is never shipped to a client, and is the identity every trusted server-side
-- task already assumes it can use. Granting it here restores the standard
-- Supabase posture and widens nothing for anon or authenticated: the client
-- write model is untouched, and the RPCs remain the only path for a user.

grant all privileges on table public.profiles to service_role;
grant all privileges on table public.groups to service_role;
grant all privileges on table public.group_members to service_role;
grant all privileges on table public.group_invites to service_role;
grant all privileges on table public.pools to service_role;
grant all privileges on table public.pool_titles to service_role;

-- A view, so select is the only meaningful privilege. Reading it as service_role
-- bypasses RLS and therefore reports every group, which is what a backend job
-- auditing seat usage needs.
grant select on table public.group_access to service_role;
