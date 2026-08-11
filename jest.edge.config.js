// Edge Function contract tests.
//
// These run against the local Supabase stack over real HTTP, so they need a
// plain Node environment: the jest-expo preset installs the React Native test
// environment and its setup files, which replace global fetch with a mock and
// leave the Supabase client parsing `undefined` as JSON.
//
// Only the preset's transform is reused, so the tests are still written in
// TypeScript. Everything else is stock Node.
const { transform, transformIgnorePatterns } = require('jest-expo/jest-preset');

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/edge/**/*.test.ts'],
  transform,
  transformIgnorePatterns,
};
