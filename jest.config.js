// @ts-check

/** @type {import('ts-jest').JestConfigWithTsJest} */
const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "js"],
  transform: {
    // The @buf packages ship ES modules only; ts-jest compiles them to
    // CommonJS alongside our sources.
    "^.+\\.[tj]s$": ["ts-jest", { tsconfig: { allowJs: true } }],
  },
  transformIgnorePatterns: ["/node_modules/(?!@buf/)"],
  testMatch: ["**/__tests__/**/*.test.ts"],
};

export default config;
