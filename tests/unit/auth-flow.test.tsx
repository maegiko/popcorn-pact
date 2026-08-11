import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { AuthProvider, useSession, type AuthStatus } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

type ObservedAuth = ReturnType<typeof useSession>;
type ProfileResponse = { data: { display_name: string | null } | null; error: { message: string } | null };
type ProfilesQuery = {
  select: jest.Mock<ProfilesQuery, unknown[]>;
  eq: jest.Mock<ProfilesQuery, unknown[]>;
  update: jest.Mock<ProfilesQuery, unknown[]>;
  maybeSingle: jest.Mock<Promise<ProfileResponse>, []>;
  single: jest.Mock<Promise<ProfileResponse>, []>;
};

const mockNativeSignIn = jest.fn();
const mockUnsubscribe = jest.fn();

let mockAuthStateChange: ((event: string, session: MockSession | null) => void) | null = null;
let mockInitialSession: MockSession | null = null;
let mockProfileResponses: ProfileResponse[] = [];
let mockUpdateProfileResponse: ProfileResponse = profileResponse('Stored Name');

type MockSession = {
  access_token: string;
  token_type: string;
  user: { id: string };
};

type MockSupabase = {
  auth: {
    getSession: jest.Mock<Promise<{ data: { session: MockSession | null } }>, []>;
    onAuthStateChange: jest.Mock<
      { data: { subscription: { unsubscribe: jest.Mock<void, []> } } },
      [(event: string, session: MockSession | null) => void]
    >;
    signUp: jest.Mock;
    signInWithPassword: jest.Mock;
    signInWithIdToken: jest.Mock;
    signOut: jest.Mock;
  };
  from: jest.Mock<ProfilesQuery, [string]>;
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: mockInitialSession } })),
      onAuthStateChange: jest.fn((callback: (event: string, session: MockSession | null) => void) => {
        mockAuthStateChange = callback;
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      }),
      signUp: jest.fn(),
      signInWithPassword: jest.fn(),
      signInWithIdToken: jest.fn(),
      signOut: jest.fn(),
    },
    from: jest.fn(() => mockCreateProfilesQuery()),
  },
}));

jest.mock('@/lib/apple-auth', () => ({
  signInWithApple: () => mockNativeSignIn(),
}));

const mockSupabase = supabase as unknown as MockSupabase;

function mockCreateProfilesQuery(): ProfilesQuery {
  const query = {} as ProfilesQuery;

  Object.assign(query, {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    update: jest.fn(() => query),
    maybeSingle: jest.fn(async () => mockProfileResponses.shift() ?? profileResponse(null, 'No profile')),
    single: jest.fn(async () => mockUpdateProfileResponse),
  });

  return query;
}

function profileResponse(displayName: string | null, errorMessage?: string): ProfileResponse {
  return {
    data: errorMessage ? null : { display_name: displayName },
    error: errorMessage ? { message: errorMessage } : null,
  };
}

function session(userId = 'user-1'): MockSession {
  return {
    access_token: `${userId}-token`,
    token_type: 'bearer',
    user: { id: userId },
  };
}

function Probe({ onChange }: { onChange: (value: ObservedAuth) => void }) {
  const value = useSession();

  useEffect(() => {
    onChange(value);
  }, [value, onChange]);

  return null;
}

async function renderAuth() {
  const observed: ObservedAuth[] = [];

  const result = await render(
    <AuthProvider>
      <Probe onChange={(value) => observed.push(value)} />
    </AuthProvider>
  );

  await waitFor(() => expect(last(observed).status).not.toBe('loading'));

  return { ...result, observed, current: () => last(observed) };
}

function last<T>(items: T[]): T {
  const item = items.at(-1);
  if (!item) throw new Error('Expected at least one observed auth value.');
  return item;
}

async function expectStatus(current: () => ObservedAuth, status: AuthStatus) {
  await waitFor(() => expect(current().status).toBe(status));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthStateChange = null;
  mockInitialSession = null;
  mockProfileResponses = [];
  mockUpdateProfileResponse = profileResponse('Stored Name');
});

afterEach(() => {
  cleanup();
});

describe('auth flow unit behavior', () => {
  test('starts signed out when there is no persisted session', async () => {
    const { observed, current } = await renderAuth();

    expect(observed[0].status).toBe('loading');
    expect(current().status).toBe('signedOut');
    expect(current().session).toBeNull();
    expect(current().displayName).toBeNull();
  });

  test('routes a signed-in user with a saved display name into the app', async () => {
    mockInitialSession = session('ready-user');
    mockProfileResponses = [profileResponse('Kenneth')];

    const { current } = await renderAuth();

    await expectStatus(current, 'ready');
    expect(current().session?.user.id).toBe('ready-user');
    expect(current().displayName).toBe('Kenneth');
  });

  test('routes a signed-in user without a display name to profile completion', async () => {
    mockInitialSession = session('new-native-user');
    mockProfileResponses = [profileResponse(null)];

    const { current } = await renderAuth();

    await expectStatus(current, 'needsDisplayName');
    expect(current().displayName).toBeNull();
  });

  test('surfaces profile loading failure as an auth error state', async () => {
    mockInitialSession = session('offline-user');
    mockProfileResponses = [profileResponse(null, 'Network unavailable')];

    const { current } = await renderAuth();

    await expectStatus(current, 'error');
    expect(current().displayName).toBeNull();
  });

  test('does not treat a missing profile as an incomplete display name', async () => {
    mockInitialSession = session('missing-profile-user');
    mockProfileResponses = [{ data: null, error: null }];

    const { current } = await renderAuth();

    await expectStatus(current, 'error');
  });

  test('can retry profile loading after a recoverable failure', async () => {
    mockInitialSession = session('retry-user');
    mockProfileResponses = [profileResponse(null, 'Temporary failure'), profileResponse('Recovered')];

    const { current } = await renderAuth();
    await expectStatus(current, 'error');

    await act(async () => {
      current().retryProfileLoad();
    });

    await expectStatus(current, 'ready');
    expect(current().displayName).toBe('Recovered');
  });

  test('moves from signed out to ready when Supabase emits a signed-in session', async () => {
    mockProfileResponses = [profileResponse('Returning User')];
    const { current } = await renderAuth();

    await act(async () => {
      mockAuthStateChange?.('SIGNED_IN', session('returning-user'));
    });

    await expectStatus(current, 'ready');
    expect(current().session?.user.id).toBe('returning-user');
  });

  test('moves back to signed out when Supabase emits sign-out', async () => {
    mockInitialSession = session('signed-in-user');
    mockProfileResponses = [profileResponse('Signed In')];
    const { current } = await renderAuth();
    await expectStatus(current, 'ready');

    await act(async () => {
      mockAuthStateChange?.('SIGNED_OUT', null);
    });

    await expectStatus(current, 'signedOut');
    expect(current().session).toBeNull();
    expect(current().displayName).toBeNull();
  });

  test('email sign-up reports when the user must confirm email before receiving a session', async () => {
    mockSupabase.auth.signUp.mockResolvedValueOnce({ data: { session: null }, error: null });
    const { current } = await renderAuth();

    const result = await current().signUpWithEmail('new@example.com', 'password', 'New User');

    expect(result).toEqual({ error: null, needsEmailConfirmation: true });
    expect(mockSupabase.auth.signUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'password',
      options: { data: { display_name: 'New User' } },
    });
  });

  test('email sign-up reports Supabase errors', async () => {
    mockSupabase.auth.signUp.mockResolvedValueOnce({
      data: { session: null },
      error: { message: 'Email already registered' },
    });
    const { current } = await renderAuth();

    await expect(current().signUpWithEmail('used@example.com', 'password', 'Used')).resolves.toEqual({
      error: 'Email already registered',
      needsEmailConfirmation: false,
    });
  });

  test('email sign-in reports success and failure without inventing auth state', async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValueOnce({ error: null });
    mockSupabase.auth.signInWithPassword.mockResolvedValueOnce({ error: { message: 'Invalid login' } });
    const { current } = await renderAuth();

    await expect(current().signInWithEmail('me@example.com', 'password')).resolves.toEqual({
      error: null,
    });
    await expect(current().signInWithEmail('me@example.com', 'wrong')).resolves.toEqual({
      error: 'Invalid login',
    });
  });

  test('native provider cancellation is quiet and does not call Supabase', async () => {
    mockNativeSignIn.mockResolvedValueOnce({ status: 'canceled' });
    const { current } = await renderAuth();

    await expect(current().signInWithProvider('apple')).resolves.toEqual({
      error: null,
      canceled: true,
    });
    expect(mockSupabase.auth.signInWithIdToken).not.toHaveBeenCalled();
  });

  test('native provider errors are returned without calling Supabase', async () => {
    mockNativeSignIn.mockResolvedValueOnce({ status: 'error', message: 'Provider unavailable' });
    const { current } = await renderAuth();

    await expect(current().signInWithProvider('apple')).resolves.toEqual({
      error: 'Provider unavailable',
      canceled: false,
    });
    expect(mockSupabase.auth.signInWithIdToken).not.toHaveBeenCalled();
  });

  test('native provider success exchanges the identity token with Supabase', async () => {
    mockNativeSignIn.mockResolvedValueOnce({
      status: 'success',
      idToken: 'identity-token',
      rawNonce: 'raw-nonce',
    });
    mockSupabase.auth.signInWithIdToken.mockResolvedValueOnce({ error: null });
    const { current } = await renderAuth();

    await expect(current().signInWithProvider('apple')).resolves.toEqual({
      error: null,
      canceled: false,
    });
    expect(mockSupabase.auth.signInWithIdToken).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'identity-token',
      nonce: 'raw-nonce',
    });
  });

  test('saving a display name requires a signed-in user', async () => {
    const { current } = await renderAuth();

    await expect(current().saveDisplayName('Nobody')).resolves.toEqual({
      error: 'You are not signed in.',
    });
  });

  test('saving a display name stores the visible profile name and unlocks the app', async () => {
    mockInitialSession = session('profile-user');
    mockProfileResponses = [profileResponse(null)];
    mockUpdateProfileResponse = profileResponse('Trimmed Name');
    const { current } = await renderAuth();
    await expectStatus(current, 'needsDisplayName');

    let saveResult: Awaited<ReturnType<ObservedAuth['saveDisplayName']>> | null = null;
    await act(async () => {
      saveResult = await current().saveDisplayName('  Trimmed Name  ');
    });

    expect(saveResult).toEqual({ error: null });
    await expectStatus(current, 'ready');
    expect(current().displayName).toBe('Trimmed Name');
    expect(mockSupabase.from).toHaveBeenCalledWith('profiles');
  });

  test('saving a display name reports database errors and keeps profile completion required', async () => {
    mockInitialSession = session('profile-error-user');
    mockProfileResponses = [profileResponse(null)];
    mockUpdateProfileResponse = profileResponse(null, 'Display name rejected');
    const { current } = await renderAuth();
    await expectStatus(current, 'needsDisplayName');

    await expect(current().saveDisplayName('Name')).resolves.toEqual({
      error: 'Display name rejected',
    });
    expect(current().status).toBe('needsDisplayName');
  });

  test('sign-out reports Supabase errors', async () => {
    mockSupabase.auth.signOut.mockResolvedValueOnce({ error: { message: 'Sign-out failed' } });
    const { current } = await renderAuth();

    await expect(current().signOut()).resolves.toEqual({ error: 'Sign-out failed' });
  });
});
