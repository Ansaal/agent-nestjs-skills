---
name: nestjs-fdd
description: Feature-Driven Development (FDD) planning for NestJS, turning a spec into a domain model, a feature list, feature modules with an acyclic import graph, and a PLAN.md built one test-proven feature at a time. Use when planning, designing, or structuring a NestJS app or a new feature from a spec, or when continuing a build from an existing PLAN.md.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Feature-Driven Development

Coad/De Luca FDD applied to NestJS: five ordered steps from spec to working code, recorded in `PLAN.md` at the repository root. A *feature* is a client-valued function small enough for one test block to prove; a *feature set* is one Nest feature module. Verified 2026-10-29 against NestJS 12.3.2 and Vitest 5.0.5 on Node 24.22.2 (test-name filtering and the red-phase scaffold in step 5).

Copy [`references/plan-template.md`](references/plan-template.md) to `PLAN.md` before step 1 and fill one section per step. When `PLAN.md` already exists, run steps 1–4 for the delta only (new requirements, objects, features), append to the existing sections, then continue step 5 at the first unticked enabler or feature.

Record every decision as it is made, in any step, in § Decisions: the question or context, the decision, its rationale, the alternatives rejected, and the R-, E- and F-ids it affects (`D1` send reminders once a day at 08:00 Europe/Berlin, not when each loan falls due). Enablers and features cite the D-ids they rely on, so a later session sees a choice, not a gap to reopen.

Running example (a library lending API): members borrow copies of books; a member holds at most 5 active loans; a loan lasts 21 days; overdue members get an email.

## 1. Develop an overall model

Read the whole spec, then fill `PLAN.md` § Overall model:

- **Requirements**: number every spec sentence that states behaviour (`R1`…), quoted verbatim.
- **Domain objects**: every noun the system stores or computes (`Member`, `Book`, `Copy`, `Loan`), its kind (entity, value, external), key attributes, and relationships with cardinality.
- **External systems**: every system the app calls or is called by (mail gateway), with what it is used for and how it fails.
- **Invariants**: every "must", "never", "at most", "unique", "only if" in the spec (`I1` a copy is on at most one active loan; `I2` a member holds at most 5 active loans), each citing its `R`-id and naming the **owning object**: the entity whose state the invariant constrains.
- **Out of scope**: spec items deliberately excluded, each with a reason.

**Done when** every `R`-id is referenced by a domain object, an invariant, or an Out-of-scope entry, every invariant names exactly one owning object, and every question the spec leaves open has a D-id.

## 2. Build a feature list

Group the work into feature sets (one per business activity: Membership, Catalog, Lending, Reminders) and list features under each. Name every feature `<action> the <result> <by|for|of|to> a(n) <object>`:

- `Lend a copy to a member`
- `Calculate the due date for a loan`
- `List the overdue loans of a member`
- `Send the overdue reminder to a member`

A feature is client-valued: a spec reader recognises it as something the system does for them. Persistence, entities, DTOs, and wiring are design detail inside features (step 4), never features of their own. A candidate whose proof needs writes in two feature sets is two features.

Work that features need but no client values (database and migration setup, a lock store, packages and configuration, shared authentication) goes in § Enablers as `E1`…, each with its purpose, files or resources, the enablers it depends on, and an acceptance check: a command and the result that proves it done (`E2 Lock store`: the contract suite passes). Enablers never enter the feature list; features list the E-ids they need under Depends on.

Each feature set becomes one Nest feature module (`Lending` → `LendingModule`) that owns the entities of the domain objects assigned to it (fill the Feature set column in § Domain objects); layout per `nestjs-best-practices` rule `arch-feature-modules`. Each invariant belongs to the feature set owning its owning object (`I2` constrains `Loan` state, so Lending enforces it and Membership stays unaware of loans).

**Done when** every `R`-id maps to at least one feature or Out of scope (the Covered by column), every domain object has a feature set, every feature name matches the grammar, every invariant is listed under a feature of its owning feature set, every feature set has a module name in § Feature sets → modules, every enabler has its purpose, files or resources, dependencies, acceptance check and Decisions filled, and every decision made so far has a complete § Decisions row whose D-id each enabler and feature it affects cites.

## 3. Plan by feature

Draw the module import graph in § Module dependency graph (mermaid, arrow = "imports"), one edge per cross-module call a feature needs. The graph is a DAG: modules wire with plain `imports`, and a needed `forwardRef` signals a modelling error. Resolve a cycle in the model: move the feature to the module owning the data it reads, extract the shared concept into a new module both import, or decouple with events (`nestjs-best-practices` rule `arch-avoid-circular-deps`). Then return to step 2 for the moved features.

Fill § Feature sets → modules per module:

- **Exports**: its service(s) only. Repositories and `TypeOrmModule.forFeature` stay inside the owning module; other modules read and write that data through the exported service.
- **External clients**: one client provider per external system, inside the module whose features call it (its own module when several feature sets call it). HTTP transport per `nestjs-http-client`, resilience wrapping per `nestjs-resilience`.

Record each feature's **Depends on** (the features whose behaviour it calls or whose data it needs, and the enablers it needs), then order § Enablers and § Features for building: modules in topological order (imported before importer), within a module every feature after the features it depends on, and every enabler before the first feature that depends on it (its **Build before** entry).

**Done when** the graph is acyclic, every module's exports list holds services only, every feature's position comes after every feature it depends on, and every enabler names the first feature it must precede.

## 4. Design by feature

Fill the five design fields of every feature in § Features:

- **Interface**: the route, method, DTO, and success/error status codes when the feature is reachable over HTTP; the service method signature in every case.
- **Data**: entities and columns it reads and writes; `migration: yes` when it adds or changes a column or table (migration mechanics per `nestjs-typeorm`).
- **Calls**: exported service methods of other modules it calls; each matches an edge in the graph. A call without an edge means updating the graph and re-running the step 3 acyclicity check.
- **Operations**: its trigger and schedule (`nestjs-schedule`), what happens when a run overlaps the last one or runs on every instance, the lock and fencing it needs (`nestjs-locks`), its retry and idempotency behaviour (`nestjs-resilience`), and the log lines an operator needs (`nestjs-logging`). Assess every feature, request/response ones included: a route that calls an external system still needs its retry, idempotency and log lines. Write `none` only when none of these applies. `Send the overdue reminder to a member` is a daily cron that must not mail a member twice when two instances run it.
- **Test**: the test that proves the feature: e2e when the feature is reachable over HTTP, unit when it is domain logic without a route (`Calculate the due date for a loan`). The `describe` title is the feature name verbatim; list one `it` case for the main outcome, one per invariant the feature enforces, and one per error status in Interface. Each case asserts something only the feature produces: an error case checks the feature's error body too, because a status alone (404) is also what a missing route returns.

This test is the feature's completion criterion: the feature is done exactly when every listed case passes.

**Done when** every feature has all five fields filled, every invariant appears in at least one `it` case, and every Calls entry matches a graph edge.

## 5. Build by feature

Build one enabler or feature at a time, in build order. An enabler is done when its acceptance check passes; tick it `[x]`. For each feature:

1. Write the test file entries exactly as listed in PLAN.md (file locations, `Test.createTestingModule`, `useMocker`, supertest per `nestjs-testing`).
2. Scaffold the feature's signatures (route, DTO, service method) with bodies that throw a feature-specific error, e.g. `throw new NotImplementedException('F3 List the overdue loans of a member')`.
3. Run `npx vitest run -t '<Feature name>'` and see it **red**: every listed `it` fails on its own, each for the behaviour it is meant to prove (`expected 501 to be 404` is the scaffold answering, not a wrong expectation). A case that passes while red proves nothing (an expected 404 also passes before the route exists); rewrite it to assert something only the feature produces, such as the feature's error message or the row it writes. A run reporting only skipped tests exits 0 and means the `describe` title differs from PLAN.md; fix the title.
4. Implement in the owning module, replacing the scaffold (plus its migration when Data says `migration: yes`).
5. Re-run until **green**: `Tests  N passed`, where N is the number of `it` cases listed for the feature.
6. Run the full suite; on green, tick the feature `[x]` in PLAN.md.

Work the build reveals (a missing feature, enabler, invariant, call, or decision) goes into PLAN.md through steps 2–4 before any code for it is written.

**Done when** every enabler and feature in PLAN.md is ticked with every field filled, every decision made in any step has a complete § Decisions row whose D-id each enabler and feature it affects cites, the full test suite is green, and `nest build` succeeds.
