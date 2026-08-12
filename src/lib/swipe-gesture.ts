/**
 * Maps a drag gesture's horizontal distance to a swipe decision. Deliberately
 * pure and free of any gesture-library or React import: it is the one piece
 * of the swipe gesture that is actual business logic (which direction maps to
 * which decision), so it stays correct -- and trivially unit-testable -- even
 * if the animation implementation changes later.
 */
export const SWIPE_DECISION_THRESHOLD = 120;

export function resolveSwipeGesture(translationX: number): 'pass' | 'like' | null {
  if (translationX <= -SWIPE_DECISION_THRESHOLD) return 'pass';
  if (translationX >= SWIPE_DECISION_THRESHOLD) return 'like';
  return null;
}
