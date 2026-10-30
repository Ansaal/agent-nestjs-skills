---
title: Pin Node 24 LTS and pnpm
impact: CRITICAL
impactDescription: Keeps nest generators, Vitest, the runtime and the package manager on versions all of them support
tags: node, nvm, engines, pnpm, packageManager, corepack, lts
---

## Pin Node 24 LTS and pnpm

A Nest 12 project has three Node floors: the runtime needs 20.19+ or 22.12+, Vitest 5 needs `^22.12.0 || ^24.0.0 || >=26.0.0`, and `nest new` / `nest generate` / `nest upgrade` (via `@nestjs/schematics`) need `^22.22.3 || ^24.15.0 || >=26.0.0`. Node 24 at 24.15 or later satisfies all three. Nothing stops a wrong Node by default: pnpm 12 installs `@nestjs/schematics` on Node 22.21 without a warning and ignores the project's own `engines` field. With `engineStrict: true`, a wrong Node fails the install: `ERR_PNPM_UNSUPPORTED_ENGINE … wanted: {"node":"^24.15.0"} (current: {"node":"24.14.0"})`. Run `node -v` before any install or `nest` command; on a mismatch, switch with `nvm use` / `nvm install`.

pnpm is pinned the same way, because its major decides the lockfile format, the install-script approvals (`pnpm-allow-builds`) and peer resolution. `"packageManager": "pnpm@12.16.1"` names the exact version, and pnpm 11 or later switches to it by itself: in the probe a global pnpm 12.16.1 printed `12.15.0` for `pnpm -v` in a project pinned to 12.15.0, and `npx pnpm@11.0.0 -v` printed `12.16.1` in one pinned to 12.16.1. Older globals do not: pnpm 10.20.0 failed with `Failed to switch pnpm to v12.16.1`, and pnpm 9.15.9 ignored the field and ran itself. On such a machine, activate the pinned version with Corepack (bundled with Node 24, version 0.36.0): after `corepack enable pnpm`, the `pnpm` shim printed `Downloading the pnpm 12.16.1 binary for darwin-arm64...` and then `12.16.1`. Without Corepack, `npm install -g pnpm@12.16.1`.

**Incorrect (whatever Node is active, nothing pinned):**

```json
{
  "name": "app",
  "private": true,
  "type": "module"
}
```

**Correct (exact Node in `.nvmrc`, range in `engines`, exact pnpm in `packageManager`, enforced by pnpm):**

```bash
node -v                       # must satisfy ^24.15.0
nvm version-remote 24         # newest 24.x, v24.22.2 on 2026-10-29
echo 24.22.2 > .nvmrc
nvm install                   # installs and activates the .nvmrc version
npm view pnpm version         # 12.16.1 on 2026-10-29
corepack enable pnpm          # or: npm install -g pnpm@12.16.1
pnpm -v                       # 12.16.1, the packageManager version
```

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.16.1",
  "engines": {
    "node": "^24.15.0"
  }
}
```

```yaml
# pnpm-workspace.yaml
engineStrict: true
```

`.nvmrc` holds an exact version because a major-only `24` resolves to the newest *installed* 24.x, which can be below 24.15. `engineStrict` also applies to dependencies' `engines`, which every package in this stack satisfies on Node 24.15+. To move to a newer pnpm, check `npm view pnpm version` (`version-check-registry`), edit `packageManager` and run `pnpm install` so the lockfile is rewritten by that version.

Reference: [NestJS migration guide – Node.js requirements](https://docs.nestjs.com/migration-guide), [Corepack](https://github.com/nodejs/corepack)
