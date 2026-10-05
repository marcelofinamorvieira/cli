# Content diff rewrite

## Scope

The public commands are `content:diff` and `content:apply`.

## Agreed requirements

1. Support small updates and full transfers in large projects.
2. Use temporary disk-backed SQLite and bounded in-memory batches.
3. Use Node's built-in SQLite; support Node 22.13+ on the 22.x line and newer
   supported runtimes with unflagged SQLite. Do not add a native driver.
4. Capture all selected records with fully expanded nested blocks, independently
   for current and published versions. Do not use metadata-only shortcuts.
5. Verify capture consistency. Abort when a consistent view cannot be obtained.
6. Include full baseline/desired content only for changed records. Unchanged
   records carry fingerprints and required dependency, ordering, schedule, and
   preservation metadata. DatoCMS calculates validity flags asynchronously;
   they are diagnostic metadata rather than writable intended content.
7. Write a small manifest, a streamed checksummed chunk index, and deterministic,
   byte-bounded JSONL chunks. Never
   split an entry. Checksum every chunk and required asset binary. Do not create
   a second human-readable report format.
8. Reuse CMA client authentication, retries, endpoint serialization, and job
   handling. Bound the plugin's page/work buffering; do not duplicate SDK retry
   logic or queue every page before consuming it.
9. Read records in nested batches of at most 30. Use indexed lookups and
   iterative dependency/uniqueness algorithms.
10. Generation and execution are one-shot. No checkpoints, resumable sessions,
    saved progress, pause command, or recovery cursor. Temporary working state
    is never accepted as input to another run.
11. Apply into a new isolated destination fork by default. Permit `--in-place`;
    primary also requires `--allow-primary`. Do not promote automatically.
12. Validate the complete managed baseline before writes and the complete
    intended result at the end. During writes retain focused dependency,
    publication, deletion, ordering, preservation, and conflict checks.
13. Explain concurrency checks in source comments: DatoCMS has no public
    persistent sandbox freeze; maintenance mode applies only to primary and
    does not create an immutable snapshot or a transaction.
14. Use bounded parallelism only for independent writes. Respect dependency
    order and serialize writes affecting the same ordered sibling group.
15. Reject unsafe requested changes by default. `--allow-partial` permits only
    proven isolated skips and their dependency closure. Global incompatibility,
    unproven access, and execution conflicts remain fatal.
16. Bundle binaries needed for upload creation/replacement during generation.
    Preserve upload identities where the CMA permits; replacements must not
    overwrite shared source/original-environment files.
17. Temporary validator/default changes require
    `--allow-temporary-schema-changes`. Restore original settings before
    success; attempt restoration on failure and report unsuccessful repair.
18. Temporarily cancel existing managed destination schedules before content
    writes. Recreate exact desired future schedules after verification. Never
    invent new dates. Attempt original schedule restoration on in-place failure.
19. Remove temporary SQLite/staging state and incomplete generation outputs.
    Attempt removal of a failed fork created by this run, unless
    `--keep-failed-fork` was supplied. Never delete a pre-existing environment.
20. Keep completed bundles. They are content exports and must exclude credentials.

Large-scale acceptance is deferred: no fixed 1 GiB RAM acceptance target and no mandatory
600k benchmark or live-scale gate. Ordinary correctness, compilation, lint,
CLI, packaging, failure, and cleanup verification are required. Large-project
readiness must not be presented as experimentally verified without evidence.

## Component boundaries

- `engine/types`: the new schema, snapshot, guard, plan, and bundle contract.
- `engine/store`: temporary SQLite tables and indexed streaming iterators.
- `engine/codec`: canonical states, fingerprints, nested payload adaptation,
  ownership and typed-reference traversal.
- `engine/capture`: bounded CMA pagination, access/schema proofs, complete nested
  capture, schedule reads, and capture consistency verification.
- `engine/planner`: indexed comparisons, dependency order, uniqueness analysis,
  safe skips, and explicit temporary schema-change plans.
- `engine/bundle`: atomic bundle staging, size-bounded JSONL and binary streams,
  integrity checks, safe relative paths, and cleanup.
- `engine/apply`: project binding, fresh-fork lifecycle, preflight, bounded
  ordered writes, scoped live checks, restoration, final verification, cleanup.
- `commands/content`: profile/authentication and command output only.

## Implementation and verification

Focused correctness tests cover this contract.
Use bounded local/mock cases for nested content, lifecycle, dependencies,
integrity, CLI routing, uncertain outcomes, and cleanup. Do not call live CMA
projects without explicit authorization or run deferred large-scale acceptance
experiments.

### Shared interfaces

The initial common contract is `engine/types.ts`; coordinate changes there.
`SnapshotStore` exposes a public `database: DatabaseSync` for indexed planner
queries, plus record/upload/collection insertion, retrieval and streaming
iterators by `Side`. It owns `records`, `uploads`, `collections`, `refs`,
`block_owners`, `unique_values`, `plan`, and `edges` tables. Plan rows are keyed by
`(kind,id)` and yield deterministic `(kind,model_id,id)` order. Its lifecycle is
`new SnapshotStore(directory?)`, `close()`, and `dispose()` (remove owned files).

- `createPlan(store, sourceSchema, targetSchema, options): Promise<PlanMetadata>`
- `writeBundle({ store, metadata, outputPath, chunkBytes?, fetchFn? }): Promise<string>`
- `readBundle({ directory, store }): Promise<BundleManifest>`
- `fetchSchema(client, environmentId): Promise<SchemaState>`
- `captureSnapshot({ client, environmentId, schema, store, side, options, verify? }): Promise<void>`
- `readRecordBatch(client, ids, schema): Promise<RecordState[]>`
- `applyBundle({ rootClient, buildEnvironmentClient, bundlePath, options }): Promise<ApplyResult>`

`codec` supplies stable JSON/hash functions, `recordGuard`, `canonicalRecord`,
`recordPayloadFields`, and `inspectRecord` (typed refs and block ownership).
Snapshot and plan states never include credentials. Any unsupported executable
state must be diagnosed during planning, not silently approximated at apply.
