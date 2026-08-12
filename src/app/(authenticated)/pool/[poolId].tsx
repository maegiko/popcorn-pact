import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GroupRequired } from '@/components/group-required';
import { SwipeDeck } from '@/components/swipe-deck';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';

/**
 * Opens an already-existing pool for swiping. This screen owns nothing about
 * the deck itself -- it only resolves `poolId` from the route and hands it to
 * <SwipeDeck />, which is the sole owner of loading, cards and swipe state.
 *
 * Wrapped in <GroupRequired /> because this is the shared watching experience,
 * matching the same partial gate HomeScreen's swipe surface uses -- the
 * authenticated layout itself only gates on session, not group membership.
 */
export default function PoolScreen() {
  const { poolId } = useLocalSearchParams<{ poolId?: string | string[] }>();
  const normalizedPoolId = Array.isArray(poolId) ? poolId[0] : poolId;

  if (!normalizedPoolId) {
    return <InvalidPool />;
  }

  return (
    <GroupRequired>
      <SwipeDeck poolId={normalizedPoolId} />
    </GroupRequired>
  );
}

function InvalidPool() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle">Pool not found</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          This link looks broken. Head back and start a new pool.
        </ThemedText>
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
});
