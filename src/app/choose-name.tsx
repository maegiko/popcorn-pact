import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { DisplayNameMaxLength, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/auth';

/**
 * Profile completion. Reached whenever a signed-in user has no display name,
 * which in practice means they authenticated with Apple — Popcorn Pact never
 * adopts the real name Apple offers. Nothing here is provider-specific, so a
 * future Google sign-in lands on this same screen.
 *
 * There is no skip: the router only admits a user to the main app once a name
 * exists, and the database refuses to let one be cleared afterwards.
 */
export default function ChooseNameScreen() {
  const theme = useTheme();
  const { saveDisplayName, signOut } = useSession();

  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const canSubmit = displayName.trim().length > 0 && !busy;

  async function handleContinue() {
    setBusy(true);
    setMessage(null);

    const { error } = await saveDisplayName(displayName);
    if (error) setMessage(error);

    // On success the status flips to 'ready' and the root layout swaps to the
    // authenticated stack, so there is nothing to navigate to here.
    setBusy(false);
  }

  async function handleSignOut() {
    setBusy(true);
    await signOut();
    setBusy(false);
  }

  return (
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={styles.safeArea}>
          <ThemedText type="subtitle">What should we call you?</ThemedText>

          <ThemedText type="small" themeColor="textSecondary">
            This is the name your partner sees when you match.
          </ThemedText>

          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Display name"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="words"
            autoCorrect={false}
            autoComplete="name"
            autoFocus
            maxLength={DisplayNameMaxLength}
            editable={!busy}
            style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }]}
          />

          <Pressable
            onPress={handleContinue}
            disabled={!canSubmit}
            style={[
              styles.button,
              { backgroundColor: theme.backgroundSelected, opacity: canSubmit ? 1 : 0.5 },
            ]}>
            <ThemedText type="smallBold">Continue</ThemedText>
          </Pressable>

          <Pressable onPress={handleSignOut} disabled={busy} style={styles.switchButton}>
            <ThemedText type="small" themeColor="textSecondary">
              Sign out
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
