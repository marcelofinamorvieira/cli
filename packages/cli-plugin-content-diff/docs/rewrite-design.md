# TypeScript content migration design

The public artifact is an editable TypeScript migration containing actual CMA calls. `content:diff` generates it; the plugin-owned `content:apply` executes it through the shared guarded content engine. Schema autogeneration remains schema-only.

## Artifact and authority

A migration consists of a timestamped `.ts` entrypoint and a sibling `.content` directory. The TypeScript is authoritative for intended changes. Large scripts contain sequentially loaded `.ts` parts; small scripts contain their calls inline.

The companion contains immutable baseline evidence: source/destination bindings, managed schema, tracking-model bindings, guards for every destination identity, original payloads for identities changed during generation, exact source validity evidence, and verified asset binaries. Checksummed JSONL files hold this evidence. There is no executable JSON mutation plan and no desired-state sidecar to override edited TypeScript.

Checksums detect corruption, incomplete copies, and accidental baseline edits. They do not authenticate a migration against someone who can replace both files and checksums. Scripts and companions contain project content and no client authentication credentials. Keep them together and preserve their filenames and relative paths.

Generated code imports the precise public `ContentMigrationClient` interface for supported local mutation methods and their intended-state return values. Compile-time checks reject unsupported reads/schema/configuration, while runtime validation remains authoritative for values and dependencies. Generated code uses `defineContentMigration` from the plugin's public `migration` entrypoint. It is trusted Node code, not a sandbox. Guards cover operations performed through its supplied recording client; arbitrary imports or independently constructed clients retain ordinary Node capabilities.

## Generation

1. Resolve endpoint profiles through public CLI config/credential utilities and the Dashboard SDK. Read each schema freshly through `site.rawFind` with models and fields included, plus workflows; reject missing, duplicate or wrongly owned included resources. Retain canonical normalization, precision checks and hash projection. Resolve project/environment identities and schemas. Exclude only the configured, validated native migration-tracking model; retain its exact identity or recorded absence.
2. Check schema compatibility before allocating SQLite or reading content. The planner repeats the same compatibility guard for other callers.
3. Capture complete managed namespaces once into temporary SQLite, including fully expanded current and published blocks, schedules, assets, and folders. Generation assumes content and schema are held unchanged externally. It performs no post-capture version scan, full reread, or schema/asset consistency reread, and exposes no verification flag. Read permissions, pagination completeness, and payload integrity remain checked. Selected models limit changes, not preservation or dependency proofs. Separate projects can be read concurrently; environments in one project share its API rate limit.
4. Build the indexed dependency, uniqueness, ordering, publication, and temporary-schema plan. Reject unsafe changes unless a proven isolated partial closure is authorized.
5. Emit readable CMA calls and original asset files into staged output. Publish a complete script/companion pair only after the baseline and binaries are complete; reject existing paths.

`content:diff [NAME]` uses native `{unix_timestamp}_{camelCaseName}.ts` naming. The name defaults to `contentMigration`. `--output` accepts an exact `.ts` path or directory. Without it, use the `content/` subdirectory of the destination profile's configured migration directory relative to the configuration file, or `./migrations/content`. The native schema runner does not discover scripts in this subdirectory.

Comments label captured model/record identities and lifecycle, asset, folder, schedule and ordering actions. Labels are bounded and escaped; content cannot inject code through comments. Prettier resolves project configuration against final entrypoint and part paths, falls back to defaults on invalid configuration, and formats bounded groups of operations. Formatting growth can trigger further splitting between operations; every resulting file must satisfy the absolute 16 MiB limit.

The default TypeScript part target is 1 MiB. Never split a CMA operation. One large operation can occupy its own part, within the source-file ceiling. A small diff remains a short script even when its full-namespace guards are large.

## Execution and edits

1. Load the trusted TypeScript definition and verify its companion metadata and asset checksums.
2. Verify destination project/schema binding and primary authorization. Capture and verify the current destination, passing the tracking-schema projection through consistency rereads, then compare every managed identity with the immutable baseline, including content outside the selected models.
3. Invoke the script with a recording CMA facade inside a temporary SQLite transaction. Supported calls mutate a local intended namespace initialized from the destination; they do not discover intent by submitting remote writes. Unmentioned records and omitted update fields remain preserved. Creates require explicit canonical UUIDv4 identities checked with the public CMA SDK validator, including new/recreated nested blocks. Numeric legacy IDs remain excluded from new creations. Unsupported operations and attempts to leave the selected model scope fail closed.
4. Resolve validity for every intended current/published slice. Exact captured source evidence can be reused only when record ID, slice, and field hash match. Unknown edited values use native non-mutating validation endpoints. Refuse validation that depends on future/new references, changed assets, structural failures, or defaults that would substitute different values. Do not invent validity. Unchanged generated cycles retain their exact source evidence.
5. Rebuild the plan from the executed TypeScript, including dependencies, publication cycles, ordering, deletions, temporary rules, and binary bindings. Generation-time choices are not an executable desired-state override. The generation deletion flag controls emitted calls; explicit supported deletes in edited TypeScript become intended deletions when replanned.
6. Pass the fresh plan to the guarded executor. Verify the destination/fork, perform dependency-ordered writes with focused guards, restore schedules and temporary settings, then verify the complete intended namespace.

`content:apply --dry-run` follows this same path through full baseline, permission, schema, dependency and schedule preflight, then returns before fork creation or any plugin-owned remote write. It returns entity counts, changed model/resource groups and temporary field-change count; SQL aggregates keep preview memory proportional to schema size. Native validation requests remain read-only with respect to content, and trusted user code can have independent side effects. Preview reserves nothing; a later apply repeats preflight.

The public `applyContentMigration` and `repairContentMigration` take the script path, root client, environment-client factory, and explicit execution options. They invoke `applyPlan` and `repairPlan` through one mandatory `PreparedPlan` contract containing metadata, streamed entries, optional verified snapshot and a release callback. There is no legacy serialized mutation-plan reader or writer. Internal SQLite plan rows are temporary derived state, not saved execution progress or public input.

DatoCMS has no persistent public sandbox write freeze. The plugin does not implement an environment lock. Generation relies on external write controls and does not verify captured state. Apply retains destination-capture, baseline, prewrite, schedule-restoration, and final checks. Maintenance mode applies only to primary and does not provide a transaction; retain explanatory comments beside those apply checks. Competing writers must be stopped; observed-conflict checks cannot remove the race between a read and its following write.

Apply's `versions` verification uses current versions and published-version timestamps to avoid redundant reads. Full verification rereads complete records. Managed schema changes and plugin-controlled upload rewrites receive additional checks, but external in-place rewrites can evade version-only comparison. Full reads strengthen verification without freezing the environment.

## Plugin-only execution boundary

The plugin must work with the unmodified DatoCMS CLI and shared utilities. It registers only `content:diff` and `content:apply`, with no native command overrides, runtime patches or content-specific host contracts. The native schema migration runner remains separate.

`content:apply` owns the complete content lifecycle: environment authorization, fork creation, cooperative cancellation, verification and failed-fork cleanup. Generated default exports are branded content definitions rather than functions pretending to be native migrations. The content loader validates that descriptor; the native schema runner cannot execute it. The plugin does not write native migration receipts or maintain a pending-script queue.

Tracking-model projection requires canonical schema and the exact identity recorded at generation. A newly introduced, replaced or missing tracking model is rejected. Existing schema migration receipts remain outside content synchronization. Complete required schema changes before generating content; changes to captured schema or content invalidate the baseline.

The plugin runtime must resolve as a project dependency from the generated script. A separately installed CLI plugin does not guarantee that import resolution. No modified native CLI build is required.

## Memory, lifecycle, and repair

Use Node's built-in SQLite on Node 22.13+ or Node 24+, bounded record batches of at most 30, streaming metadata, indexed lookups, and iterative graph algorithms. Reuse the CMA client's authentication, retry, serialization, and async-job handling. Parallelize independent work only; serialize dependent writes and writes affecting the same ordered sibling group.

TypeScript loading uses the public `tsx/cjs/api`, with normal project config/helper resolution and source maps. The entrypoint cache entry is evicted to observe edits. Imported dependencies retain normal caching; worker processes own and release the complete module/transform state of each part. A fresh CommonJS wrapper without `require.cache` entries did not prove bounded memory: local measurements found retained compiled code across large parts. Large generated parts therefore run in disposable Node worker processes. Thread termination left esbuild child processes accumulating until the main CLI exited; process boundaries release those compiler descendants after each part. Each process forwards awaited CMA-shaped calls to the parent's recorder, with at most one handler active, and exits after the part completes; the parent awaits its exit before continuing. The small primary module is loaded once. Process isolation controls compilation lifetime; it is not a security boundary.

Generation and execution are one-shot. No pause/resume, checkpoints, persisted temporary database, or recovery cursor is accepted. Remove owned SQLite and staging files on completion or failure. Keep complete scripts and companions. Cooperative signals drain submitted work and perform cleanup; forced process termination cannot.

Default application owns a fresh fork and removes it after failure unless explicitly retained. `--fork-name` names that new fork, separately from the baseline `--destination`; collisions fail before mutations. Ownership requires a successful fork response and the same creation timestamp, origin and nonprimary state during verification/cleanup. An uncertain creation response never grants cleanup ownership. Verified progress is aggregated by model/action/phase with bounded counters and throttled output, never emitted from local intent recording. `--in-place` is an explicit override; primary also requires `--allow-primary`. Never delete a pre-existing environment or automatically promote a fork.

Cancel schedules only for written records. Recreate their exact intended future dates after writes and temporary settings are restored. Preserve other schedules. Refuse schedules within the configured window before starting. On in-place failure, restore an original schedule only when the record still contains original content; report ambiguous or already-changed records.

Repair uses the same script and immutable companion without saved run progress. Reconstruct original changed identities from stored originals; guard-only identities must still match their original guards. Replay the script locally and derive a fresh repair plan. Restore only eligible schedules and exactly recognized temporary field settings; never rewrite record content or save a new version merely to refresh validity. Report incomplete or ambiguous recovery.

Repair must refuse missing original evidence, unrelated schema changes, changed tracking-model identity, expired/ambiguous schedules, and edited validity that cannot be verified while changed field rules remain. Editing a previously unchanged identity can make later repair unreconstructable because its original payload was never saved. Retain the exact script used by the failed run.

## Component boundaries and verification

| Component | Responsibility |
| --- | --- |
| `engine/store`, `types`, `codec` | Temporary storage, canonical states, guards, nested payloads, and typed references. |
| `engine/capture`, `schema` | Complete bounded captures, permissions/schema proofs, and consistency checks. |
| `engine/planner*` | Dependency order, uniqueness, publication cycles, ordering, safe skips, and temporary rules. |
| `engine/migration-artifact` | TypeScript emission, immutable baseline storage, binaries, integrity, and atomic staging. |
| `engine/migration-intent`, `migration-validity` | Recording facade, local simulation, exact evidence, and native validation of unknown edits. |
| `content-migration-client`, `engine/migration-preview` | Accurate authoring types and bounded read-only preview summaries. |
| `engine/migration-loader` | Public tsx loading, source locations, disposable part processes, and recording IPC. |
| `engine/artifact-integrity`, `asset-download` | Shared baseline/binary validation and original-byte downloads. |
| `engine/migration-schema` | Explicit native tracking-model identity and schema projection. |
| `engine/migration-repair` | Original-namespace reconstruction and fresh repair planning. |
| `engine/apply*` | Guarded fork/in-place execution, restoration, verification, and cleanup. |
| `migration` | Public generated-script definition and plugin-owned execution. |
| `commands/content`, `utils/profile-auth`, `utils/content-command` | Public CLI config/credential adapters, flags, naming, interruptions, sanitized terminal/JSON errors and logging. |

Tests must execute real generated TypeScript, edit its payloads, and show that replanning follows those edits. Include inline and worker parts, unchanged namespace preservation, source-evidence cycles, unsupported edits, corrupted companions, project/primary guards, plugin-only invocation boundaries, repair refusals, interruption, cleanup, and package resolution. Retain meaningful failures while investigating them.

Report scale evidence precisely. Parser/worker retention tests, synthetic planning, incremental live applies, and full live transfers prove different things. Do not infer 600,000-record TypeScript transfer throughput or production readiness from a small incremental apply. Live writes require explicit authorization and remain confined to the authorized projects and environments.
