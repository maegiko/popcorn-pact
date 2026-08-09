import { ActivityIndicator, StyleSheet } from 'react-native';

import { ThemedView } from '@/components/themed-view';

/**
 * Shown while auth state is resolving.
 *
 * During startup the splash overlay covers this, but the loading state recurs
 * after the splash is gone — between a successful sign-in and the profile
 * arriving, and while retrying a failed profile load. Rendering nothing in
 * those windows would show a blank screen.
 */
export function AuthLoading() {
  return (
    <ThemedView style={styles.container}>
      <ActivityIndicator />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
