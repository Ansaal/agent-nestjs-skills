---
name: nestjs-setup
description: NestJS project setup for the current Nest major (ESM, SWC builder, Vitest with unplugin-swc, pnpm). Use when scaffolding a Nest project, adding or upgrading `@nestjs/*` packages, or fixing project config (tsconfig, nest-cli.json, vitest config, `.js` import errors, decorator-metadata or circular-import crashes, pnpm build approvals).
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Setup

How to stand up and maintain the toolchain of a NestJS project: version checks, Node pinning, the ESM project shape, the SWC builder, Vitest configs and pnpm build approvals. For a new project, apply the rules in table order. How to write the tests themselves lives in `nestjs-testing`; database wiring and migrations live in `nestjs-typeorm`.

Verified 2026-10-29 against NestJS 12.3.2, @nestjs/cli 12.0.11, TypeScript 6.0.3, @swc/core 1.16.20, Vitest 5.0.5 (Vite 8.3.5), unplugin-swc 2.0.0, pnpm 12.16.1, Node 24.22.2. When `npm view @nestjs/core version` reports a newer major, read `version-check-registry` first.

## Rules

| Prefix | Section | Impact |
|--------|---------|--------|
| `version-` | Version Policy | CRITICAL |
| `esm-` | ESM Project Shape | CRITICAL |
| `swc-` | SWC Builder | HIGH |
| `vitest-` | Vitest Configuration | HIGH |
| `pnpm-` | pnpm Build Approvals | MEDIUM-HIGH |

- `version-check-registry` - Ask the registry for current versions and engines before installing; one framework major; peers checked
- `version-pin-node` - Node 24 LTS (>=24.15) pinned in `.nvmrc`, `engines` and `engineStrict`
- `esm-project-config` - `"type": "module"`, nodenext tsconfig with decorator metadata, `tsconfig.build.json` rooted at `src`
- `esm-imports-and-paths` - `.js` suffixes, `import.meta.dirname`, top-level await in `main.ts`
- `esm-circular-type-refs` - `Relation<>` / `WrapperType<>` on circular type references so the built app boots
- `swc-builder-type-check` - SWC builder always paired with `"typeCheck": true`
- `vitest-swc-configs` - Unit and e2e configs with `unplugin-swc`, scripts, `import request from 'supertest'`
- `pnpm-allow-builds` - Approve `@swc/core`, `better-sqlite3`, `esbuild` builds via `allowBuilds`

Read `rules/<id>.md` for the rule's reasoning and examples.
