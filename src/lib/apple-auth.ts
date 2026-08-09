import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

/**
 * Outcome of a native provider sign-in, before Supabase is involved.
 *
 * Deliberately provider-neutral: a future `google-auth.ts` returns this same
 * shape, so `AuthProvider` exchanges the token identically and nothing about
 * the profile lifecycle or routing has to change to add a provider.
 */
export type NativeAuthResult =
  | { status: 'success'; idToken: string; rawNonce: string }
  | { status: 'canceled' }
  | { status: 'error'; message: string };

/**
 * Whether to render the Continue with Apple button at all. The module is
 * iOS-only, so Android and web fall back to email/password.
 */
export async function isAppleAuthAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  return AppleAuthentication.isAvailableAsync();
}

export async function signInWithApple(): Promise<NativeAuthResult> {
  try {
    // Supabase compares the *hash* of the nonce it is given against the nonce
    // claim inside the identity token, so Apple must be handed the SHA-256
    // digest and Supabase the raw value. Sending the same value to both is the
    // intuitive mistake and fails with an opaque nonce error.
    const rawNonce = Crypto.randomUUID();
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      rawNonce,
      { encoding: Crypto.CryptoEncoding.HEX }
    );

    const credential = await AppleAuthentication.signInAsync({
      // FULL_NAME is intentionally not requested. Popcorn Pact never uses the
      // Apple real name; the user chooses their own display name after signing
      // in, so asking for it would collect data we refuse to use.
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashedNonce,
    });

    if (!credential.identityToken) {
      return { status: 'error', message: 'Apple did not return an identity token.' };
    }

    return { status: 'success', idToken: credential.identityToken, rawNonce };
  } catch (error) {
    // Dismissing the sheet is a normal outcome, not something to surface.
    if (isCanceled(error)) return { status: 'canceled' };

    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Apple sign-in failed.',
    };
  }
}

function isCanceled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_REQUEST_CANCELED'
  );
}
