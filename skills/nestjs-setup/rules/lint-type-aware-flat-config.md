---
title: Lint Type-Aware with a Flat Config and Leave Formatting to Prettier
impact: HIGH
impactDescription: Catches un-awaited promises and unsafe types that tsc accepts, without lint and format fighting
tags: eslint, typescript-eslint, prettier, flat-config, projectService, no-floating-promises
---

## Lint Type-Aware with a Flat Config and Leave Formatting to Prettier

ESLint 10 reads only the flat `eslint.config.mjs`. The type-aware presets of typescript-eslint (`recommendedTypeChecked`) catch what `tsc` accepts, most of all promises nobody awaits: in the probe, `this.appService.audit();` inside a controller passed `pnpm typecheck` and `nest build`, and `pnpm lint` failed with `Promises must be awaited, end with a call to .catch, end with a call to .then with a rejection handler or be explicitly marked as ignored with the `void` operator  @typescript-eslint/no-floating-promises`. A rejected fire-and-forget promise becomes an unhandled rejection, which crashes Node 24. Mark the intentional ones with `void` and handle their errors inside the called method. `parserOptions.projectService` gives every linted file the type info of the `tsconfig.json` that covers it (`src`, `test`, `vitest.config.ts`); `allowDefaultProject` covers `eslint.config.mjs`, which no tsconfig includes. `eslint-config-prettier` goes last and switches off every stylistic rule, so Prettier alone formats. `eslint-plugin-prettier` would run Prettier inside ESLint and report formatting as lint errors; `prettier --check` does that job faster.

Install (versions from the registry, `version-check-registry`): `pnpm add -D eslint@^10.13.0 @eslint/js@^10.0.1 typescript-eslint@^8.72.1 eslint-config-prettier@^10.1.8 globals@^17.13.0 prettier@^3.9.10`. typescript-eslint 8.72.1 declares `typescript: ">=4.8.4 <6.1.0"`, which covers TypeScript 6.0.3. Keep `consistent-type-imports` only together with `projectService` (`lint-decorator-type-imports`).

**Incorrect (syntax-only preset, formatting through ESLint):**

```javascript
// eslint.config.mjs
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier/recommended';

export default tseslint.config(tseslint.configs.recommended, prettierPlugin);
// no type info: floating promises pass; every formatting diff is a lint error
```

**Correct (`eslint.config.mjs`):**

```javascript
// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/'] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Type info from the tsconfig that covers each file: src, test, vitest.config.ts.
        projectService: { allowDefaultProject: ['eslint.config.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Vitest globals (`globals: true`) exist only in specs and e2e suites, not in the build.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.vitest },
    // `expect(mock.method).toHaveBeenCalled…()` hands the method to a matcher that never calls it.
    rules: { '@typescript-eslint/unbound-method': 'off' },
  },
  // Last: switches off every rule that would fight Prettier.
  eslintConfigPrettier,
);
```

The test block is scoped to test files on purpose. `recommendedTypeChecked` reports `expect(sync.sync).toHaveBeenCalledWith('p-1')` on a `vi.mocked()` class mock as `@typescript-eslint/unbound-method`, which the matcher idiom of every unit spec in `nestjs-testing` triggers; production code keeps the rule. Vitest's globals are listed for test files only; for `.ts` files the type check is what rejects them outside tests (`esm-project-config`), because typescript-eslint switches `no-undef` off there.

**Correct (`.prettierrc`, `.prettierignore`, scripts):**

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 120
}
```

```text
dist
coverage
pnpm-lock.yaml
```

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

**Correct (intentional fire-and-forget):**

```typescript
@Get()
getHello(): string {
  void this.appService.audit(); // audit() catches and logs its own errors
  return this.appService.getHello();
}
```

On a fresh Nest 12 ESM project, after one `pnpm format`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm build` all passed. Run `lint` and `format:check` in CI next to `typecheck`.

Reference: [typescript-eslint – Linting with Type Information](https://typescript-eslint.io/getting-started/typed-linting), [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier)
