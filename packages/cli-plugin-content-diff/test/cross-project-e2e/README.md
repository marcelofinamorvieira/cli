# Aligned cross-project real-CMA suite

This opt-in suite verifies content migration between two separately
authenticated disposable projects with matching content settings. The fixture
creates identical model, field, and record IDs in both owned sandboxes, so two
blank projects are sufficient. This deliberately aligned fixture does not test
automatic matching of unrelated schemas or record identities.

The suite never creates or deletes projects. It creates sandbox environments in
the supplied projects and removes every owned sandbox unless
`DATOCMS_CONTENT_DIFF_E2E_KEEP=1`. The harness itself checks both primary
environments: before forking it fingerprints each one with an independent
read-only client (site semantics, schema, current and published records
including nested payloads, uploads, and upload collections), and after cleanup
it fingerprints them again. Any difference fails the run. Unlike the
[single-project guard](../e2e/README.md#primary-environment-guard), this check
does not compare the projects' environment inventories or workflows.

**Not live-proven for this revision:** the evidence below predates the
plugin's move into this repository and onto the 6.x DatoCMS clients, so the
offline check that ties it to the current sources fails until the suite passes
again and its new digest is recorded in
[`executable-coverage.ts`](./executable-coverage.ts).

The complete command last passed on **28 September 2026** using **Node 24.18.0**:
**1 passing case, 0 failures**, in approximately 85 seconds, against two blank
disposable projects. `KEEP` was unset, all owned
environments were removed, and the harness's before/after fingerprints of both
primary environments matched. The same case also passed in packaged-build mode,
through a host with the plugin installed from its tarball.

Live proof is recorded in [`executable-coverage.ts`](./executable-coverage.ts),
with executable-source SHA-256
`13e90c6dcf7870e4fb99de419bdc2d67fa8a6695fa04cda326647c6c588ebc72`.
A preliminary same-project fixture acceptance probe is superseded by this full
two-project execution. Offline checks alone do not establish live behavior.

Each scenario has a 25-minute work deadline. The harness cancels and drains
active requests and CLI children before using independent clients for ownership
recovery, cleanup, and final primary verification. CMA jobs already accepted by
the server cannot be rolled back by local cancellation.

Required environment variables:

```bash
export DATOCMS_CONTENT_DIFF_E2E_CROSS_PROJECT=1
export DATOCMS_CONTENT_DIFF_E2E_SOURCE_API_TOKEN=...
export DATOCMS_CONTENT_DIFF_E2E_DESTINATION_API_TOKEN=...
export DATOCMS_CONTENT_DIFF_E2E_SOURCE_PROJECT_ID=...
export DATOCMS_CONTENT_DIFF_E2E_DESTINATION_PROJECT_ID=...
```

Both projects must be test-only and their names must contain the whole word
`e2e`, `test`, `testing`, `disposable`, or `throwaway`. The two project IDs and
tokens must be distinct. Use full-access CMA tokens limited to their respective
projects.

Run from the package root:

```bash
npm run test:e2e:cross-project
```

The single case checks read-only generation in both projects, destination-only
execution without the source token, and wrong-project rejection before mutation.
Its aligned schema has four block models: Modular Content → single block →
Structured Text block → Structured Text inline block. Retained baseline and
source-only records have distinct current/published content and stable nested
IDs. Their leaf fields contain an image, a record reference, and opaque JSON
that resembles embedded content. A destination-only recursive record must remain
unchanged in both versions.

The PNG exists only in the source sandbox and is bundled with `--bundle-assets`.
The oracle compares its bundled and destination bytes directly against the known
fixture bytes, as well as comparing raw nested record attributes and IDs.
Guarded replay, zero-operation regeneration, unchanged original sandboxes,
exact primary fingerprints, and cleanup are required for a passing run.
With `DATOCMS_CONTENT_DIFF_E2E_KEEP=1`,
the owned environment IDs are printed for manual inspection and are not
destroyed.

## Packaged-build mode

By default the harness starts the CLI through `bin/dev` from the checkout's
TypeScript sources. To exercise the installable artifact instead, prepare a
packaged host and select it:

```bash
HOST="$(node scripts/prepare-packaged-host.mjs)"
export DATOCMS_CONTENT_DIFF_E2E_CLI=packaged
export DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST="$HOST"
export OCLIF_COLUMNS=1000
npm run test:e2e:cross-project
```

`OCLIF_COLUMNS=1000` matters in this mode: the packaged launcher prints
errors through oclif's formatter, which wraps them at 80 columns on a pipe
and prefixes every line, so the suite's exact refusal messages would no
longer match. `bin/dev` prints unformatted errors and does not need it.

The host is a fresh consumer project with the workspace's exact `datocms`
version and this plugin added from its tarball with `datocms plugins:add`; the script verifies
that the installed files match the tarball and that `content:diff` and
`migrations:run` are routed to the plugin. Generation, the wrong-project
refusal, destination execution, and regeneration then run through that host's
`datocms` binary with the same per-command credential environments as the
default mode. The host's oclif data, config, and cache directories and XDG base
directories are used for every call, so the global `datocms` plugins are never
touched. The harness refuses a host whose manifest does not record passed
installation and routing checks, whose host version, plugin identity, or
tarball digest does not match, or that was packed from sources that have
since changed. See the
[single-project README](../e2e/README.md#packaged-build-mode) for the prepare
options and `npm run package:check`.

Run it after the single-project real-CMA suite before releasing the plugin.
`npm test` covers the offline validation without either live suite.
