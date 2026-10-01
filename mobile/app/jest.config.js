const expoPreset = require('jest-expo/jest-preset');

// Packages that ship untranspiled ESM/JSX, on top of the ones jest-expo lists.
const TRANSPILE_TOO = [
  'nativewind',
  'react-native-css-interop',
  'react-native-heroicons',
  '@gorhom',
  '@shopify/flash-list',
];

const [expoNodeModulesPattern, ...expoOtherPatterns] = expoPreset.transformIgnorePatterns;

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // The first renderRouter call compiles every route (~5s on a cold cache).
  testTimeout: 30_000,
  transformIgnorePatterns: [
    expoNodeModulesPattern.replace('(?!(', `(?!(${TRANSPILE_TOO.join('|')}|`),
    ...expoOtherPatterns,
  ],
  moduleNameMapper: {
    '\\.css$': '<rootDir>/src/__mocks__/style.js',
    // tsconfig.json `paths`: the engine's dependency-free wire modules.
    '^@engine/(.*)$': '<rootDir>/../engine/src/$1',
  },
};
