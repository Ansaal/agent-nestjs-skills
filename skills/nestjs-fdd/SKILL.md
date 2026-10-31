---
name: nestjs-fdd
description: Feature-Driven Development (FDD) planning for NestJS, turning a spec into a domain model, a feature list, feature modules with an acyclic import graph, and a PLAN.md built one test-proven feature at a time. Use when planning, designing, or structuring a NestJS app or a new feature from a spec, or when continuing a build from an existing PLAN.md.
license: MIT
metadata:
  author: Ansaal
  version: "1.1.0"
---

# NestJS Feature-Driven Development

Coad/De Luca FDD applied to NestJS: five ordered steps from spec to working code, recorded in a terse `PLAN.md` at the repository root. A *feature* is a client-valued function small enough for one test block to prove; a *feature set* is one Nest feature module. Verified 2026-10-29 against NestJS 12.3.2 and Vitest 5.0.5 on Node 24.22.2 (test-name filtering and the red-phase scaffold in step 5).

Copy [`references/plan-template.md`](references/plan-template.md) to `PLAN.md` before step 1 and fill one section per step. When `PLAN.md` already exists, run steps 1–4 for the delta only (new requirements, objects, features), append to the existing sections, then continue step 5 at the first unticked enabler or feature.

Running example (a library lending API): members borrow copies of books; a member holds at most 5 active loans; a loan lasts 21 days; overdue members get an email.

## Plan conventions

- **Terse.** `PLAN.md` is a working index, not a report. One line per requirement, decision, domain object, invariant and enabler; a feature takes its heading plus one line per field and one per test case. Write lists; keep tables out, since a cell holding a sentence formats into an unreadable row. An app of about eight features fits in roughly 150 lines; a longer plan is restating what the code, the skills or another line already say.
- **Ids stay in the plan.** R-, D-, I-, E- and F-ids cross-reference lines inside `PLAN.md` only. Code, comments, test titles and scaffold messages name the behaviour in plain words; the plan links a test case to what it proves after its title (`` `it('refuses a sixth loan')` — I2 ``).
- **Decisions and risks.** Record a choice the user made, or one between options a reviewer would reasonably question, as `D1 <decision> — <why>`, adding `instead of <option>` when the rejected option is the obvious one. A default taken straight from another skill's rule is that rule's, not a decision. Cite a D-id inline where an enabler or feature depends on it. A limit the design accepts whatever is decided goes under § Risks as `<risk> — <accepted, or how it is mitigated>`. Both are recorded in whatever step they surface (`D1 Send reminders once a day at 08:00 Europe/Berlin — one mail per member per day, instead of mailing when each loan falls due`).

## 1. Develop an overall model

Read the whole spec, then fill `PLAN.md` § Model:

- **Requirements**: every behaviour the spec states, quoted verbatim, as `R1 "<clause>"`; split a sentence that states several behaviours into one R-line per clause. Step 2 appends `→ F<n>, …` or `→ out of scope`.
- **Domain objects**: every noun the system stores or computes, as `<Object> (entity | value | external): <key attributes>; <relationships with cardinality>`. Step 2 appends `→ <Feature set>`.
- **External systems**: every system the app calls or is called by, as `<System>: <used for>; fails by <timeout / 5xx / …>; client <Name>Client in <Module>`. Omit the heading when there are none.
- **Invariants**: every "must", "never", "at most", "unique", "only if", as `I1 <rule> (R<n>) — owner <Object>`, where the owner is the entity whose state the rule constrains (`I2 a member holds at most 5 active loans (R2) — owner Loan`).
- **Out of scope**: `<item> — <reason>`.

**Done when** every R-id is referenced by a domain object, an invariant or an out-of-scope line, every invariant names exactly one owner, and every question the spec leaves open has a D-line.

## 2. Build a feature list

Group the work into feature sets (one per business activity: Membership, Catalog, Lending, Reminders), each under its own heading, and list features beneath it. Name every feature `<action> the <result> <by|for|of|to> a(n) <object>`:

- `Lend a copy to a member`
- `Calculate the due date for a loan`
- `List the overdue loans of a member`
- `Send the overdue reminder to a member`

A feature is client-valued: a spec reader recognises it as something the system does for them. Persistence, entities, DTOs and wiring are design detail inside features (step 4), never features of their own. A candidate whose proof needs writes in two feature sets is two features.

Each feature set becomes one Nest feature module (`Lending` → `LendingModule`) that owns the entities of its domain objects; layout per `nestjs-best-practices` rule `arch-feature-modules`. Its heading names the module, the entities it owns and the services it exports: `### Lending — LendingModule (owns Loan; exports LoanService)`. Each invariant belongs to the feature set owning its owner object (`I2` constrains `Loan`, so Lending enforces it and Membership stays unaware of loans).

Work that features need but no client values (database and migration setup, a lock store, packages and configuration, shared authentication) goes in § Enablers, one line each: `E1 <purpose> — check: \`<command>\` → <result>`, plus its D-ids. Enablers never enter the feature list.

**Done when** every R-line ends in `→` features or out of scope, every domain object ends in `→` a feature set, every feature name matches the grammar, every invariant is enforced by a feature of its owner's feature set, and every enabler has a check.

## 3. Plan by feature

Draw the module import graph in § Modules (mermaid, arrow = "imports"), one edge per cross-module call a feature needs. The graph is a DAG: modules wire with plain `imports`, and a needed `forwardRef` signals a modelling error. Resolve a cycle in the model: move the feature to the module owning the data it reads, extract the shared concept into a new module both import, or decouple with events (`nestjs-best-practices` rule `arch-avoid-circular-deps`). Then return to step 2 for the moved features.

A module exports its services only: repositories and `TypeOrmModule.forFeature` stay inside the owning module, and other modules read and write that data through the exported service. Each external system gets one client provider, inside the module whose features call it (its own module when several feature sets call it); HTTP transport per `nestjs-http-client`, resilience wrapping per `nestjs-resilience`.

Put the plan in build order; the order of the lists is the build order. Feature sets follow the graph (imported before importer); within a set every feature follows the features it calls or whose data it needs; each enabler sits in § Enablers before the first feature that needs it, and that feature lists the enabler's id on its `Needs` line.

**Done when** the graph is acyclic, every module heading exports services only, and no feature or enabler appears before something it depends on.

## 4. Design by feature

Give every feature these lines; a line that would say `none` is left out:

- **Interface**: for a feature reachable over HTTP, the route, method, DTO, and success and error status codes; in every case, the service method signature.
- **Data**: the tables it reads and writes, plus `migration` when it adds or changes a column or table (mechanics per `nestjs-typeorm`).
- **Calls**: the exported service methods of other modules it calls; each one matches a graph edge. A call without an edge means updating the graph and re-running the step 3 acyclicity check.
- **Operations**: its trigger and schedule (`nestjs-schedule`), what happens when a run overlaps the last one or runs on every instance, the lock and fencing it needs (`nestjs-locks`), its retry and idempotency behaviour (`nestjs-resilience`), and the log lines an operator needs (`nestjs-logging`). Assess every feature, request/response ones included: a route that calls an external system still needs its retry, idempotency and log lines. `Send the overdue reminder to a member` is a daily cron that must not mail a member twice when two instances run it.
- **Needs**: the enablers it depends on, by id.
- **Test**: the test that proves the feature: e2e when it is reachable over HTTP, unit when it is domain logic without a route (`Calculate the due date for a loan`). Give the file and `describe('<feature name verbatim>')`, then one line per `it` case: one for the main outcome, one per invariant the feature enforces (ending `— I<n>`), and one per error status in Interface. Each case asserts something only the feature produces: an error case checks the feature's error body too, because a status alone (404) is also what a missing route returns.

This test is the feature's completion criterion: the feature is done exactly when every listed case passes.

**Done when** every feature has its Interface, Data and Test lines and every other line that applies, every invariant appears in at least one `it` case, and every Calls entry matches a graph edge.

## 5. Build by feature

Build one enabler or feature at a time, in plan order. An enabler is done when its check passes; tick it `[x]`. For each feature:

1. Write the test file entries exactly as listed in PLAN.md (file locations, `Test.createTestingModule`, `useMocker`, supertest per `nestjs-testing`).
2. Scaffold the feature's signatures (route, DTO, service method) with bodies that throw an error naming the feature, e.g. `throw new NotImplementedException('List the overdue loans of a member')`. Signatures only: validation decorators, guards and other behaviour arrive with the implementation, or the cases that test them pass while red.
3. Run `npx vitest run -t '<Feature name>'` and see it **red**: every listed `it` fails on its own, each for the behaviour it is meant to prove (`expected 501 to be 404` is the scaffold answering, not a wrong expectation). A case that passes while red proves nothing (an expected 404 also passes before the route exists); rewrite it to assert something only the feature produces, such as the feature's error message or the row it writes. A run reporting only skipped tests exits 0 and means the `describe` title differs from PLAN.md; fix the title.
4. Implement in the owning module, replacing the scaffold (plus its migration when Data says `migration`).
5. Re-run until **green**: `Tests  N passed`, where N is the number of `it` cases listed for the feature.
6. Run the full suite; on green, tick the feature `[x]` in PLAN.md.

Work the build reveals (a missing feature, enabler, invariant, call, test case or decision) goes into PLAN.md through steps 2–4 before any code for it is written.

**Done when** every enabler and feature in PLAN.md is ticked with its lines filled, every decision made in any step has its D-line, the full test suite is green, and `nest build` succeeds.
