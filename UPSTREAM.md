# Upstream deviations

Fork of https://github.com/Kadajett/agent-nestjs-skills, based on commit `3986e0c` (v1.2.0).

## Syncing

Commit to `main`. Pull upstream with `git fetch upstream && git merge upstream/main`; never rebase. When a merge conflicts, check the entries below to decide which side wins.

## Changes

| Path | Change | Reason |
|------|--------|--------|
| `README.md` | Replaced intro, Semfora promo, install commands, docs-site section | Fork identity; promo and docs site belong to upstream |
| `metadata.json` | `version` → `2.0.0-ansaal`, added `forkedFrom` | Distinguish fork releases from upstream |
| `.github/workflows/deploy.yml` | Deleted | Deploys upstream's `docs` branch to Pages; fork has no docs site |
| `.github/workflows/branch-protection.yml` | Deleted | Only guarded the `docs` branch |
| `assets/semfora-logo.svg` | Deleted | Upstream promo asset |
| `AGENTS.md` | Compiled rule document moved to `compiled/nestjs-best-practices.md`; `AGENTS.md` is now a short authoring guide, `CLAUDE.md` symlinks to it | Agents working in this repo loaded 160 KB of rules as project instructions; installs never include the root file |
| `scripts/build-agents.ts`, `scripts/build.sh` | Output `compiled/<skill>.md` for every `skills/*/rules`; sections read from each `rules/_sections.md` instead of a hard-coded `CATEGORIES` list; abstract taken from each `SKILL.md` description; missing frontmatter or undeclared prefix fails the build | Repository now hosts several skills; the hard-coded list only knew one |
| `metadata.json` | Removed `abstract`, `organization` → `Ansaal/agent-nestjs-skills` | Abstract is per skill now (`SKILL.md` description) |
| `skills/nestjs-best-practices/rules/test-use-testing-module.md`, `test-e2e-supertest.md`, `test-mock-external-services.md` | Deleted; Testing section removed from `_sections.md` and `SKILL.md`, later sections renumbered 6–9 | Testing is owned by the `nestjs-testing` skill (Vitest, `useMocker()`); upstream rules were Jest-based |
| `skills/nestjs-best-practices/rules/di-interface-segregation.md`, `di-prefer-constructor-injection.md` | `jest.fn`/`jest.Mocked` → `vi.fn`/`Mocked` from `vitest` | Fork standardizes on Vitest |
| `skills/nestjs-best-practices/rules/db-use-migrations.md` | `synchronize: false` in every environment; data-source/CLI wiring replaced by a pointer to `nestjs-typeorm`; reference link updated | Upstream enabled `synchronize` in development and used migration glob strings, which fail in ESM projects |
| `skills/nestjs-best-practices/SKILL.md` | Added "Related Skills" section; rule/category counts updated | Routes topics to the fork's skills |
| `skills/nestjs-best-practices/SKILL.md` | "Full Compiled Document" link → this fork's `compiled/` file | Link pointed at upstream's root `AGENTS.md` |
| `LICENSE` | Added MIT license naming Jeremy Stover (Kadajett) and this fork | Upstream declares MIT only in `SKILL.md` frontmatter and has no license file |
