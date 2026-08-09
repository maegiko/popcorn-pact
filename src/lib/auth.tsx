import type { Session } from '@supabase/supabase-js';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';

import { signInWithApple, type NativeAuthResult } from '@/lib/apple-auth';
import { supabase } from '@/lib/supabase';

/**
 * The single value that drives routing.
 *
 * `error` is deliberately distinct from `needsDisplayName`: if the profile
 * fetch fails we must not assume the profile is incomplete, or an offline user
 * who already has a name would be shown onboarding and overwrite it.
 */
export type AuthStatus = 'loading' | 'signedOut' | 'needsDisplayName' | 'ready' | 'error';

/** Providers authenticated with a native identity token. Add 'google' here. */
export type NativeProvider = 'apple';

const nativeSignIn: Record<NativeProvider, () => Promise<NativeAuthResult>> = {
  apple: signInWithApple,
};

/**
 * A profile fetch result tagged with the user and attempt it belongs to.
 *
 * Carrying that identity means "no result matching the current user and
 * attempt" *is* the loading state, so nothing has to be reset synchronously
 * when the user changes, and a response for a previous user can never be
 * mistaken for the current one.
 */
type ProfileResult = { userId: string; attempt: number } & (
  | { status: 'loaded'; displayName: string | null }
  | { status: 'error' }
);

type Failure = { error: string | null };

type SignUpResult = Failure & {
  /** True when Supabase created the user but requires email confirmation before a session exists. */
  needsEmailConfirmation: boolean;
};

type NativeSignInOutcome = Failure & {
  /** True when the user dismissed the provider sheet; not an error to display. */
  canceled: boolean;
};

type AuthContextValue = {
  session: Session | null;
  status: AuthStatus;
  displayName: string | null;
  signInWithProvider: (provider: NativeProvider) => Promise<NativeSignInOutcome>;
  signUpWithEmail: (email: string, password: string, displayName: string) => Promise<SignUpResult>;
  signInWithEmail: (email: string, password: string) => Promise<Failure>;
  saveDisplayName: (displayName: string) => Promise<Failure>;
  signOut: () => Promise<Failure>;
  retryProfileLoad: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useSession() {
  const value = use(AuthContext);
  if (!value) {
    throw new Error('useSession must be wrapped in an <AuthProvider />');
  }
  return value;
}

function deriveStatus(
  isSessionLoading: boolean,
  session: Session | null,
  profile: ProfileResult | null
): AuthStatus {
  if (isSessionLoading) return 'loading';
  if (!session) return 'signedOut';
  if (!profile) return 'loading';
  if (profile.status === 'error') return 'error';
  return profile.displayName === null ? 'needsDisplayName' : 'ready';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [profileResult, setProfileResult] = useState<ProfileResult | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  const userId = session?.user.id ?? null;

  // A result from a previous user or a superseded retry is simply not a match,
  // so it reads as 'loading' rather than briefly showing the wrong screen.
  const profile =
    profileResult && profileResult.userId === userId && profileResult.attempt === reloadCount
      ? profileResult
      : null;

  useEffect(() => {
    // Hydrate from AsyncStorage, then keep in sync with sign in / sign out / token refresh.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsSessionLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  // Keyed on the user id, not the session object: TOKEN_REFRESHED hands us a
  // new session roughly hourly, and refetching on that would churn the status
  // and bounce the user between screens.
  useEffect(() => {
    if (!userId) return;

    let ignore = false;
    const attempt = reloadCount;

    supabase
      .from('profiles')
      .select('display_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        // Discard a response that landed after sign-out or a user switch.
        if (ignore) return;

        // A missing row means the signup trigger did not run. That is a real
        // fault, not an incomplete profile, so it must not route to onboarding.
        setProfileResult(
          error || !data
            ? { userId, attempt, status: 'error' }
            : { userId, attempt, status: 'loaded', displayName: data.display_name }
        );
      });

    return () => {
      ignore = true;
    };
  }, [userId, reloadCount]);

  const status = deriveStatus(isSessionLoading, session, profile);
  const displayName = profile?.status === 'loaded' ? profile.displayName : null;

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      status,
      displayName,
      signInWithProvider: async (provider) => {
        const result = await nativeSignIn[provider]();

        if (result.status === 'canceled') return { error: null, canceled: true };
        if (result.status === 'error') return { error: result.message, canceled: false };

        // The raw nonce goes here; Apple received its SHA-256 digest.
        const { error } = await supabase.auth.signInWithIdToken({
          provider,
          token: result.idToken,
          nonce: result.rawNonce,
        });

        return { error: error?.message ?? null, canceled: false };
      },
      signUpWithEmail: async (email, password, name) => {
        // display_name lands in auth.users.raw_user_meta_data, which the
        // on_auth_user_created trigger reads to seed profiles.display_name, so
        // email registrations arrive with a complete profile.
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: name } },
        });

        return {
          error: error?.message ?? null,
          needsEmailConfirmation: !error && !data.session,
        };
      },
      signInWithEmail: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error?.message ?? null };
      },
      saveDisplayName: async (name) => {
        if (!userId) return { error: 'You are not signed in.' };

        const { data, error } = await supabase
          .from('profiles')
          .update({ display_name: name.trim() })
          .eq('id', userId)
          .select('display_name')
          .single();

        if (error) return { error: error.message };

        // Adopt the stored row directly so status flips to 'ready' without a
        // refetch round-trip, and without a frame of the wrong screen.
        setProfileResult({
          userId,
          attempt: reloadCount,
          status: 'loaded',
          displayName: data.display_name,
        });
        return { error: null };
      },
      signOut: async () => {
        const { error } = await supabase.auth.signOut();
        return { error: error?.message ?? null };
      },
      retryProfileLoad: () => setReloadCount((count) => count + 1),
    }),
    [session, status, displayName, userId, reloadCount]
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
