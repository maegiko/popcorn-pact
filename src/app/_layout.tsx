import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthLoading } from '@/components/auth-loading';
import { ProfileLoadError } from '@/components/profile-load-error';
import { AuthProvider, useSession } from '@/lib/auth';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { status } = useSession();

  // At startup the splash overlay covers this. It also appears after the splash
  // is gone: between signing in and the profile arriving, and during a retry.
  if (status === 'loading') return <AuthLoading />;

  if (status === 'error') return <ProfileLoadError />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'ready'}>
        <Stack.Screen name="(authenticated)" />
      </Stack.Protected>

      <Stack.Protected guard={status === 'needsDisplayName'}>
        <Stack.Screen name="choose-name" />
      </Stack.Protected>

      <Stack.Protected guard={status === 'signedOut'}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

function RootShell() {
  const { status } = useSession();

  return (
    <>
      <AnimatedSplashOverlay ready={status !== 'loading'} />
      <RootNavigator />
    </>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <RootShell />
        </AuthProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
