import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/auth';

/**
 * Shown when the signed-in user's profile could not be loaded. This state is
 * kept separate from onboarding on purpose: treating a failed fetch as an
 * incomplete profile would show the display-name screen to someone who already
 * has a name, and their submission would overwrite it.
 */
export function ProfileLoadError() {
  const theme = useTheme();
  const { retryProfileLoad, signOut } = useSession();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    await signOut();
    setBusy(false);
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle">Something went wrong</ThemedText>

        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          We couldn&apos;t load your profile. Check your connection and try again.
        </ThemedText>

        <Pressable
          onPress={retryProfileLoad}
          disabled={busy}
          style={[
            styles.button,
            { backgroundColor: theme.backgroundSelected, opacity: busy ? 0.5 : 1 },
          ]}>
          <ThemedText type="smallBold">Try again</ThemedText>
        </Pressable>

        <Pressable onPress={handleSignOut} disabled={busy} style={styles.switchButton}>
          <ThemedText type="small" themeColor="textSecondary">
            Sign out
          </ThemedText>
        </Pressable>
      </SafeAreaView>
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
  message: {
    textAlign: 'center',
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  switchButton: {
    alignItems: 'center',
  },
});
