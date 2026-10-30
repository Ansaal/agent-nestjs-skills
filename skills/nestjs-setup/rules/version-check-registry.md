---
title: Check the Registry Before Installing Nest Packages
impact: CRITICAL
impactDescription: Prevents starting on a stale major with outdated APIs, CommonJS and Jest-era tooling
tags: versions, npm, pnpm, upgrade, nest-cli, peer-dependencies
---

## Check the Registry Before Installing Nest Packages

Versions recalled from memory lag the registry: a setup written from memory lands on an older Nest major with CommonJS, Jest and `ts-jest`, while Nest 12 ships ESM-only packages and scaffolds ESM + Vitest. Ask the registry first, then install with an explicit major. The framework packages (`@nestjs/common`, `core`, `platform-*`, `testing`, `cli`, `schematics`) share one major; integration packages (`@nestjs/typeorm` 12.0.2, `@nestjs/config` 12.0.1, `@nestjs/resilience` 0.0.3) have their own numbering, so pick the release whose `peerDependencies` include that major. A mismatch still installs: pnpm prints only `Issues with peer dependencies found` and exits 0, so `pnpm peers check` is the gate.

**Incorrect (versions from memory, mixed majors):**

```bash
pnpm add @nestjs/core @nestjs/common @nestjs/typeorm@11   # @nestjs/typeorm 11 peers on ^10 || ^11
pnpm add -D jest ts-jest @types/jest typescript           # typescript@latest is 7, the Nest 12 CLI checks with 6
```

**Correct (registry first, explicit major, peers checked):**

```bash
node -v                                              # see version-pin-node
npm view pnpm version                                # 12.16.1; pinned in packageManager (version-pin-node)
npm view @nestjs/core version                        # 12.3.2 on 2026-10-29
npm view @nestjs/cli engines dependencies.typescript
npm view @nestjs/schematics engines peerDependencies
npm view @nestjs/typeorm peerDependencies            # repeat for every integration package you add

pnpm add @nestjs/common@^12 @nestjs/core@^12 @nestjs/platform-express@^12 reflect-metadata rxjs
pnpm add -D @nestjs/cli@^12 @nestjs/schematics@^12 @nestjs/testing@^12 typescript@^6 @types/node@^24 @types/express
pnpm peers check                                     # done when it prints "No peer dependency issues found"
```

Snapshot, verified 2026-10-29:

| Package | Version | Constraint that matters |
|---------|---------|-------------------------|
| `@nestjs/common`, `core`, `platform-express`, `testing` | 12.3.2 | ESM-only: `"type": "module"`, no `require` export condition |
| `@nestjs/cli` | 12.0.11 | depends on `typescript ~6.0.2`, which runs the `nest build` type check |
| `@nestjs/schematics` | 12.0.12 | engines `^22.22.3 \|\| ^24.15.0 \|\| >=26.0.0`; peer `typescript >=6.0.0` |
| `typescript` | 6.0.3 | `latest` is 7.0.2; install `^6` so `tsc` matches the CLI's checker |
| `vitest` | 5.0.5 | engines `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| `@swc/core`, `@swc/cli`, `unplugin-swc` | 1.16.20, 0.8.2, 2.0.0 | |
| `pnpm` | 12.16.1 | exact version in `packageManager`; bump it on purpose, with the reinstalled lockfile in the same change |

When `npm view @nestjs/core version` reports a major above 12, read the migration guide first; treat this snapshot and every rule in this skill as possibly stale until the guide confirms them.

`nest new` templates lag the registry: `@nestjs/cli` 12.0.11 writes `vitest ^4.1.2` and `@nestjs/* ^12.0.1`. After scaffolding, compare `package.json` with `npm view` and bump.

Reference: [NestJS migration guide](https://docs.nestjs.com/migration-guide)
