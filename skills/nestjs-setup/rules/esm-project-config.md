---
title: Configure the Project as ESM with Decorator Metadata
impact: CRITICAL
impactDescription: Aligns package type, compiler and output layout with Nest 12's ESM-only packages
tags: esm, tsconfig, package-json, nodenext, decorators
---

## Configure the Project as ESM with Decorator Metadata

Nest 12 packages are ESM-only and `nest new` scaffolds ESM projects (the prompt offers CommonJS; non-interactive runs default to ESM). `"type": "module"` makes Node, the SWC builder and Vitest all treat the output as ES modules. `nodenext` applies Node's real resolution rules at compile time, `experimentalDecorators` + `emitDecoratorMetadata` produce the `design:paramtypes` / `design:type` metadata that Nest DI and TypeORM read, and `isolatedModules` makes `tsc` reject what per-file compilers like SWC cannot compile. `tsconfig.build.json` limits the build to `src` without specs; without it, `nest build` compiled `app.controller.spec.js` into `dist` and failed on type errors in `test/`. `packageManager` pins pnpm (`version-pin-node`).

`types: ["vitest/globals", "node"]` in `tsconfig.json` matches `globals: true` in the Vitest config (`vitest-swc-configs`), so specs use `describe`/`it`/`vi` without imports. `tsconfig.build.json` overrides it with `types: ["node"]`: a stray `describe(...)` in a non-spec file under `src` then fails `nest build` with `error TS2593: Cannot find name 'describe'. Do you need to install type definitions for a test runner?` and `Found 1 type error(s) during compilation.`. With the inherited list the same file built (`Found 0 issues.`) into `dist`. ESLint does not catch it either: typescript-eslint turns `no-undef` off for `.ts` files, and `pnpm lint` passed on that file.

**Incorrect (CommonJS-era config):**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "experimentalDecorators": true,
    "outDir": "./dist",
    "types": ["node", "jest"]
  }
}
```

**Correct (`package.json`, `tsconfig.json`, `tsconfig.build.json`):**

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.16.1",
  "engines": {
    "node": "^24.15.0"
  },
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "types": ["vitest/globals", "node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

`tsconfig.json` covers `src`, `test` and `vitest.config.ts`, so `pnpm typecheck` is the only step that type-checks spec files: `nest build` reads `tsconfig.build.json`, which excludes them, and Vitest checks no types. Run it next to `pnpm test` in CI. `pnpm test` runs unit and e2e specs from one config (`vitest-swc-configs`); `lint` and `format:check` are configured in `lint-type-aware-flat-config`.

Reference: [NestJS migration guide – ESM](https://docs.nestjs.com/migration-guide)
