import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/auth';

/** Matches the profiles.display_name check constraint. */
const DisplayNameMaxLength = 50;

type Mode = 'signIn' | 'signUp';

export default function SignInScreen() {
  const theme = useTheme();
  const { signIn, signUp } = useSession();

  const [mode, setMode] = useState<Mode>('signIn');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const isSignUp = mode === 'signUp';
  const canSubmit =
    email.trim().length > 0 &&
    password.length > 0 &&
    (!isSignUp || displayName.trim().length > 0) &&
    !busy;

  function switchMode() {
    setMode(isSignUp ? 'signIn' : 'signUp');
    setMessage(null);
  }

  async function handleSubmit() {
    setBusy(true);
    setMessage(null);

    if (isSignUp) {
      const { error, needsEmailConfirmation } = await signUp(
        email.trim(),
        password,
        displayName.trim()
      );
      if (error) {
        setMessage(error.message);
      } else if (needsEmailConfirmation) {
        setMessage('Account created. Check your email to confirm it before signing in.');
      }
    } else {
      const { error } = await signIn(email.trim(), password);
      if (error) setMessage(error.message);
    }

    // On success the root layout swaps to the signed-in stack, so nothing else to do here.
    setBusy(false);
  }

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
            onPress={handleSubmit}
            disabled={!canSubmit}
            style={[
              styles.button,
              { backgroundColor: theme.backgroundSelected, opacity: canSubmit ? 1 : 0.5 },
            ]}>
            <ThemedText type="smallBold">{isSignUp ? 'Create account' : 'Sign in'}</ThemedText>
          </Pressable>

          <Pressable onPress={switchMode} disabled={busy} style={styles.switchButton}>
            <ThemedText type="small" themeColor="textSecondary">
              {isSignUp ? 'Already have an account? Sign in' : 'New here? Create an account'}
            </ThemedText>
          </Pressable>

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
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  switchButton: {
    alignItems: 'center',
  },
  message: {
    textAlign: 'center',
  },
});
