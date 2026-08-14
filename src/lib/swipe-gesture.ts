/**
 * Maps a drag gesture's horizontal distance to a swipe decision. Deliberately
 * pure and free of any gesture-library or React import: it is the one piece
 * of the swipe gesture that is actual business logic (which direction maps to
 * which decision), so it stays correct -- and trivially unit-testable -- even
 * if the animation implementation changes later.
 */
export const SWIPE_DECISION_THRESHOLD = 120;

/**
 * `'worklet'` is load-bearing, not decoration: this is called synchronously
 * from the pan gesture's `.onEnd()` on the UI thread (see swipe-deck.tsx), and
 * an imported plain JS function is not automatically workletized there.
 * Without this directive Reanimated cannot run it on the UI runtime and
 * throws ("Tried to synchronously call a Remote Function") instead of
 * silently marshalling across runtimes -- the fix is to make the function
 * itself callable from either runtime, not to hop to JS via runOnJS for a
 * threshold comparison this cheap and pure.
 */
export function resolveSwipeGesture(translationX: number): 'pass' | 'like' | null {
  'worklet';
  if (translationX <= -SWIPE_DECISION_THRESHOLD) return 'pass';
  if (translationX >= SWIPE_DECISION_THRESHOLD) return 'like';
  return null;
}
