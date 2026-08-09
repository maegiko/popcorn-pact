import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { DisplayNameMaxLength, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isAppleAuthAvailable } from '@/lib/apple-auth';
import { useSession } from '@/lib/auth';

type EmailMode = 'signIn' | 'signUp';

export default function SignInScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const { signInWithProvider, signInWithEmail, signUpWithEmail } = useSession();

  // null while the native availability check is in flight, so the screen never
  // renders a layout it is about to change.
  const [appleAvailable, setAppleAvailable] = useState<boolean | null>(null);
  const [showEmail, setShowEmail] = useState(false);
  const [emailMode, setEmailMode] = useState<EmailMode>('signIn');

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    isAppleAuthAvailable().then((available) => {
      if (!ignore) setAppleAvailable(available);
    });
    return () => {
      ignore = true;
    };
  }, []);

  const isSignUp = emailMode === 'signUp';
  const canSubmitEmail =
    email.trim().length > 0 &&
    password.length > 0 &&
    (!isSignUp || displayName.trim().length > 0) &&
    !busy;

  async function handleApple() {
    setBusy(true);
    setMessage(null);

    const { error, canceled } = await signInWithProvider('apple');
    // Dismissing the Apple sheet is not a failure worth reporting.
    if (error && !canceled) setMessage(error);

    // On success the root layout swaps stacks: to the display-name screen for a
    // first-time Apple user, straight into the app for a returning one.
    setBusy(false);
  }

  async function handleEmailSubmit() {
    setBusy(true);
    setMessage(null);

    if (isSignUp) {
      const { error, needsEmailConfirmation } = await signUpWithEmail(
        email.trim(),
        password,
        displayName.trim()
      );
      if (error) {
        setMessage(error);
      } else if (needsEmailConfirmation) {
        setMessage('Account created. Check your email to confirm it before signing in.');
      }
    } else {
      const { error } = await signInWithEmail(email.trim(), password);
      if (error) setMessage(error);
    }

    setBusy(false);
  }

  function switchEmailMode() {
    setEmailMode(isSignUp ? 'signIn' : 'signUp');
    setMessage(null);
  }

  function backToOptions() {
    setShowEmail(false);
    setMessage(null);
  }

  if (appleAvailable === null) return <ThemedView style={styles.container} />;

  // Apple is iOS-only, so elsewhere email is the only route in and the chooser
  // would be a one-option menu.
  const emailOnly = !appleAvailable;
  const showEmailForm = showEmail || emailOnly;

  const inputStyle = [
    styles.input,
    { backgroundColor: theme.backgroundElement, color: theme.text },
  ];

  return (
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={styles.safeArea}>
          <ThemedText type="subtitle">Popcorn Pact</ThemedText>

          {!showEmailForm && (
            <>
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                buttonStyle={
                  colorScheme === 'dark'
                    ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                    : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                }
                cornerRadius={Spacing.two}
                style={styles.appleButton}
                onPress={handleApple}
              />

              <Pressable
                onPress={() => setShowEmail(true)}
                disabled={busy}
                style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
                <ThemedText type="smallBold">Continue with email</ThemedText>
              </Pressable>
            </>
          )}

          {showEmailForm && (
            <>
              {isSignUp && (
                <TextInput
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="Display name"
                  placeholderTextColor={theme.textSecondary}
                  autoCapitalize="words"
                  autoCorrect={false}
                  autoComplete="name"
                  maxLength={DisplayNameMaxLength}
                  editable={!busy}
                  style={inputStyle}
                />
              )}

              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="Email"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                inputMode="email"
                editable={!busy}
                style={inputStyle}
              />

              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                secureTextEntry
                editable={!busy}
                style={inputStyle}
              />

              <Pressable
                onPress={handleEmailSubmit}
                disabled={!canSubmitEmail}
                style={[
                  styles.button,
                  {
                    backgroundColor: theme.backgroundSelected,
                    opacity: canSubmitEmail ? 1 : 0.5,
                  },
                ]}>
                <ThemedText type="smallBold">
                  {isSignUp ? 'Create account' : 'Sign in'}
                </ThemedText>
              </Pressable>

              <Pressable onPress={switchEmailMode} disabled={busy} style={styles.linkButton}>
                <ThemedText type="small" themeColor="textSecondary">
                  {isSignUp ? 'Already have an account? Sign in' : 'New here? Create an account'}
                </ThemedText>
              </Pressable>

              {!emailOnly && (
                <Pressable onPress={backToOptions} disabled={busy} style={styles.linkButton}>
                  <ThemedText type="small" themeColor="textSecondary">
                    Back to all options
                  </ThemedText>
                </Pressable>
              )}
            </>
          )}

          {busy && (
            <ThemedText type="small" themeColor="textSecondary">
              Working…
            </ThemedText>
          )}

          {message && (
            <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
              {message}
            </ThemedText>
          )}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  appleButton: {
    width: '100%',
    height: 48,
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  linkButton: {
    alignItems: 'center',
  },
  message: {
    textAlign: 'center',
  },
});
