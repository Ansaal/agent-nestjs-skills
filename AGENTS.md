# Authoring this skill repository

This repository is the source of installable agent skills. `npx skills add Ansaal/agent-nestjs-skills` copies only `skills/<name>/` into a project, so everything an installed agent needs lives inside that folder; files outside it serve maintainers.

## Rules

- One rule per file in `skills/<name>/rules/`, following `skills/nestjs-best-practices/rules/_template.md`: frontmatter, why it matters, incorrect example, correct example, reference link.
- The filename prefix assigns the section. Sections are declared in that skill's `rules/_sections.md` as `## <n>. <Name> (<prefix>)` followed by `**Impact:** <level>`; the build reads them from there.
- `SKILL.md`'s quick reference lists every rule ID; add or remove the line together with the rule file.
- Each topic has one owning skill (see the table in `README.md`). Other skills point to the owner by name instead of restating it.
- Every "Correct" code example is proven in a throwaway project (type check plus the relevant build, test, or CLI run) before it is committed.

## After every change

1. Rebuild: `cd scripts && npm run build`. It writes `compiled/<skill>.md` for every skill with a `rules/` folder and fails on a rule without frontmatter or with an undeclared prefix. Commit the compiled files in the same commit as the rule change.
2. If the change touches a file that came from upstream (Kadajett/agent-nestjs-skills), add a row to `UPSTREAM.md` stating the path, the change, and the reason. That table is what resolves conflicts when merging `upstream/main`.
