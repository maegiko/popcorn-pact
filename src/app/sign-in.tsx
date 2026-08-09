import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/auth';

export default function SignInScreen() {
  const theme = useTheme();
  const { signIn, signUp } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  async function handleCreateAccount() {
    setBusy(true);
    setMessage(null);
    const { error, needsEmailConfirmation } = await signUp(email.trim(), password);
    if (error) {
      setMessage(error.message);
    } else if (needsEmailConfirmation) {
      setMessage('Account created. Check your email to confirm it before signing in.');
    }
    // On success the root layout swaps to the signed-in stack, so nothing else to do here.
    setBusy(false);
  }

  async function handleSignIn() {
    setBusy(true);
    setMessage(null);
    const { error } = await signIn(email.trim(), password);
    if (error) setMessage(error.message);
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
            autoComplete="current-password"
            secureTextEntry
            editable={!busy}
            style={inputStyle}
          />

          <Pressable
            onPress={handleCreateAccount}
            disabled={!canSubmit}
            style={[
              styles.button,
              { backgroundColor: theme.backgroundSelected, opacity: canSubmit ? 1 : 0.5 },
            ]}>
            <ThemedText type="smallBold">Create account</ThemedText>
          </Pressable>

          <Pressable
            onPress={handleSignIn}
            disabled={!canSubmit}
            style={[
              styles.button,
              { backgroundColor: theme.backgroundElement, opacity: canSubmit ? 1 : 0.5 },
            ]}>
            <ThemedText type="smallBold">Sign in</ThemedText>
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
  message: {
    textAlign: 'center',
  },
});
