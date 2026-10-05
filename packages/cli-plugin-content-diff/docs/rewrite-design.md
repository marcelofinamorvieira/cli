# TypeScript content migration design

The public artifact is an editable TypeScript migration containing actual CMA calls. `content:diff` generates it; `content:apply` or a compatible native `migrations:run` executes it through the shared guarded content engine. Schema autogeneration remains schema-only.

## Artifact and authority

A migration consists of a timestamped `.ts` entrypoint and a sibling `.content` directory. The TypeScript is authoritative for intended changes. Large scripts contain sequentially loaded `.ts` parts; small scripts contain their calls inline.

The companion contains immutable baseline evidence: source/destination bindings, managed schema, tracking-model bindings, guards for every destination identity, original payloads for identities changed during generation, exact source validity evidence, and verified asset binaries. Checksummed JSONL files hold this evidence. There is no executable JSON mutation plan and no desired-state sidecar to override edited TypeScript.

Checksums detect corruption, incomplete copies, and accidental baseline edits. They do not authenticate a migration against someone who can replace both files and checksums. Scripts and companions contain project content and no client authentication credentials. Keep them together and preserve their filenames and relative paths.

Generated code uses `defineContentMigration` from the plugin's public `migration` entrypoint. It is trusted Node code, not a sandbox. Guards cover operations performed through its supplied recording client; arbitrary imports or independently constructed clients retain ordinary Node capabilities.

## Generation

1. Resolve endpoint profiles, project/environment identities, and schemas. Exclude only the configured, validated native migration-tracking model; retain its exact identity or recorded absence.
2. Capture complete managed namespaces into temporary SQLite, including fully expanded current and published blocks, schedules, assets, and folders. Selected models limit changes, not preservation or dependency proofs. Separate projects can be read concurrently; environments in one project share its API rate limit.
3. Verify capture consistency. Pass the tracking-schema projection through all consistency rereads, not only the initial schema fetch.
4. Build the indexed dependency, uniqueness, ordering, publication, and temporary-schema plan. Reject unsafe changes unless a proven isolated partial closure is authorized.
5. Emit readable CMA calls and original asset files into staged output. Publish a complete script/companion pair only after the baseline and binaries are complete; reject existing paths.

`content:diff [NAME]` uses native `{unix_timestamp}_{camelCaseName}.ts` naming. The name defaults to `contentMigration`. `--output` accepts an exact `.ts` path or directory. Without it, use the destination profile's configured migration directory relative to the configuration file, or `./migrations`.

The default TypeScript part target is 1 MiB. Never split a CMA operation. One large operation can occupy its own part, within the source-file ceiling. A small diff remains a short script even when its full-namespace guards are large.

## Execution and edits

1. Load the trusted TypeScript definition and verify its companion metadata and asset checksums.
2. Verify destination project/schema binding and primary authorization. Capture the current destination and compare every managed identity with the immutable baseline, including content outside the selected models.
3. Invoke the script with a recording CMA facade inside a temporary SQLite transaction. Supported calls mutate a local intended namespace initialized from the destination; they do not discover intent by submitting remote writes. Unmentioned records and omitted update fields remain preserved. Creates require explicit portable IDs. Unsupported operations and attempts to leave the selected model scope fail closed.
4. Resolve validity for every intended current/published slice. Exact captured source evidence can be reused only when record ID, slice, and field hash match. Unknown edited values use native non-mutating validation endpoints. Refuse validation that depends on future/new references, changed assets, structural failures, or defaults that would substitute different values. Do not invent validity. Unchanged generated cycles retain their exact source evidence.
5. Rebuild the plan from the executed TypeScript, including dependencies, publication cycles, ordering, deletions, temporary rules, and binary bindings. Generation-time choices are not an executable desired-state override. The generation deletion flag controls emitted calls; explicit supported deletes in edited TypeScript become intended deletions when replanned.
6. Pass the fresh plan to the guarded executor. Verify the destination/fork, perform dependency-ordered writes with focused guards, restore schedules and temporary settings, then verify the complete intended namespace.

The public `applyContentMigration` and `repairContentMigration` take the script path, root client, environment-client factory, and explicit execution options. They share the original executor through an internal prepared-plan adapter. Internal JSON plan rows are temporary derived state, not saved execution progress or public input.

DatoCMS has no persistent public sandbox write freeze. Maintenance mode applies only to primary and does not provide a transaction. Keep the comments explaining this beside capture, prewrite, and schedule-restoration checks. Competing writers must be stopped; observed-conflict checks cannot remove the race between a read and its following write.

`versions` verification uses current versions and published-version timestamps to avoid redundant reads. Full verification rereads complete records. Managed schema changes and plugin-controlled upload rewrites receive additional checks, but external in-place rewrites can evade version-only comparison. Full reads strengthen verification without freezing the environment.

## Native migration integration

The normal runner provides managed execution context version 1: its chosen environment, original source environment, primary authorization, signal, logging, root client, client factory, and migration-tracking ownership. The generated default export activates managed cleanup before preflight and verifies that its supplied client targets that environment. Missing or incompatible context is refused.

The native runner owns its fork. The content runtime writes within it and never creates a second fork or promotes it. Completion uses the ordinary migration receipt system; a receipt records a completed script and is not an interrupted-run checkpoint. Failure cleanup also covers failure to save the receipt after content execution.

Tracking-model projection requires canonical schema and exact identity. If the model was absent at generation, only a matching model explicitly created by this native run may be introduced. Unrelated models or unknown ownership are not silently excluded. Prior pending migrations that change content/schema invalidate the captured baseline.

The plugin runtime must resolve as a project dependency from the generated script. A separately installed CLI plugin does not guarantee that import resolution. Use matching CLI/plugin builds; normal schema-only migrations retain their existing behavior.

## Memory, lifecycle, and repair

Use Node's built-in SQLite on Node 22.13+ or Node 24+, bounded record batches of at most 30, streaming metadata, indexed lookups, and iterative graph algorithms. Reuse the CMA client's authentication, retry, serialization, and async-job handling. Parallelize independent work only; serialize dependent writes and writes affecting the same ordered sibling group.

A fresh CommonJS wrapper without `require.cache` entries did not prove bounded memory: local measurements found retained compiled code across large parts. Large generated parts therefore run in disposable workers. Each worker forwards awaited CMA-shaped calls to the parent's recorder, with at most one handler active, and is terminated after the part completes. The small primary module is loaded once. Worker isolation controls compilation lifetime; it is not a security boundary.

Generation and execution are one-shot. No pause/resume, checkpoints, persisted temporary database, or recovery cursor is accepted. Remove owned SQLite and staging files on completion or failure. Keep complete scripts and companions. Cooperative signals drain submitted work and perform cleanup; forced process termination cannot.

Default application owns a fresh fork and removes it after failure unless explicitly retained. `--in-place` is an explicit override; primary also requires `--allow-primary`. Never delete a pre-existing environment or automatically promote a fork.

Cancel schedules only for written records. Recreate their exact intended future dates after writes and temporary settings are restored. Preserve other schedules. Refuse schedules within the configured window before starting. On in-place failure, restore an original schedule only when the record still contains original content; report ambiguous or already-changed records.

Repair uses the same script and immutable companion without saved run progress. Reconstruct original changed identities from stored originals; guard-only identities must still match their original guards. Replay the script locally and derive a fresh repair plan. Restore only eligible schedules and exactly recognized temporary field settings; never rewrite record content or save a new version merely to refresh validity. Report incomplete or ambiguous recovery.

Repair must refuse missing original evidence, unrelated schema changes, unknown native tracking ownership, expired/ambiguous schedules, and edited validity that cannot be verified while changed field rules remain. Editing a previously unchanged identity can make later repair unreconstructable because its original payload was never saved. Retain the exact script used by the failed run.

## Component boundaries and verification

| Component | Responsibility |
| --- | --- |
| `engine/store`, `types`, `codec` | Temporary storage, canonical states, guards, nested payloads, and typed references. |
| `engine/capture`, `schema` | Complete bounded captures, permissions/schema proofs, and consistency checks. |
| `engine/planner*` | Dependency order, uniqueness, publication cycles, ordering, safe skips, and temporary rules. |
| `engine/migration-artifact` | TypeScript emission, immutable baseline storage, binaries, integrity, and atomic staging. |
| `engine/migration-intent`, `migration-validity` | Recording facade, local simulation, exact evidence, and native validation of unknown edits. |
| `engine/migration-loader` | Trusted TypeScript loading, source locations, disposable parts, and recording IPC. |
| `engine/migration-schema` | Explicit native tracking-model identity and schema projection. |
| `engine/migration-repair` | Original-namespace reconstruction and fresh repair planning. |
| `engine/apply*` | Guarded fork/in-place execution, restoration, verification, and cleanup. |
| `migration` | Public generated-script runtime and native-runner integration. |
| `commands/content` | Profiles, flags, naming, interruptions, and terminal/JSON output. |

Tests must execute real generated TypeScript, edit its payloads, and show that replanning follows those edits. Include inline and worker parts, unchanged namespace preservation, source-evidence cycles, unsupported edits, corrupted companions, project/primary guards, native receipts/context, repair refusals, interruption, cleanup, and package resolution. Retain meaningful failures while investigating them.

Report scale evidence precisely. Parser/worker retention tests, synthetic planning, incremental live applies, and full live transfers prove different things. Do not infer 600,000-record TypeScript transfer throughput or production readiness from a small incremental apply. Live writes require explicit authorization and remain confined to the authorized projects and environments.
