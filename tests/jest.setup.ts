(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// react-native-gesture-handler's own recommended Jest setup: mocks the native
// module so components using GestureHandlerRootView / GestureDetector (added
// for SwipeDeck's swipe gestures) can render under RNTL without a device.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('react-native-gesture-handler/jestSetup');

// react-native-reanimated's own documented Jest mock: the real package needs
// react-native-worklets' native module, which isn't available under Jest.
jest.mock('react-native-reanimated', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-reanimated/mock')
);
