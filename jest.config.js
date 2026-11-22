// @ts-check

/** @type {import('ts-jest').JestConfigWithTsJest} */
const config = {
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "js"],
  transform: {
    // The generated @buf packages ship ES modules only, which Jest cannot
    // load untransformed.
    "^.+\\.ts$|/node_modules/@buf/.+\\.js$": [
      "ts-jest",
      { tsconfig: "tsconfig.jest.json" },
    ],
  },
  transformIgnorePatterns: ["/node_modules/(?!@buf/)"],
  testMatch: ["**/__tests__/**/*.test.ts"],
};

export default config;
