# DatoCMS content bundles

Compare content across DatoCMS environments, export a reviewable bundle, and apply it into an isolated destination fork. This plugin adds `content:diff` and `content:apply`; schema migrations continue to use the normal DatoCMS CLI commands.

Requires Node.js 22.13+ on the 22.x line, or Node.js 24+. Install the plugin in the DatoCMS CLI:

```sh
datocms plugins:install @datocms/cli-plugin-content-diff
```

## Generate a bundle

```sh
datocms content:diff \
  --source=staging \
  --destination=primary \
  --output=./content-bundle
```

`--source` accepts an environment ID or `primary`. `--destination` defaults to `primary`. The output must be a new directory. Generation checks source and destination schema compatibility, captures their complete content namespaces, and rejects an inconsistent capture. `--item-types` limits changes to selected model API keys; other destination records provide dependency and preservation evidence.

| Flag | Default | Behavior |
| --- | --- | --- |
| `--item-types=article,page` | `all` | Select regular model API keys for content changes. |
| `--uploads=referenced` | `referenced` | Include assets referenced by selected content, or use `all`. |
| `--include-deletions` | Off | Plan safe destination-only deletions within the selected scope. |
| `--allow-partial` | Off | Permit only proven isolated skips and their dependency closure. |
| `--allow-temporary-schema-changes` | Off | Plan supported temporary validator/default changes. |
| `--concurrency=4` | `4` | Bound independent requests to a value from 1 to 16. |
| `--chunk-bytes=4194304` | `4194304` | Set the target JSONL chunk size. One oversized entry occupies its own chunk. |

Unsafe requested changes fail generation by default. Partial mode does not bypass incompatible schemas, incomplete access proofs, or execution conflicts. Legacy/nonportable identifiers and unsupported lifecycle states are diagnosed during planning. DatoCMS computes validity flags asynchronously; the plugin preserves content and publication state, while the restored schema determines final validity. Known field-validation failures require an explicit, narrowly scoped temporary change.

Native file/gallery metadata that the CMA client cannot safely preserve is rejected before writes. This includes reserved keys such as `__proto__` and `__itemTypeId`, and metadata objects with `type: "item"`. These strings remain safe inside a JSON field's serialized JSON text. Existing unsupported values can remain unchanged. A scheduled invalid draft is rejected when its schedule cannot be recreated under the intended final schema.

Asset folders include labels, parent hierarchy, and exact positions. Plans account for DatoCMS's sibling renumbering when folders move. Conflicting sibling names or transitions that cannot preserve the intended hierarchy and order are diagnosed before writes; partial mode can skip only their isolated dependency closure.

Block IDs can be reused only where DatoCMS permits them in the current record version. Unsafe ownership changes and block recreation that would substitute defaults without declared suppression are diagnosed before writes.

Integer fields, integer defaults, and integer-valued validator settings must stay within JavaScript's safe integer range (±9,007,199,254,740,991). Larger values are rejected before comparison or writes to prevent rounding by the CMA client's JSON parser. Floating-point fields retain their normal number semantics, and JSON fields remain opaque serialized text.

Use the DatoCMS CLI's `--profile`, `--api-token`, linked-project OAuth authentication, and configured token environment variables. To compare different projects, select both endpoint profiles:

```sh
datocms content:diff \
  --source=main --destination=main \
  --source-profile=source-project \
  --destination-profile=target-project \
  --output=./content-bundle
```

`--source-api-token` and `--destination-api-token` override their respective profile authentication. Paired profiles cannot be combined with `--profile` or `--api-token`. Both projects must have aligned managed schemas and compatible public IDs.

## Review and apply

Review `manifest.json` and the `plan/*.jsonl` entries before applying. Changed entries contain complete baseline and desired states. Unchanged entries contain fingerprints and the metadata needed to preserve dependencies, publication, ordering, and schedules. Required new/replacement upload binaries are downloaded and checked during generation.

```sh
datocms content:apply ./content-bundle --profile=target-project
```

Apply verifies the manifest, JSONL chunks, asset binaries, destination project binding, schema, and complete baseline before content writes. By default it creates a new isolated destination fork and reports the resulting environment ID. It never promotes the fork automatically. `--destination=ENVIRONMENT_ID` selects an alternative destination only if it satisfies the bundle's full baseline and binding checks.

| Flag | Behavior |
| --- | --- |
| `--in-place` | Apply directly to the selected destination environment. |
| `--allow-primary` | Additionally authorize in-place primary writes; requires `--in-place`. |
| `--keep-failed-fork` | Keep a fork created by this run if execution fails. |
| `--allow-temporary-schema-changes` | Permit the exact temporary validator/default changes recorded in the bundle. |
| `--concurrency=4` | Bound independent writes to a value from 1 to 16. Dependent writes retain their required order. |

Existing managed schedules are temporarily cancelled before content changes and exact desired future schedules are restored after verification. Temporary field settings are restored before success. In-place failures attempt to restore original schedules and temporary settings; failures report repair problems. Failed forks created by the run are removed unless explicitly retained. Pre-existing environments are never deleted.

DatoCMS provides no public persistent sandbox write freeze. Maintenance mode applies only to primary and does not create an immutable snapshot or transaction. Capture validation, live guards during execution, and full final verification detect observed conflicts, but another writer can still change data between a check and its following write. Run generation and application while competing writes are stopped.

## Bundle format and lifecycle

A complete bundle contains a small checksummed `manifest.json`, a streamed checksummed `chunks.jsonl` index, deterministic byte-bounded JSONL plan chunks, and checksummed asset files referenced by upload entries. Integrity checks reject unsafe relative paths, symlinks, duplicate identities, malformed executable states, and changed bytes. Bundles are content exports and exclude client authentication credentials.

Generation and application are one-shot operations. Temporary SQLite databases and staging files are removed on completion or failure. Completed bundles survive application and can be retained as exports. The format does not accept progress files, checkpoints, or temporary databases as inputs. Previous unreleased generated migration/runtimes are unsupported.

SIGINT and SIGTERM stop queued work, wait for submitted CMA operations to settle, and run the same restoration and cleanup as other failures. Cleanup can take time while a CMA operation is pending. Forced process termination, such as SIGKILL or a machine shutdown, cannot run cleanup; inspect the destination before starting a new operation.

Both commands support `--json` and the standard CLI logging flags. Authentication credentials are redacted from request logs and surfaced errors.

## Development

```sh
npm run build
npm run typecheck
npm test
npm run package:check
```

The local suites use bounded mock and file fixtures to verify capture, dependencies, bundle integrity, execution, CLI routing, failure handling, and cleanup. Record and upload reads use bounded pages and temporary SQLite storage. Schema and upload-collection endpoints return their metadata as whole lists; destructive dependency guards also use the CMA’s unpaginated reference endpoints, which must be empty before removal. Large-project throughput and memory limits have not been experimentally established by these checks.
