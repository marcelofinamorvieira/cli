# Real CMA content-diff E2E

This suite runs generated content migrations against the real DatoCMS CMA. It
is deliberately excluded from `npm test` because each scenario creates and
destroys sandbox environments. Run it only against a disposable project.

The authoritative executable inventory is
[`executable-coverage.ts`](./executable-coverage.ts). Its offline contract test
fails if an actual `*.e2e.ts` spec is missing from the registry or from the
table below. The older `fixture-matrix.ts` is a design catalog, not evidence
that a live scenario exists or passed.

## Evidence status

**Not live-proven for this revision.** The recorded evidence predates the
plugin's move into this repository and onto the 6.x DatoCMS clients, so the
offline check that ties it to the current sources fails until the complete
command passes again and its new digest is recorded in
[`executable-coverage.ts`](./executable-coverage.ts).

The last complete pass was on **2026-09-29** using **Node 24.18.0**, with
**60 passing, one intentional pending case, and zero failures**, in 64 minutes 6 seconds,
against a blank disposable project, at suite-source SHA-256
`d5922c98cc7b2b3b12cbd5f52687fd8d84f3f5c841c0b126542e13ff80e851f1`.
Every executable lane, including the five `run-lock.e2e.ts` cases, was
live-proven for that revision. `KEEP` was unset, cleanup succeeded, and the
harness's own primary guard recorded the same primary fingerprint before and
after the suite. `structural-invalid.e2e.ts` remains
**historical-unconstructible**. The golden-path and run-lock specs also passed
through a packaged host built from the same sources (packaged-build mode).
The separate [cross-project suite](../cross-project-e2e/README.md) passed on
28 September 2026 with its own evidence and source digest.

The digest covers the plugin's sources, these suites, `bin/dev`,
`package.json`, and every dependency the plugin loads, as the workspace
`package-lock.json` pins it, including the sources of the workspace packages
among them (`@datocms/cli-utils` and `datocms`). A change elsewhere in the
repository does not invalidate it.

A spec becomes **live-proven** only after the
complete command below passes against a disposable project with `KEEP` unset,
cleanup succeeds, the harness's [primary-environment guard](#primary-environment-guard)
passes (it fails the suite if primary changed), and the centralized evidence
value in `executable-coverage.ts` is updated with that dated result and the
machine-checked suite-source digest. Its `primaryVerifiedBeforeAndAfter` field
records that guard result; earlier runs, including the 22 September result
above, relied on a separate manual read-only check. Source review and offline
scenario tests do not count as live proof.

The inventory currently contains 38 spec files and 61 Mocha cases: 37
executable spec files containing 60 cases, plus one intentional pending case.
These inventory counts are mechanically checked; they are not a current pass result.

## Secure run

The token needs permission to create and destroy environments; edit schema;
read, write, publish, and schedule records; manage uploads; and create the
migration-tracking model. The harness reads it only from
`DATOCMS_API_TOKEN`. It does not put it in generated config files or command
arguments.

In a private interactive shell, read the token without echoing it or adding it
to shell history:

```bash
cd '<datocms-cli-plugin-content-diff-repository>'
read -r -s DATOCMS_API_TOKEN
printf '\n'
export DATOCMS_API_TOKEN
export DATOCMS_CONTENT_DIFF_E2E=1
export DATOCMS_CONTENT_DIFF_E2E_DISPOSABLE_PROJECT='<project-id>'
unset DATOCMS_CONTENT_DIFF_E2E_KEEP
npm run test:e2e:real-cma
unset DATOCMS_API_TOKEN DATOCMS_CONTENT_DIFF_E2E DATOCMS_CONTENT_DIFF_E2E_DISPOSABLE_PROJECT
```

The explicit opt-in is mandatory. The project marker is also recommended even
for a blank project and becomes mandatory if primary contains data. For a
non-empty primary, the project name must additionally contain `e2e`, `test`,
`testing`, or `disposable` as a separate word.

To run one case, keep the command and focus it with Mocha's grep, for example
`npm run test:e2e:real-cma -- --grep "TypeScript artifact"`. Scenarios refuse to
start unless the suite primary-environment guard is active, so invoking a spec
through a bare `mocha` command without the package script's
`--require test/e2e/real-cma-harness.ts` fails before any CMA work.

To run the same suite through a packaged build instead of the checkout's
TypeScript sources, see [packaged-build mode](#packaged-build-mode).

For offline checks only, run `npm test` and `npm run package:check`; neither
records any live-CMA proof. The [package check](#fresh-consumer-package-check)
fails with a missing/unexpected file diff unless the tarball holds exactly one
`lib/` JavaScript and declaration file per `src/` TypeScript file,
`oclif.manifest.json`, `README.md`, and `package.json`. Sources, tests,
scripts, `bin/`, `docs/`, generated `.datocms-content` state, build info, and
environment files are never shipped.

## What a passing executable lane proves

The harness performs the same lifecycle for each successful scenario:

1. It checks the primary environment safety boundary and that primary is the
   one the suite guard fingerprinted, then forks isolated source and
   destination sandboxes.
2. It seeds the scenario and requires the captured site/schema/current and
   published record/upload/collection fingerprints to remain unchanged across
   `content:diff` generation. Workflow definitions and full schedule resources
   are not part of that fingerprint.
3. It runs the generated artifact through this plugin's own `migrations:run`
   (the destination-bound runner that replaces the core command in the host)
   into a third sandbox. By default the CLI is started through `bin/dev` from
   the checkout's TypeScript sources; packaged-build mode uses a real
   `datocms` host with the plugin installed from its tarball instead.
4. The scenario checks its own CMA oracle. Lanes explicitly tagged with the raw
   claim compare raw current/published slices; other lanes use typed CMA reads.
   IDs, lifecycle/validity state, schema state, and exact asset bytes are
   asserted only where the registry says so.
5. It directly replays the migration behind a mutator-rejecting CMA proxy, then
   regenerates the diff and requires zero operation/destructive counts. A
   zero-operation regeneration can still contain warnings or preserved/skipped
   aggregate diagnostics; it is not necessarily an empty diagnostic plan.
6. It destroys the created environments in reverse order, then compares
   primary with the previous primary check so a change is attributed to the
   scenario that made it.

Expected-generation-failure scenarios instead prove fail-closed diagnostics,
unchanged captured source/destination fingerprints, and no leftover migration
artifact. For single-project live proof, every executable case must pass, the one documented
historical fixture must remain pending, `KEEP` must be unset, cleanup must
succeed, and the primary-environment guard must pass.

## Primary-environment guard

`npm run test:e2e:real-cma` loads `real-cma-harness.ts` with Mocha's
`--require`, which registers root hooks around the whole suite:

- Before anything else, the same disposable-project boundary that each
  scenario enforces is checked with three small primary reads (model list and
  one-row record and upload pages). A non-empty primary without the project
  marker and a disposable name is refused before the baseline reads it in full.
- An independent read-only client then fingerprints primary with the same
  function used for the source and destination sandboxes (site semantics,
  schema, current and published records including nested payloads, uploads,
  and upload collections), plus primary's workflow definitions and the
  project's environment inventory (ID, primary flag, fork source, creation
  time, read-only mode).
- After each scenario's cleanup, primary is fingerprinted again and compared
  with the previous check (the baseline for the first scenario). Environments
  created and owned by this run are excluded from the inventory; any other
  environment that appears or disappears, any metadata or primary switch, and
  any primary content or workflow change fails that scenario as a
  `primary environment check failed after scenario ...` error that names the
  compared checkpoint. When the scenario itself also failed, both messages are
  reported in the same error. Because each check compares with the previous
  one, a single faulty scenario does not fail every later scenario.
- After the last case, primary is compared with the suite baseline, so any
  change made at any point still fails the suite.
- With `KEEP` unset, an owned sandbox still present after cleanup is also a
  failure: the scenario check reports the scenario's own sandboxes and the
  suite-end check reports every one. With `KEEP=1`, retained sandboxes are
  expected and excluded.

This replaces the earlier manual before-and-after verification of primary. For
a blank primary, a passing suite-end check with `KEEP` unset also proves that
primary still has no models, records, uploads, or workflows and that only the
pre-existing environments remain. The guard proves primary is unchanged, not
blank; the disposable-project boundary governs which projects may be used.
Operational fields that the platform updates asynchronously (environment
status and `last_data_change_at`) are not compared. Only the resources listed
above are fingerprinted: project-level resources such as roles, API tokens,
webhooks, and build triggers, and other primary resources such as plugins and
menu items, are not.

## Executable lane inventory

The descriptions are deliberately narrow. They state what each seeded live
scenario asserts; they are not claims of exhaustive state-space coverage.

The offline suite separately enumerates all 1,364 ordered paths through five
levels of Modular Content, single blocks, Structured Text blocks, and inline
blocks. It also checks every directed three-record graph, including self
references, against independent dependency and skip-closure oracles. These
bounded enumerations supplement the live fixtures; they do not prove arbitrary
graphs, concurrent writers, or behavior beyond the documented CMA limits.

<!-- executable-e2e-inventory:start -->
| Spec | Executable scope |
| --- | --- |
| `advertised-block-limit.e2e.ts` | 2,000 blocks at authenticated project-supported depth, exact current/published identities, replay, and regeneration; requires a project permitting at least 2,000 blocks per record. |
| `assets-deletions.e2e.ts` | Bundled upload bytes, canonical source-only creation, same-ID binary replacement, writable metadata, upload collections, one unreferenced managed upload deletion, an isolated same-byte stem rename requiring only read plus replace-asset permission, and an EXIF-bearing replacement that must preserve cleared manual fields. |
| `cascade-strategies.e2e.ts` | Managed publish/unpublish/delete reference cascades and an external fail-strategy rejection boundary. |
| `complex-recursive-boundary.e2e.ts` | Deterministic 500-block, project-supported depth (four or five, capped at five), complete seeded DAST grammar, and at-least-250,000-byte record boundary. |
| `custom-structured-text.e2e.ts` | Non-DAST Structured Text children traversal, real nested references/blocks, and ignored sidecar decoys. |
| `environment-semantics.e2e.ts` | Timezone mismatch rejection without artifacts or captured-fingerprint changes; API-read order is not instrumented. |
| `fresh-nested-lifecycle.e2e.ts` | Source-only create/publish/different-current-ID convergence and preservation of a desired current ID retained only in destination PUBLISHED. |
| `fresh-nested-update.e2e.ts` | Exact fresh published/current nested IDs through an ordinary valid existing-record update. |
| `historical-null-default.e2e.ts` | Non-localized and localized float nulls under later non-null defaults, with exact opt-in default suppression and restoration. |
| `invalid-content.e2e.ts` | Invalid current/published migration with exact opt-in validator relaxation, plus default fail-closed skips. |
| `invalid-schedule-only.e2e.ts` | Preservation of invalid aggregates when future selective schedule state cannot be safely reconciled. |
| `localized-media-defaults.e2e.ts` | Localized file/gallery/SEO/video, localized metadata, nested uploads, null/empty/omitted locales, bundled bytes, supported normalized non-string defaults, and exact suppression/restoration for the seven CREATE-time historical null fields. |
| `medium-scale-recursive.e2e.ts` | 65 paginated records with localized/scalar/lifecycle/order/link/recursive-block drift; not a throughput benchmark. |
| `mixed-state-skip-closure.e2e.ts` | Multi-hop invalid A to published B to current-only C skip closure, protected target upload, and independent D/upload convergence. |
| `mixed-validity.e2e.ts` | Opposite current/published validity states and exact enum-validator restoration. |
| `no-draft-singleton.e2e.ts` | Source-only published dependency creation before a no-draft singleton. |
| `optional-create-validation.e2e.ts` | Three-record optional-reference create SCC under order-dependent `size.multiple_of` validation. |
| `optional-self-cycle.e2e.ts` | Strict two-record optional cycle containing a self-reference, exact restored self/peer links, and no validator relaxation. |
| `optional-deletion-validation.e2e.ts` | Optional-reference deletion SCC under strict `size.multiple_of` validation. |
| `published-tree.e2e.ts` | Parent-first source publish and reparent-before-child-first destination subtree deletion. |
| `run-lock.e2e.ts` | `migrations:run` run lock and interruption against owned sandboxes: duplicate lock-ID rejection with no overwrite and a stored 255-character lock name, one of two concurrent in-place runs refused without running anything, `content:diff` refused against a locked source or destination, a locked fork source refused until `--force-unlock` with its token clears it, a lock copied by a fork reported, and one SIGINT stopping after the running ordinary migration while a second exits at once and prints the unlock token. |
| `sanitized-html-write-guard.e2e.ts` | Expected pre-artifact rejection for active `sanitized_html` rewrites across source-only CREATE and an invalid/full-rehydrate unrelated-field UPDATE, with exact raw historical bytes and unchanged environment fingerprints. |
| `real-cma-lifecycle.e2e.ts` | Draft, published, updated, unpublished, and no-draft lifecycle states. |
| `real-cma-schedules.e2e.ts` | Selective publication/unpublishing plus quiescence and exact restoration of unchanged schedules on changed and noop records. |
| `real-cma-topology.e2e.ts` | Tree topology, sortable order, and workflow stages. |
| `real-cma.e2e.ts` | Portable generated-JavaScript golden path through the plugin's `migrations:run`, raw CMA verification, replay, and regeneration. |
| `recursive-composition.e2e.ts` | Two cases covering all 16 ordered embedding pairs, mixed nesting to depth five, two locales, opaque JSON decoys, and distinct current/published slices for source-only create and existing-record update; the second uses disjoint nested IDs across baseline/published/current. |
| `recursive-content.e2e.ts` | Localized published Structured Text-only required cycles: exact opt-in relaxation and default skip. |
| `required-deletion.e2e.ts` | Required deletion SCC preservation, including a published nested-block SCC that cannot be safely unlinked. |
| `schema-gating.e2e.ts` | Managed validator/default drift rejection and unrelated schema-drift allowance. |
| `selective-publication.e2e.ts` | Exact published locale membership/nonlocalized inclusion with divergent current values. |
| `selective-schedule-validity.e2e.ts` | Provably valid scheduled locale slice migration while an invalid unselected locale is preserved. |
| `shell-components.e2e.ts` | Required one-way dependency across independently planned shell SCCs. |
| `structural-invalid.e2e.ts` | **Pending:** needs a curated historical/server-seeded excluded-block state; no live behavior is claimed. |
| `transitive-schema-presentation.e2e.ts` | Fourth-hop managed schema gating and preservation of destination-only presentation metadata. |
| `typescript-artifact.e2e.ts` | Generated TypeScript artifact through the plugin's `migrations:run`, guarded direct replay, and empty regeneration. |
| `unique-deletion.e2e.ts` | Current/published unique handoffs, cyclic swaps, localized staging, invalid peers, optional deletion SCCs, external referrers, and skipped-owner upload protection. |
| `validator-gauntlet.e2e.ts` | Constructible scalar/date/slug/HTML and upload/image/gallery/SEO/description validators with exact restoration and bundled bytes; `slug_title_field` is preserved during slug-format relaxation and restoration; it is not a separately invalidating content rule. |
<!-- executable-e2e-inventory:end -->

## Intentional exclusions and limits

Identity conversion and the separate update-IDs product are out of scope for
this suite. Their design-catalog entries must not be counted as executable or
live coverage here.

Each scenario has a 25-minute work deadline within Mocha's 30-minute timeout.
On completion or failure, the harness aborts and drains its active HTTP
requests and CLI children before ownership recovery and cleanup. This stops
local work from racing cleanup; it cannot roll back a server job already
accepted by CMA. Cleanup uses independent clients after that drain.

The suite also does not prove that the product is safe under simultaneous
writers to the same destination. `run-lock.e2e.ts` covers only how the run
lock orders `migrations:run` and `content:diff` processes, not editors or other
API clients, and it interrupts ordinary migrations only; the cooperative stop
of generated content migrations is covered offline. Run E2E jobs serially per
project. There is no
environment-wide transaction across every CMA mutation, and a hard process
kill can interrupt best-effort validator/default restoration or environment cleanup.
Those architecture limits cannot be removed by adding more scenarios.

The structural-invalid state remains an honest coverage gap. The CMA rejects
creation of blocks excluded by a structural field validator, while narrowing
an existing allowlist removes blocks of the retired model. A live test needs a
curated historical or server-seeded fixture; weakening the validator would
manufacture a different state and is not accepted as coverage.

## Packaged-build mode

By default both live suites start the CLI through `bin/dev`, which runs this
checkout's TypeScript sources with ts-node. Packaged-build mode instead runs
the suites against the artifact users install: the published-style tarball,
added with `datocms plugins:add` to a host running the workspace's `datocms`
version (`packages/cli`), installed from the registry.

Prepare a host (this rebuilds `lib/` and `oclif.manifest.json` the way the
package's `prepack` does, and needs registry access):

```bash
HOST="$(node scripts/prepare-packaged-host.mjs)"
export DATOCMS_CONTENT_DIFF_E2E_CLI=packaged
export DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST="$HOST"
export OCLIF_COLUMNS=1000
npm run test:e2e:real-cma
```

`OCLIF_COLUMNS=1000` matters in this mode: the packaged launcher prints
errors through oclif's formatter, which wraps them at 80 columns on a pipe
and prefixes every line, so the suite's exact refusal messages would no
longer match. `bin/dev` prints unformatted errors and does not need it.

The script packs the plugin into the host, creates a fresh consumer project,
installs the workspace's `datocms` version with `--save-exact` and engine-strict installation,
adds the tarball with `datocms plugins:add file:<tarball>`, and verifies that
the installed files match the tarball byte for byte and that `content:diff`,
`migrations:run --help`, and `help migrations:run` are served by the plugin
(the plugin's `--allow-primary` text, never the core runner's). It prints only
the host directory on stdout. Pass `--tarball <file.tgz>` to install a frozen
tarball instead of packing, or `--host-dir <empty directory>` to choose the
location. The host manifest (`content-diff-packaged-host.json`) is written
last, only after every installation and routing check has passed, and records
those checks. A failed temporary host is removed; a failed `--host-dir` is left
for inspection without a manifest.

All oclif data, config, and cache directories (`DATOCMS_DATA_DIR`,
`DATOCMS_CONFIG_DIR`, `DATOCMS_CACHE_DIR`) and the XDG base directories point
inside the host, both while preparing it and whenever the harness runs its
binary, so the global `datocms` installation and its plugins are never read or
changed. The harness validates the host before any CMA work: a manifest that
records passed installation and routing checks, the exact host version, the
installed plugin identity, the tarball digest, and, for a freshly packed host,
that `src/`, `bin/`, `package.json`, and `tsconfig.json` still match the
checkout it was packed from. Rerun the prepare
script after changing any of them. Setting
`DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST` without
`DATOCMS_CONTENT_DIFF_E2E_CLI=packaged`, or any other mode value, is rejected.
The mutation-guarded replay step still loads the generated artifact in-process
with the checkout's `tsx`; only the CLI invocations use the packaged host.

### Fresh-consumer package check

`npm run package:check` reproduces the frozen-tarball and fresh-consumer
checks without a DatoCMS project. It packs the checkout (or installs
`--tarball <file.tgz>`), prepares an isolated host as above, and runs, in
order and stopping at the first failure:

1. The tarball holds exactly the expected release files.
2. The packaged `oclif.manifest.json` declares exactly `content:diff`,
   `migrations:new`, and `migrations:run` at the packaged version.
3. The consumer resolved exactly the workspace's `datocms` version with engine-strict
   installation.
4. Every installed plugin file is byte-identical to the tarball.
5. `datocms plugins` lists the plugin as a user plugin at the packaged version.
6. `content:diff --help` is served by the plugin with every packaged flag.
7. `migrations:run --help` shows the plugin runner, not core.
8. `help migrations:run` shows the plugin runner, not core.
9. The plugin's exact dependency pins (for example `@oclif/core` and
   `typescript`) resolve to those versions beside the host's own copies.
10. `migrations:new` dispatches to the plugin command.
11. `migrations:run` dispatches to the plugin runner (reserved ledger model).
12. The primary-environment guard refuses an in-place primary run without any
    CMA mutation.
13. A migration bound to another project is refused before any fork.
14. A JavaScript migration runs in a new fork with the execution context and
    is recorded in the tracking model.
15. A TypeScript migration resolves a `tsconfig` path alias through the
    packaged loader.
16. A second run replays nothing and creates no fork.
17. The packaged launcher preserves oclif exit codes without an unhandled
    rejection.
18. When any `DATOCMS_*API_TOKEN` variable is set, none of those values appears
    in a packaged file.
19. When any such variable is set, none of those values appears in a
    repository file: every tracked file and every untracked file that is not
    ignored, as listed read-only by `git ls-files`. Ignored local files such
    as `.env` files and `node_modules/` are not scanned.

CMA calls in checks 10 to 16 are answered by an in-process mock that replaces
the plugin's client builder, so the check proves installation and command
behavior, not live content behavior. Run it once per supported Node.js
runtime. `--keep` retains the temporary host for inspection; it has no host
manifest, so prepare a separate host for live runs. Checks 18 and 19 are the
audit's package and repository credential scans; they run only when a token
variable is set. The earlier audit also recorded a fresh Git-installation
`prepare` check; it installs from a committed revision rather than this
working tree and is not reproduced here.

## Retain fixtures for inspection

By default, created environments and the temporary local workspace are removed
even after failures. To retain the environments for manual inspection, set:

```bash
export DATOCMS_CONTENT_DIFF_E2E_KEEP=1
```

The harness prints every retained environment ID. Destroy them manually when
finished. A hard process kill can bypass cleanup; generated environments use
the `cde2e-` prefix so abandoned fixtures can be found explicitly. Never run
two content-diff E2E jobs concurrently against the same project.
