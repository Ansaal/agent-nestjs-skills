---
title: Pin Node 24 LTS in .nvmrc and engines
impact: CRITICAL
impactDescription: Keeps nest generators, Vitest and the runtime on a Node version all of them support
tags: node, nvm, engines, pnpm, lts
---

## Pin Node 24 LTS in .nvmrc and engines

A Nest 12 project has three Node floors: the runtime needs 20.19+ or 22.12+, Vitest 5 needs `^22.12.0 || ^24.0.0 || >=26.0.0`, and `nest new` / `nest generate` / `nest upgrade` (via `@nestjs/schematics`) need `^22.22.3 || ^24.15.0 || >=26.0.0`. Node 24 at 24.15 or later satisfies all three. Nothing stops a wrong Node by default: pnpm 12 installs `@nestjs/schematics` on Node 22.21 without a warning and ignores the project's own `engines` field. With `engineStrict: true`, a wrong Node fails the install: `ERR_PNPM_UNSUPPORTED_ENGINE … wanted: {"node":"^24.15.0"} (current: {"node":"24.14.0"})`. Run `node -v` before any install or `nest` command; on a mismatch, switch with `nvm use` / `nvm install`.

**Incorrect (whatever Node is active, nothing pinned):**

```json
{
  "name": "app",
  "private": true,
  "type": "module"
}
```

**Correct (exact version in `.nvmrc`, range in `engines`, enforced by pnpm):**

```bash
node -v                       # must satisfy ^24.15.0
nvm version-remote 24         # newest 24.x, v24.22.2 on 2026-10-29
echo 24.22.2 > .nvmrc
nvm install                   # installs and activates the .nvmrc version
```

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^24.15.0"
  }
}
```

```yaml
# pnpm-workspace.yaml
engineStrict: true
```

`.nvmrc` holds an exact version because a major-only `24` resolves to the newest *installed* 24.x, which can be below 24.15. `engineStrict` also applies to dependencies' `engines`, which every package in this stack satisfies on Node 24.15+.

Reference: [NestJS migration guide – Node.js requirements](https://docs.nestjs.com/migration-guide)
