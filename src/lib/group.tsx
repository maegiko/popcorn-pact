import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useSession } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

/**
 * Group membership state.
 *
 * Deliberately plural. The free tier allows one group and premium will allow
 * several, so "how many groups do I have" is a property of a list rather than a
 * status — folding it into the status enum would re-encode the one-group
 * assumption in the type system and force a rewrite later.
 *
 * `error` is kept distinct from "no groups" for the same reason `auth.tsx` keeps
 * it distinct from `needsDisplayName`: an offline user must not be told they
 * have no group and invited to create a second one.
 */
export type GroupStatus = 'loading' | 'error' | 'ready';

/**
 * `grace` means the group holds more members than its owner's entitlement
 * allows — which can happen without anyone doing anything, when a premium owner
 * leaves or their subscription lapses. Group features are withheld in grace;
 * leaving never is.
 */
export type GroupAccessState = 'active' | 'grace';

export type GroupMember = {
  userId: string;
  displayName: string | null;
  joinedAt: string;
};

export type GroupInvite = {
  code: string;
  expiresAt: string;
};

export type GroupSummary = {
  id: string;
  ownerId: string;
  isOwner: boolean;
  accessState: GroupAccessState;
  memberCount: number;
  memberLimit: number;
  members: GroupMember[];
  /** The one live invite, if any. Expired and spent codes are filtered out. */
  invite: GroupInvite | null;
};

export type CreateGroupResult =
  | { status: 'created'; groupId: string }
  | { status: 'group_limit_reached' }
  | { status: 'error'; message: string };

export type JoinGroupResult =
  | { status: 'joined'; groupId: string }
  | { status: 'already_member'; groupId: string }
  | { status: 'invalid_code' }
  | { status: 'expired' }
  | { status: 'group_full' }
  | { status: 'group_limit_reached' }
  | { status: 'error'; message: string };

export type RefreshInviteResult =
  | { status: 'created'; code: string; expiresAt: string }
  | { status: 'group_full' }
  | { status: 'not_a_member' }
  | { status: 'error'; message: string };

type Failure = { error: string | null };

type GroupContextValue = {
  status: GroupStatus;
  groups: GroupSummary[];
  currentGroupId: string | null;
  currentGroup: GroupSummary | null;
  /** The other member of the current group. Null until someone joins. */
  partner: GroupMember | null;
  selectGroup: (groupId: string) => void;
  createGroup: () => Promise<CreateGroupResult>;
  joinWithCode: (code: string) => Promise<JoinGroupResult>;
  refreshInvite: (groupId: string) => Promise<RefreshInviteResult>;
  leaveGroup: (groupId: string) => Promise<Failure>;
  retryLoad: () => void;
};

/**
 * A fetch result tagged with the user and attempt it belongs to, matching the
 * discipline in `auth.tsx`: "no result matching the current user and attempt"
 * *is* the loading state, so nothing needs resetting synchronously and a
 * response for a previous user can never be adopted.
 */
type GroupsResult = { userId: string; attempt: number } & (
  | { status: 'loaded'; groups: GroupSummary[] }
  | { status: 'error' }
);

const GroupContext = createContext<GroupContextValue | null>(null);

export function useGroups() {
  const value = use(GroupContext);
  if (!value) {
    throw new Error('useGroups must be wrapped in a <GroupProvider />');
  }
  return value;
}

/** Stable identity so consumers do not re-render on every load. */
const NO_GROUPS: GroupSummary[] = [];

type MemberRow = {
  group_id: string;
  user_id: string;
  joined_at: string;
  // PostgREST returns an object for a to-one embed, but the shape is not typed
  // without generated types, so both forms are handled.
  profiles: { display_name: string | null } | { display_name: string | null }[] | null;
};

type AccessRow = {
  group_id: string;
  created_by: string;
  member_count: number;
  member_limit: number;
  state: GroupAccessState;
};

type InviteRow = {
  group_id: string;
  code: string;
  expires_at: string;
};

function displayNameOf(row: MemberRow): string | null {
  const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return profile?.display_name ?? null;
}

/**
 * Loads every group the user belongs to. Three queries rather than one per
 * group: RLS scopes all of them to the caller's groups, so the rows arrive flat
 * and are grouped here.
 *
 * Returns null on failure — distinct from an empty array, which legitimately
 * means "signed in, not in a group yet".
 */
async function fetchGroups(userId: string): Promise<GroupSummary[] | null> {
  const [members, access, invites] = await Promise.all([
    supabase.from('group_members').select('group_id, user_id, joined_at, profiles(display_name)'),
    supabase.from('group_access').select('group_id, created_by, member_count, member_limit, state'),
    supabase
      .from('group_invites')
      .select('group_id, code, expires_at')
      .is('consumed_at', null)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString()),
  ]);

  if (members.error || access.error || invites.error) return null;

  const memberRows = (members.data ?? []) as MemberRow[];
  const accessRows = (access.data ?? []) as AccessRow[];
  const inviteRows = (invites.data ?? []) as InviteRow[];

  const membersByGroup = new Map<string, GroupMember[]>();
  const joinedAtByGroup = new Map<string, string>();

  for (const row of memberRows) {
    const list = membersByGroup.get(row.group_id) ?? [];
    list.push({
      userId: row.user_id,
      displayName: displayNameOf(row),
      joinedAt: row.joined_at,
    });
    membersByGroup.set(row.group_id, list);

    if (row.user_id === userId) joinedAtByGroup.set(row.group_id, row.joined_at);
  }

  for (const list of membersByGroup.values()) {
    list.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  const inviteByGroup = new Map(inviteRows.map((row) => [row.group_id, row]));

  return accessRows
    .map((row): GroupSummary => {
      const invite = inviteByGroup.get(row.group_id);
      return {
        id: row.group_id,
        ownerId: row.created_by,
        isOwner: row.created_by === userId,
        accessState: row.state,
        memberCount: row.member_count,
        memberLimit: row.member_limit,
        members: membersByGroup.get(row.group_id) ?? [],
        invite: invite ? { code: invite.code, expiresAt: invite.expires_at } : null,
      };
    })
    // Oldest membership first, so "the first group" is stable across loads.
    .sort((a, b) =>
      (joinedAtByGroup.get(a.id) ?? '').localeCompare(joinedAtByGroup.get(b.id) ?? '')
    );
}

/** RPCs declared `returns table` arrive as an array of one row. */
function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return (data as T | null) ?? null;
}

export function GroupProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  const [result, setResult] = useState<GroupsResult | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  // A result from a previous user or a superseded retry is simply not a match,
  // so it reads as 'loading'.
  const current =
    result && result.userId === userId && result.attempt === reloadCount ? result : null;

  useEffect(() => {
    if (!userId) return;

    let ignore = false;
    const attempt = reloadCount;

    fetchGroups(userId).then((groups) => {
      if (ignore) return;

      setResult(
        groups === null
          ? { userId, attempt, status: 'error' }
          : { userId, attempt, status: 'loaded', groups }
      );
    });

    return () => {
      ignore = true;
    };
  }, [userId, reloadCount]);

  /**
   * Refetch in place after a mutation.
   *
   * Deliberately does not bump `reloadCount`: that would blank the current
   * result and flash the loading state on every join or leave. Keeping the
   * attempt means stale data stays visible for the one round trip. The user tag
   * still guards against adopting a response after a sign-out.
   */
  const refresh = useCallback(async () => {
    if (!userId) return;

    const groups = await fetchGroups(userId);

    setResult((previous) => {
      // Never adopt over a different user, and never regress to an older
      // attempt: a retry started while this was in flight has already written a
      // newer result, and overwriting it would strand the UI in 'loading'.
      if (previous && (previous.userId !== userId || previous.attempt > reloadCount)) {
        return previous;
      }

      return groups === null
        ? { userId, attempt: reloadCount, status: 'error' }
        : { userId, attempt: reloadCount, status: 'loaded', groups };
    });
  }, [userId, reloadCount]);

  const status: GroupStatus = !current ? 'loading' : current.status === 'error' ? 'error' : 'ready';
  const groups = current?.status === 'loaded' ? current.groups : NO_GROUPS;

  // Falling back to the first group means a selection naming a group the user
  // has left resolves itself, with no effect needed to correct it.
  const currentGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;

  const partner =
    currentGroup && userId
      ? (currentGroup.members.find((member) => member.userId !== userId) ?? null)
      : null;

  const createGroup = useCallback(async (): Promise<CreateGroupResult> => {
    const { data, error } = await supabase.rpc('create_group');
    if (error) return { status: 'error', message: error.message };

    const row = firstRow<{ status: string; group_id: string | null }>(data);
    if (!row) return { status: 'error', message: 'The server did not return a group.' };

    if (row.status === 'group_limit_reached') return { status: 'group_limit_reached' };
    if (row.status !== 'created' || !row.group_id) {
      return { status: 'error', message: 'The group could not be created.' };
    }

    setSelectedGroupId(row.group_id);
    await refresh();
    return { status: 'created', groupId: row.group_id };
  }, [refresh]);

  const joinWithCode = useCallback(
    async (code: string): Promise<JoinGroupResult> => {
      const { data, error } = await supabase.rpc('join_group_with_invite', { p_code: code });
      if (error) return { status: 'error', message: error.message };

      const row = firstRow<{ status: string; group_id: string | null }>(data);
      if (!row) return { status: 'error', message: 'The server did not return a result.' };

      switch (row.status) {
        case 'joined':
        case 'already_member': {
          if (!row.group_id) return { status: 'error', message: 'The group could not be joined.' };
          setSelectedGroupId(row.group_id);
          await refresh();
          return { status: row.status, groupId: row.group_id };
        }
        case 'invalid_code':
        case 'expired':
        case 'group_full':
        case 'group_limit_reached':
          return { status: row.status };
        default:
          return { status: 'error', message: 'The group could not be joined.' };
      }
    },
    [refresh]
  );

  const refreshInvite = useCallback(
    async (groupId: string): Promise<RefreshInviteResult> => {
      const { data, error } = await supabase.rpc('create_group_invite', { p_group_id: groupId });
      if (error) return { status: 'error', message: error.message };

      const row = firstRow<{ status: string; code: string | null; expires_at: string | null }>(data);
      if (!row) return { status: 'error', message: 'The server did not return a code.' };

      if (row.status === 'group_full') return { status: 'group_full' };
      if (row.status === 'not_a_member') return { status: 'not_a_member' };
      if (row.status !== 'created' || !row.code || !row.expires_at) {
        return { status: 'error', message: 'A new code could not be created.' };
      }

      await refresh();
      return { status: 'created', code: row.code, expiresAt: row.expires_at };
    },
    [refresh]
  );

  const leaveGroup = useCallback(
    async (groupId: string): Promise<Failure> => {
      const { error } = await supabase.rpc('leave_group', { p_group_id: groupId });
      if (error) return { error: error.message };

      // Clearing the selection lets it fall back to whatever remains.
      setSelectedGroupId((selected) => (selected === groupId ? null : selected));
      await refresh();
      return { error: null };
    },
    [refresh]
  );

  const value = useMemo<GroupContextValue>(
    () => ({
      status,
      groups,
      currentGroupId: currentGroup?.id ?? null,
      currentGroup,
      partner,
      selectGroup: setSelectedGroupId,
      createGroup,
      joinWithCode,
      refreshInvite,
      leaveGroup,
      retryLoad: () => setReloadCount((count) => count + 1),
    }),
    [
      status,
      groups,
      currentGroup,
      partner,
      createGroup,
      joinWithCode,
      refreshInvite,
      leaveGroup,
    ]
  );

  return <GroupContext value={value}>{children}</GroupContext>;
}
