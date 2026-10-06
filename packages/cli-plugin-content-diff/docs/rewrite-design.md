# Direct TypeScript content migrations

The public artifact is an editable TypeScript function containing actual ordered CMA calls. Generation plans once. Apply validates its original destination binding and executes the script as written. It never records intended content, simulates payloads, resolves simulated validity, or replans edited code.

## Generation

1. Resolve profiles/authentication through public CLI utilities and SDKs. Fetch complete model/field schemas in bulk and workflows separately; validate identities and normalize relevant settings. Exclude only the configured canonical schema-migration tracking model, retaining its exact binding.
2. Check schema compatibility before allocating SQLite or reading records.
3. Capture each complete managed namespace once, with expanded current/published blocks, schedules, asset metadata and folders. External write controls keep schemas/content stable; generation has no post-capture verification pass.
4. Plan changes locally using SQLite indexes for references, ownership, uniqueness, tree/folder order and supported cycles. Scoped changes still account for unchanged content. Refuse unsafe transitions unless proven isolated partial skipping was authorized.
5. Compile the execution phases into literal TypeScript calls: schedule removal, temporary settings, folders/assets, creation seeds, provisional and complete publications, current drafts, deletions, ordering, original field settings and intended schedules. Runtime reads are permitted where actual CMA responses determine native positions or validity. They execute immediately; no simulated namespace exists during apply.
6. Stage the script and companion atomically. Include immutable original destination evidence, schema/project/tracking bindings, original and temporary field settings for repair, and verified binaries. Do not serialize an authoritative desired-content plan.

Use timestamped filenames under the configured migration directory's content subdirectory. Honor explicit output, reject collisions, format bounded parts with project Prettier and enforce the per-file size limit.

## Direct execution

The callable definition carries format version 2 and baseline options. Normal execution loads it through public tsx APIs, requires the declared baseline to resolve to the same-named sibling companion, validates that companion, binds project/schema and primary authorization, and captures/compares the original destination baseline. Verify fork identity, ownership and copied baseline before execution. Default to a new isolated fork; direct primary writes need explicit in-place and primary flags.

The supplied client dispatches real CMA calls and returns real responses. Supported public methods may be transparently tracked only to drain in-flight work and stop new work after cancellation. Never derive a local intended namespace, rewrite payloads, reorder operations, or call the generation planner from apply.

Large parts run in disposable Node processes, forwarding supported awaited calls immediately to the parent CMA client. Preserve sequential dispatch, real error reporting, backpressure, cancellation and process/compiler cleanup. The client type uses SDK signatures for this supported surface; it must not advertise unsupported remote iterators or configuration proxies. Scripts remain trusted Node code, not a sandbox.

Edited scripts own their operation order, dependencies and validations. CMA writes validate actual payloads. Successful completion means the script finished; it does not prove equivalence with immutable generation-time desired content. Preserve this distinction in terminal and JSON results.

## Preflight

`--preflight-only` replaces simulated dry-run. It checks artifact integrity, original destination binding/baseline, declared generated permissions, primary/fork authorization and the existing schedule window. It never calls the migration body or creates a fork. It cannot preview edited operations or prove arbitrary payloads will succeed. Preflight checks source-file integrity without evaluating the module or its imports. Repair also reads the sibling companion without evaluating TypeScript. Normal execution treats module imports as trusted executable code. Generation counts remain historical summaries only.

## Restoration and ownership

Generated code restores temporary field settings before schedules and through a guarded finally path. Runner cleanup and explicit repair use shared guarded restoration helpers. Restore only a field still matching the captured temporary settings; preserve unrelated edits. Repair may restore original missing future schedules only for records still matching original content. It never runs the script, guesses edited intended schedules, recreates desired records or resumes execution.

Preserve confirmed fork ownership using successful request responses and immutable fork metadata. Uncertain responses must retain an unconfirmed ID without assuming ownership. Delete only confirmed owned failed forks unless kept explicitly; never promote automatically. Drain active requests before cleanup.

Execution retains observed-conflict checks because DatoCMS maintenance mode covers only primary and is not an atomic snapshot. No public persistent sandbox freeze is assumed. Generation instead explicitly relies on external write controls. Stop competing writes throughout a run.

Both commands are one-shot. There is no persisted execution journal or resume path. Temporary SQLite files and owned staging files are removed on success/failure; SIGKILL cannot clean up.

## Plugin boundary

All functionality remains inside this CLI plugin using public SDK and CLI utilities. No native command override, private native import, host modification or migration receipt is added. Keep generated files out of native schema-runner discovery. Version-1 simulated artifacts must be regenerated.

## Validation

Execute generated inline and split scripts against stateful CMA mocks and real SDK transport fixtures. Assert call order, real response use, publication/current handling, creation/publication cycles, assets, folders, ordering, baseline refusal, corruption, preflight callback exclusion, cancellation/draining and owned cleanup. Remove tests specific to retired intent simulation rather than retain an unused implementation to satisfy them. Preserve generic planner/capture/storage/download coverage.

Measure bounded memory and subprocess cleanup separately from API throughput. Old live evidence for the retired execution path is not proof for this version. Live writes remain limited to specifically authorized disposable projects.
