import { resolveSwipeGesture, SWIPE_DECISION_THRESHOLD } from '@/lib/swipe-gesture';

describe('resolveSwipeGesture', () => {
  test('a left drag past the threshold resolves to pass', () => {
    expect(resolveSwipeGesture(-SWIPE_DECISION_THRESHOLD)).toBe('pass');
    expect(resolveSwipeGesture(-SWIPE_DECISION_THRESHOLD - 40)).toBe('pass');
  });

  test('a right drag past the threshold resolves to like', () => {
    expect(resolveSwipeGesture(SWIPE_DECISION_THRESHOLD)).toBe('like');
    expect(resolveSwipeGesture(SWIPE_DECISION_THRESHOLD + 40)).toBe('like');
  });

  test('a drag that never reaches the threshold resolves to no decision', () => {
    expect(resolveSwipeGesture(0)).toBeNull();
    expect(resolveSwipeGesture(SWIPE_DECISION_THRESHOLD - 1)).toBeNull();
    expect(resolveSwipeGesture(-(SWIPE_DECISION_THRESHOLD - 1))).toBeNull();
  });
});
