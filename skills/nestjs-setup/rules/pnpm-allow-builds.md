---
title: Approve Native Builds with allowBuilds
impact: MEDIUM-HIGH
impactDescription: Prevents failed installs and missing native bindings for @swc/core and better-sqlite3
tags: pnpm, install-scripts, swc, better-sqlite3, esbuild
---

## Approve Native Builds with allowBuilds

pnpm 12 runs no dependency install scripts until each package is approved. Adding `@swc/core` or `better-sqlite3` fails with `ERR_PNPM_IGNORED_BUILDS … Ignored build scripts: @swc/core@1.16.20, better-sqlite3@12.11.1` and exit code 1, and an unbuilt `better-sqlite3` later throws `Error: Could not locate the bindings file.` The approvals live under `allowBuilds` in `pnpm-workspace.yaml`; the older `onlyBuiltDependencies` list is ignored by pnpm 12 (the install still fails with `ERR_PNPM_IGNORED_BUILDS`). Approve exactly the packages pnpm names: `@swc/core` (SWC builder, unplugin-swc), `better-sqlite3` (`nestjs-typeorm`), and `esbuild` once something pulls it in (`tsx`, Vite 6/7; a Vite 8 tree has none). Commit `pnpm-workspace.yaml` so every checkout and CI run builds the same packages.

**Incorrect (pnpm 9/10 key, ignored by pnpm 12):**

```yaml
onlyBuiltDependencies:
  - '@swc/core'
  - better-sqlite3
```

**Correct (approve by name after the failed install):**

```bash
pnpm approve-builds @swc/core better-sqlite3   # runs the scripts and writes allowBuilds
```

**Correct (or declare before installing, `pnpm-workspace.yaml`):**

```yaml
allowBuilds:
  '@swc/core': true
  better-sqlite3: true
```

Running `pnpm approve-builds` without arguments opens an interactive picker; pass the package names in non-interactive shells.

Reference: [pnpm approve-builds](https://pnpm.io/cli/approve-builds)
