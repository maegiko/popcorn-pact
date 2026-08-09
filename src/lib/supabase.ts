import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'
import { AppState, Platform } from 'react-native'

// Expo Router prerenders web routes in Node, where there is no window/localStorage.
// Skip session persistence there; the browser hydrates the real session on mount.
const canPersistSession = typeof window !== 'undefined'

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_KEY!,
  {
    auth: {
      storage: canPersistSession ? AsyncStorage : undefined,
      autoRefreshToken: canPersistSession,
      persistSession: canPersistSession,
      detectSessionInUrl: false,
    },
  })

// Only refresh the session while the app is in the foreground.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh()
    } else {
      supabase.auth.stopAutoRefresh()
    }
  })
}