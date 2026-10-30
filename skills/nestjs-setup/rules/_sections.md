# Sections

## 1. Version Policy (version)

**Impact:** CRITICAL
**Description:** Versions and Node engines come from the registry at setup time, not from memory, so the project starts on the current Nest major with matching tooling.

## 2. ESM Project Shape (esm)

**Impact:** CRITICAL
**Description:** Nest 12 packages are ESM-only; package.json, tsconfig, import specifiers and type references follow Node's ESM rules so build, tests and boot agree.

## 3. SWC Builder (swc)

**Impact:** HIGH
**Description:** SWC compiles fast but checks no types, so the builder is always configured together with the CLI's type checker.

## 4. Vitest Configuration (vitest)

**Impact:** HIGH
**Description:** Vitest compiles tests with SWC through unplugin-swc so decorator metadata matches the production build regardless of Vite's own transformer.

## 5. Lint and Format (lint)

**Impact:** HIGH
**Description:** ESLint lints with type information and Prettier alone formats, so un-awaited promises fail CI and no autofix strips the imports Nest DI reads at runtime.

## 6. pnpm Build Approvals (pnpm)

**Impact:** MEDIUM-HIGH
**Description:** pnpm 12 runs no dependency install scripts until they are approved, which leaves native and binary packages unbuilt.
