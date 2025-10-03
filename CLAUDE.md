# Claude Code Assistant Guidelines

This document contains important information for Claude when working on this codebase.

## Pre-commit Checks

**CRITICAL - MUST RUN BEFORE EVERY COMMIT**: The CI will fail if you don't run these commands before committing:

```bash
# 1. Run the linter (REQUIRED - CI will fail if there are lint errors)
npm run lint

# 2. Build the project (REQUIRED - CI will fail if dist/ files are out of date)
npm run build

# 3. Stage the dist files if they changed
git add dist/
```

**Why this matters**: The CI checks that:

1. Code passes all lint rules
2. The dist/ folder is up-to-date with the source code (no uncommitted build changes)

## Available Scripts

- `npm run lint` - Runs ESLint to check code style and potential issues
- `npm run build` - Builds the TypeScript code and creates distribution files
- `npm test` - Runs the test suite (currently empty)

## Code Style Guidelines

1. **Array Types**: Use `T[]` syntax instead of `Array<T>` (enforced by ESLint)
2. **TypeScript**: All source code should be in TypeScript
3. **Build Output**: Always rebuild (`npm run build`) after making changes to ensure dist/ files are updated

## Project Structure

- `src/` - Source TypeScript files
  - `main.ts` - Main action entry point
  - `post.ts` - Post-action cleanup
  - `step-checker.ts` - Checks for failed workflow steps
  - `utils.ts` - Utility functions
- `dist/` - Compiled JavaScript output (auto-generated, should be committed)
- `action.yml` - GitHub Action configuration

## Important Notes

1. This is a GitHub Action that manages sticky disks for caching in CI/CD workflows
2. The action has both a main phase (mounting) and a post phase (unmounting and committing)
3. Always ensure the dist/ folder is updated when source files change
4. The action integrates with Blacksmith's sticky disk service
