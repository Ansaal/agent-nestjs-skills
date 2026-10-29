---
title: Pair the SWC Builder with typeCheck
impact: HIGH
impactDescription: Prevents type errors from shipping in builds that report success
tags: swc, nest-cli, build, type-check
---

## Pair the SWC Builder with typeCheck

SWC strips types without checking them. With `"builder": "swc"` alone, `nest build` printed `Successfully compiled: 5 files with swc` and exited 0 for a source file containing `TS2322: Type 'string' is not assignable to type 'number'`. `"typeCheck": true` runs `tsc` in no-emit mode next to SWC (and runs CLI plugins such as Swagger's): the same build fails with `Found 1 type error(s) during compilation.` and exit code 1. The SWC builder emits ES modules because `package.json` has `"type": "module"`, so no `.swcrc` is needed. Install the builder with `pnpm add -D @swc/cli @swc/core`, then approve `@swc/core`'s install script (`pnpm-allow-builds`).

**Incorrect (fast build, no type check):**

```json
{
  "compilerOptions": {
    "builder": "swc"
  }
}
```

**Correct (`nest-cli.json`):**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "builder": "swc",
    "typeCheck": true,
    "deleteOutDir": true
  }
}
```

In `nest start --watch` the check runs asynchronously: the app still starts, and errors appear afterwards as `src/app.service.ts:10:14 - error TS2322 …` followed by `TSC  Found 1 error. Watching for file changes.`, so read the TSC lines after each rebuild. The check covers `tsconfig.build.json`, i.e. `src` without specs; specs are covered by `pnpm typecheck` (`esm-project-config`).

Reference: [NestJS SWC recipe](https://docs.nestjs.com/recipes/swc)
