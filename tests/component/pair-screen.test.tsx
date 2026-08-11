import { fireEvent, render, waitFor } from '@testing-library/react-native';

import PairScreen from '@/app/(authenticated)/pair';
import type { GroupSummary, JoinGroupResult, RefreshInviteResult } from '@/lib/group';

type MockGroupValue = {
  status: 'loading' | 'error' | 'ready';
  currentGroup: GroupSummary | null;
  partner: GroupSummary['members'][number] | null;
  createGroup: jest.Mock;
  joinWithCode: jest.Mock;
  refreshInvite: jest.Mock;
  leaveGroup: jest.Mock;
};

let mockGroupValue: MockGroupValue;
const mockRouterBack = jest.fn();
const mockRouterCanGoBack = jest.fn(() => true);

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: mockRouterBack,
    canGoBack: mockRouterCanGoBack,
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/lib/group', () => ({
  useGroups: () => mockGroupValue,
}));

function group(overrides: Partial<GroupSummary> = {}): GroupSummary {
  return {
    id: overrides.id ?? 'group-1',
    ownerId: overrides.ownerId ?? 'user-1',
    isOwner: overrides.isOwner ?? true,
    accessState: overrides.accessState ?? 'active',
    memberCount: overrides.memberCount ?? 1,
    memberLimit: overrides.memberLimit ?? 2,
    members: overrides.members ?? [
      { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:00:00.000Z' },
    ],
    invite: overrides.invite ?? {
      code: 'ABCD1234',
      expiresAt: '2026-08-18T00:00:00.000Z',
    },
  };
}

function pairedGroup(): GroupSummary {
  return group({
    memberCount: 2,
    invite: null,
    members: [
      { userId: 'user-1', displayName: 'Kenneth', joinedAt: '2026-08-11T00:00:00.000Z' },
      { userId: 'user-2', displayName: 'Partner', joinedAt: '2026-08-11T00:01:00.000Z' },
    ],
  });
}

function setUnpairedGroup(nextGroup: GroupSummary | null) {
  mockGroupValue.currentGroup = nextGroup;
  mockGroupValue.partner = null;
}

function setPairedGroup(nextGroup: GroupSummary) {
  mockGroupValue.currentGroup = nextGroup;
  mockGroupValue.partner = nextGroup.members.find((member) => member.userId !== 'user-1') ?? null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGroupValue = {
    status: 'ready',
    currentGroup: null,
    partner: null,
    createGroup: jest.fn(),
    joinWithCode: jest.fn(),
    refreshInvite: jest.fn(),
    leaveGroup: jest.fn(async () => ({ error: null })),
  };
});

async function enterJoinMode(screen: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(screen.getByText('I have a code'));
  await waitFor(() => expect(screen.getByPlaceholderText('7GK2N4QX')).toBeTruthy());
}

describe('PairScreen behavior', () => {
  test('create mode calls the create-group action', async () => {
    mockGroupValue.createGroup.mockResolvedValueOnce({ status: 'created', groupId: 'group-1' });

    const screen = await render(<PairScreen />);

    await fireEvent.press(screen.getByText('Invite someone'));

    expect(mockGroupValue.createGroup).toHaveBeenCalledTimes(1);
  });

  test('successful create shows invite code', async () => {
    mockGroupValue.createGroup.mockImplementationOnce(async () => {
      setUnpairedGroup(group({ invite: { code: 'WXYZ7890', expiresAt: '2026-08-18T00:00:00.000Z' } }));
      return { status: 'created', groupId: 'group-1' };
    });

    const screen = await render(<PairScreen />);

    await fireEvent.press(screen.getByText('Invite someone'));
    await screen.rerender(<PairScreen />);

    expect(screen.getByText('WXYZ 7890')).toBeTruthy();
  });

  test('invite code is formatted correctly for display', async () => {
    setUnpairedGroup(group({ invite: { code: 'ABCD1234', expiresAt: '2026-08-18T00:00:00.000Z' } }));

    const screen = await render(<PairScreen />);

    expect(screen.getByText('ABCD 1234')).toBeTruthy();
  });

  test('refresh/new-code action replaces the old code', async () => {
    setUnpairedGroup(group({ invite: { code: 'OLDCODE1', expiresAt: '2026-08-18T00:00:00.000Z' } }));
    mockGroupValue.refreshInvite.mockImplementationOnce(async (): Promise<RefreshInviteResult> => {
      setUnpairedGroup(group({ invite: { code: 'NEWCODE2', expiresAt: '2026-08-18T00:00:00.000Z' } }));
      return { status: 'created', code: 'NEWCODE2', expiresAt: '2026-08-18T00:00:00.000Z' };
    });

    const screen = await render(<PairScreen />);

    expect(screen.getByText('OLDC ODE1')).toBeTruthy();
    await fireEvent.press(screen.getByText('Get a new code'));
    await screen.rerender(<PairScreen />);

    expect(screen.queryByText('OLDC ODE1')).toBeNull();
    expect(screen.getByText('NEWC ODE2')).toBeTruthy();
    expect(mockGroupValue.refreshInvite).toHaveBeenCalledWith('group-1');
  });

  test('join mode accepts lowercase and formatted input', async () => {
    mockGroupValue.joinWithCode.mockResolvedValueOnce({ status: 'invalid_code' });
    const screen = await render(<PairScreen />);

    await enterJoinMode(screen);
    await fireEvent.changeText(screen.getByPlaceholderText('7GK2N4QX'), ' abcd-1234 ');

    await fireEvent.press(screen.getByText('Join'));

    expect(mockGroupValue.joinWithCode).toHaveBeenCalledWith('ABCD1234');
  });

  test.each([
    [
      { status: 'invalid_code' } satisfies JoinGroupResult,
      "That code doesn't exist. Check it and try again.",
    ],
    [{ status: 'expired' } satisfies JoinGroupResult, 'That code has expired — ask for a new one.'],
    [{ status: 'group_full' } satisfies JoinGroupResult, 'That group is already full.'],
    [
      { status: 'group_limit_reached' } satisfies JoinGroupResult,
      "You're already in a group. Leave it first to join another.",
    ],
  ])('join result %s shows the right user message', async (result, message) => {
    mockGroupValue.joinWithCode.mockResolvedValueOnce(result);
    const screen = await render(<PairScreen />);

    await enterJoinMode(screen);
    await fireEvent.changeText(screen.getByPlaceholderText('7GK2N4QX'), 'ABCD1234');

    await fireEvent.press(screen.getByText('Join'));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });

  test('successful join dismisses/advances to the paired experience', async () => {
    mockGroupValue.joinWithCode.mockImplementationOnce(async () => {
      setPairedGroup(pairedGroup());
      return { status: 'joined', groupId: 'group-1' };
    });
    const screen = await render(<PairScreen />);

    await enterJoinMode(screen);
    await fireEvent.changeText(screen.getByPlaceholderText('7GK2N4QX'), 'ABCD1234');

    await fireEvent.press(screen.getByText('Join'));
    await screen.rerender(<PairScreen />);

    expect(screen.getByText("You're paired")).toBeTruthy();
    expect(screen.getByText('Start swiping')).toBeTruthy();
  });
});
