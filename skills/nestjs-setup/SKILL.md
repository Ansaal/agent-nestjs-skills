---
name: nestjs-setup
description: NestJS project setup for the current Nest major (ESM, SWC builder, Vitest with unplugin-swc, ESLint + Prettier, pnpm). Use when scaffolding a Nest project, adding or upgrading `@nestjs/*` packages, pinning Node or pnpm, setting up or fixing ESLint flat config, type-aware linting or Prettier formatting, or fixing project config (tsconfig, nest-cli.json, vitest config, `main.ts` bootstrap shape, `.js` import errors, decorator-metadata or circular-import crashes, pnpm build approvals).
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Setup

How to stand up and maintain the toolchain of a NestJS project: version checks, Node pinning, the ESM project shape, the SWC builder, the Vitest config, ESLint + Prettier and pnpm build approvals. For a new project, apply the rules in table order. How to write the tests themselves lives in `nestjs-testing`; database wiring and migrations live in `nestjs-typeorm`; logger setup lives in `nestjs-logging`.

Verified 2026-10-29 against NestJS 12.3.2, @nestjs/cli 12.0.11, TypeScript 6.0.3, @swc/core 1.16.20, Vitest 5.0.5 (Vite 8.3.5), unplugin-swc 2.0.0, ESLint 10.13.0 (@eslint/js 10.0.1), typescript-eslint 8.72.1, Prettier 3.9.10, eslint-config-prettier 10.1.8, globals 17.13.0, pnpm 12.16.1, Node 24.22.2. When `npm view @nestjs/core version` reports a newer major, read `version-check-registry` first.

## Rules

| Prefix | Section | Impact |
|--------|---------|--------|
| `version-` | Version Policy | CRITICAL |
| `esm-` | ESM Project Shape | CRITICAL |
| `swc-` | SWC Builder | HIGH |
| `vitest-` | Vitest Configuration | HIGH |
| `lint-` | Lint and Format | HIGH |
| `pnpm-` | pnpm Build Approvals | MEDIUM-HIGH |

- `version-check-registry` - Ask the registry for current versions and engines before installing; one framework major; peers checked
- `version-pin-node` - Node 24 LTS (>=24.15) pinned in `.nvmrc`, `engines` and `engineStrict`; pnpm pinned in `packageManager`
- `esm-project-config` - `"type": "module"`, nodenext tsconfig with decorator metadata, `tsconfig.build.json` rooted at `src` with `types: ["node"]` so Vitest globals stay out of the build
- `esm-imports-and-paths` - `.js` suffixes, `import.meta.dirname`, top-level await in `main.ts` composed with `configureApp()`
- `esm-circular-type-refs` - `Relation<>` / `WrapperType<>` on circular type references so the built app boots
- `swc-builder-type-check` - SWC builder always paired with `"typeCheck": true`
- `vitest-swc-configs` - One `vitest.config.ts` with `unplugin-swc` for `src/**/*.spec.ts` and `test/**/*.e2e-spec.ts`, one `test.env` that every installed skill adds keys to, `import request from 'supertest'`
- `lint-type-aware-flat-config` - `eslint.config.mjs` with `recommendedTypeChecked` + `projectService`, Vitest globals only for test files, `eslint-config-prettier` last, `.prettierrc`, `lint`/`format` scripts, `void` for intentional fire-and-forget
- `lint-decorator-type-imports` - `consistent-type-imports` only with type information, or its autofix turns injected classes into `import type` and DI fails at boot
- `pnpm-allow-builds` - Approve `@swc/core`, `better-sqlite3`, `esbuild` builds via `allowBuilds`

Read `rules/<id>.md` for the rule's reasoning and examples.
