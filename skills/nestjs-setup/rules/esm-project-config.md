---
title: Configure the Project as ESM with Decorator Metadata
impact: CRITICAL
impactDescription: Aligns package type, compiler and output layout with Nest 12's ESM-only packages
tags: esm, tsconfig, package-json, nodenext, decorators
---

## Configure the Project as ESM with Decorator Metadata

Nest 12 packages are ESM-only and `nest new` scaffolds ESM projects (the prompt offers CommonJS; non-interactive runs default to ESM). `"type": "module"` makes Node, the SWC builder and Vitest all treat the output as ES modules. `nodenext` applies Node's real resolution rules at compile time, `experimentalDecorators` + `emitDecoratorMetadata` produce the `design:paramtypes` / `design:type` metadata that Nest DI and TypeORM read, `isolatedModules` makes `tsc` reject what per-file compilers like SWC cannot compile, and `types: ["vitest/globals", "node"]` matches `globals: true` in the Vitest config (`vitest-swc-configs`). `tsconfig.build.json` limits the build to `src` without specs; without it, `nest build` compiled `app.controller.spec.js` into `dist` and failed on type errors in `test/`.

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
    "test:e2e": "vitest run --config ./vitest.config.e2e.ts"
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
  }
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

`tsconfig.json` covers `src`, `test` and the Vitest configs, so `pnpm typecheck` is the only step that type-checks spec files: `nest build` reads `tsconfig.build.json`, which excludes them, and Vitest checks no types. Run it next to `pnpm test` in CI.

Reference: [NestJS migration guide – ESM](https://docs.nestjs.com/migration-guide)
