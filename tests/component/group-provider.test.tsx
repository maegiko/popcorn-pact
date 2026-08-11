import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { GroupProvider, useGroups, type GroupSummary } from '@/lib/group';
import { supabase } from '@/lib/supabase';

type ObservedGroups = ReturnType<typeof useGroups>;
type MockSession = { user: { id: string } } | null;
type QueryResponse = { data: unknown[] | null; error: { message: string } | null };
type RpcResponse = { data: unknown; error: { message: string } | null };
type MockQuery = {
  select: jest.Mock<MockQuery, unknown[]>;
  is: jest.Mock<MockQuery, unknown[]>;
  gt: jest.Mock<MockQuery, unknown[]>;
  then: Promise<QueryResponse>['then'];
};
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

let mockSession: MockSession = { user: { id: 'user-1' } };
const mockTableResponses: Record<string, (QueryResponse | Promise<QueryResponse>)[]> = {
  group_members: [],
  group_access: [],
  group_invites: [],
};

const mockSupabase = supabase as unknown as {
  from: jest.Mock;
  rpc: jest.Mock<Promise<RpcResponse>, [string, Record<string, unknown>?]>;
};

jest.mock('@/lib/auth', () => ({
  useSession: () => ({ session: mockSession }),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => mockQuery(table)),
    rpc: jest.fn(),
  },
}));

function mockQuery(table: string): MockQuery {
  const query = {} as MockQuery;

  Object.assign(query, {
    select: jest.fn(() => query),
    is: jest.fn(() => query),
    gt: jest.fn(() => query),
    then: (resolve: (value: QueryResponse) => void, reject?: (error: unknown) => void) => {
      const response = mockTableResponses[table]?.shift();
      if (!response) {
        throw new Error(`No mocked response queued for ${table}.`);
      }

      return Promise.resolve(response).then(resolve, reject);
    },
  });

  return query;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function queueGroupLoad(groups: GroupSummary[]) {
  mockTableResponses.group_members.push({
    data: groups.flatMap((group) =>
      group.members.map((member) => ({
        group_id: group.id,
        user_id: member.userId,
        joined_at: member.joinedAt,
        profiles: { display_name: member.displayName },
      }))
    ),
    error: null,
  });
  mockTableResponses.group_access.push({
    data: groups.map((group) => ({
      group_id: group.id,
      created_by: group.ownerId,
      member_count: group.memberCount,
      member_limit: group.memberLimit,
      state: group.accessState,
    })),
    error: null,
  });
  mockTableResponses.group_invites.push({
    data: groups.flatMap((group) =>
      group.invite
        ? [
            {
              group_id: group.id,
              code: group.invite.code,
              expires_at: group.invite.expiresAt,
            },
          ]
        : []
    ),
    error: null,
  });
}

function queueGroupLoadFailure(message = 'Database unavailable') {
  mockTableResponses.group_members.push({ data: null, error: { message } });
  mockTableResponses.group_access.push({ data: [], error: null });
  mockTableResponses.group_invites.push({ data: [], error: null });
}

function group(overrides: Partial<GroupSummary> & { id: string }): GroupSummary {
  const currentUser = overrides.members?.[0]?.userId ?? 'user-1';

  return {
    id: overrides.id,
    ownerId: overrides.ownerId ?? currentUser,
    isOwner: overrides.isOwner ?? true,
    accessState: overrides.accessState ?? 'active',
    memberCount: overrides.memberCount ?? 1,
    memberLimit: overrides.memberLimit ?? 2,
    members: overrides.members ?? [
      { userId: currentUser, displayName: 'Current User', joinedAt: '2026-08-11T00:00:00.000Z' },
    ],
    invite: overrides.invite ?? null,
  };
}

function Probe({ onChange }: { onChange: (value: ObservedGroups) => void }) {
  const value = useGroups();

  useEffect(() => {
    onChange(value);
  }, [value, onChange]);

  return null;
}

async function renderGroups({ waitForReady = true } = {}) {
  const observed: ObservedGroups[] = [];

  const result = await render(
    <GroupProvider>
      <Probe onChange={(value) => observed.push(value)} />
    </GroupProvider>
  );

  if (waitForReady) {
    await waitFor(() => expect(current().status).not.toBe('loading'));
  }

  function current() {
    const value = observed.at(-1);
    if (!value) throw new Error('Expected at least one observed group value.');
    return value;
  }

  return { ...result, observed, current };
}

beforeEach(() => {
  mockSession = { user: { id: 'user-1' } };
  mockTableResponses.group_members = [];
  mockTableResponses.group_access = [];
  mockTableResponses.group_invites = [];
  jest.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('GroupProvider behavior', () => {
  test('initial load exposes loading', async () => {
    const members = deferred<QueryResponse>();
    const access = deferred<QueryResponse>();
    const invites = deferred<QueryResponse>();
    mockTableResponses.group_members.push(members.promise);
    mockTableResponses.group_access.push(access.promise);
    mockTableResponses.group_invites.push(invites.promise);

    const { current } = await renderGroups({ waitForReady: false });

    expect(current().status).toBe('loading');
    expect(current().groups).toEqual([]);
    expect(current().currentGroup).toBeNull();
  });

  test('successful load with no groups becomes ready with an empty list', async () => {
    queueGroupLoad([]);

    const { current } = await renderGroups();

    expect(current().status).toBe('ready');
    expect(current().groups).toEqual([]);
    expect(current().currentGroup).toBeNull();
    expect(current().currentGroupId).toBeNull();
  });

  test('successful load with one group exposes the correct current group', async () => {
    queueGroupLoad([
      group({
        id: 'group-1',
        invite: { code: 'ABCD1234', expiresAt: '2026-08-18T00:00:00.000Z' },
        members: [
          { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:00:00.000Z' },
          { userId: 'user-2', displayName: 'Partner', joinedAt: '2026-08-11T00:01:00.000Z' },
        ],
        memberCount: 2,
      }),
    ]);

    const { current } = await renderGroups();

    expect(current().status).toBe('ready');
    expect(current().currentGroupId).toBe('group-1');
    expect(current().currentGroup?.invite?.code).toBe('ABCD1234');
    expect(current().partner?.displayName).toBe('Partner');
  });

  test('multiple groups derive the current group from the oldest membership and selection', async () => {
    queueGroupLoad([
      group({
        id: 'newer-group',
        members: [
          { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:10:00.000Z' },
        ],
      }),
      group({
        id: 'older-group',
        members: [
          { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:00:00.000Z' },
        ],
      }),
    ]);

    const { current } = await renderGroups();

    expect(current().groups.map((item) => item.id)).toEqual(['older-group', 'newer-group']);
    expect(current().currentGroupId).toBe('older-group');

    await act(async () => {
      current().selectGroup('newer-group');
    });

    expect(current().currentGroupId).toBe('newer-group');
  });

  test('stale response from a previous user is ignored', async () => {
    const oldMembers = deferred<QueryResponse>();
    const oldAccess = deferred<QueryResponse>();
    const oldInvites = deferred<QueryResponse>();
    mockTableResponses.group_members.push(oldMembers.promise);
    mockTableResponses.group_access.push(oldAccess.promise);
    mockTableResponses.group_invites.push(oldInvites.promise);

    const view = await renderGroups({ waitForReady: false });

    mockSession = { user: { id: 'user-2' } };
    queueGroupLoad([]);
    await view.rerender(
      <GroupProvider>
        <Probe onChange={(value) => view.observed.push(value)} />
      </GroupProvider>
    );
    await waitFor(() => expect(view.current().status).toBe('ready'));

    await act(async () => {
      oldMembers.resolve({
        data: [
          {
            group_id: 'stale-group',
            user_id: 'user-1',
            joined_at: '2026-08-11T00:00:00.000Z',
            profiles: { display_name: 'Old User' },
          },
        ],
        error: null,
      });
      oldAccess.resolve({
        data: [
          {
            group_id: 'stale-group',
            created_by: 'user-1',
            member_count: 1,
            member_limit: 2,
            state: 'active',
          },
        ],
        error: null,
      });
      oldInvites.resolve({ data: [], error: null });
    });

    expect(view.current().status).toBe('ready');
    expect(view.current().groups).toEqual([]);
  });

  test('token refresh does not unnecessarily reload group state', async () => {
    queueGroupLoad([group({ id: 'group-1' })]);

    const view = await renderGroups();
    expect(mockSupabase.from).toHaveBeenCalledTimes(3);

    mockSession = { user: { id: 'user-1' } };
    await view.rerender(
      <GroupProvider>
        <Probe onChange={(value) => view.observed.push(value)} />
      </GroupProvider>
    );

    expect(view.current().currentGroupId).toBe('group-1');
    expect(mockSupabase.from).toHaveBeenCalledTimes(3);
  });

  test('database failure becomes error, not no groups', async () => {
    queueGroupLoadFailure();

    const { current } = await renderGroups();

    expect(current().status).toBe('error');
    expect(current().groups).toEqual([]);
  });

  test('retry after failure works', async () => {
    queueGroupLoadFailure();
    queueGroupLoad([group({ id: 'recovered-group' })]);

    const { current } = await renderGroups();
    expect(current().status).toBe('error');

    await act(async () => {
      current().retryLoad();
    });

    await waitFor(() => expect(current().status).toBe('ready'));
    expect(current().currentGroupId).toBe('recovered-group');
  });

  test('create group adds and selects the new group', async () => {
    queueGroupLoad([]);
    queueGroupLoad([group({ id: 'created-group' })]);
    mockSupabase.rpc.mockResolvedValueOnce({
      data: [{ status: 'created', group_id: 'created-group' }],
      error: null,
    });

    const { current } = await renderGroups();
    let createResult: Awaited<ReturnType<ObservedGroups['createGroup']>> | null = null;
    await act(async () => {
      createResult = await current().createGroup();
    });

    expect(createResult).toEqual({ status: 'created', groupId: 'created-group' });
    await waitFor(() => expect(current().currentGroupId).toBe('created-group'));
    expect(current().groups.map((item) => item.id)).toEqual(['created-group']);
    expect(mockSupabase.rpc).toHaveBeenCalledWith('create_group');
  });

  test('join group adds and selects the joined group', async () => {
    queueGroupLoad([]);
    queueGroupLoad([group({ id: 'joined-group' })]);
    mockSupabase.rpc.mockResolvedValueOnce({
      data: [{ status: 'joined', group_id: 'joined-group' }],
      error: null,
    });

    const { current } = await renderGroups();
    let joinResult: Awaited<ReturnType<ObservedGroups['joinWithCode']>> | null = null;
    await act(async () => {
      joinResult = await current().joinWithCode('ABCD1234');
    });

    expect(joinResult).toEqual({ status: 'joined', groupId: 'joined-group' });
    await waitFor(() => expect(current().currentGroupId).toBe('joined-group'));
    expect(mockSupabase.rpc).toHaveBeenCalledWith('join_group_with_invite', { p_code: 'ABCD1234' });
  });

  test('leave group removes it and chooses a new current group if needed', async () => {
    queueGroupLoad([
      group({
        id: 'leaving-group',
        members: [
          { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:00:00.000Z' },
        ],
      }),
      group({
        id: 'remaining-group',
        members: [
          { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:01:00.000Z' },
        ],
      }),
    ]);
    queueGroupLoad([
      group({
        id: 'remaining-group',
        members: [
          { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:01:00.000Z' },
        ],
      }),
    ]);
    mockSupabase.rpc.mockResolvedValueOnce({ data: null, error: null });

    const { current } = await renderGroups();
    expect(current().currentGroupId).toBe('leaving-group');

    let leaveResult: Awaited<ReturnType<ObservedGroups['leaveGroup']>> | null = null;
    await act(async () => {
      leaveResult = await current().leaveGroup('leaving-group');
    });

    expect(leaveResult).toEqual({ error: null });
    await waitFor(() => expect(current().currentGroupId).toBe('remaining-group'));
    expect(current().groups.map((item) => item.id)).toEqual(['remaining-group']);
    expect(mockSupabase.rpc).toHaveBeenCalledWith('leave_group', { p_group_id: 'leaving-group' });
  });
});
