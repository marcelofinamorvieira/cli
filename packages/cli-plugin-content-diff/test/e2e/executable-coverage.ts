/**
 * Executable real-CMA coverage inventory.
 *
 * This is intentionally separate from fixture-matrix.ts. The matrix is a
 * historical design catalog; this file lists only checked-in *.e2e.ts specs
 * that the real-CMA command actually discovers.
 */

export type E2EEvidence =
  | Readonly<{
      status: 'live-proven';
      verifiedAt: string;
      command: 'npm run test:e2e:real-cma';
      passingCases: number;
      pendingCases: number;
      failedCases: 0;
      keepEnvironments: false;
      primaryVerifiedBeforeAndAfter: true;
      suiteSourceSha256: string;
    }>
  | Readonly<{
      status: 'unrun';
      reason: string;
    }>
  | Readonly<{
      status: 'historical-unconstructible';
      reason: string;
    }>;

export type HighRiskClaim =
  | 'asset-bytes-metadata-collections-and-deletion'
  | 'asset-and-seo-validator-relaxation'
  | 'cascade-strategy-ordering-and-boundaries'
  | 'custom-structured-text-children-only-traversal'
  | 'environment-semantic-gating'
  | 'exact-validator-key-relaxation'
  | 'fresh-nested-update-preservation'
  | 'fresh-nested-update-convergence'
  | 'future-publication-and-unpublication-schedules'
  | 'historical-null-after-default-change'
  | 'mutation-free-replay-and-zero-operation-regeneration'
  | 'invalid-current-and-published-content'
  | 'invalid-future-schedule-preservation'
  | 'localized-media-metadata-and-cross-type-defaults'
  | 'maximum-block-count-supported-depth-dast-and-large-payload'
  | 'medium-scale-pagination-and-recursion'
  | 'migrations-run-lock-and-interruption'
  | 'mixed-current-and-published-validity'
  | 'multi-hop-mixed-state-skip-closure'
  | 'no-draft-singleton-create-order'
  | 'optional-create-scc-validation'
  | 'optional-deletion-scc-validation'
  | 'plugin-runner-artifact-execution'
  | 'published-tree-operation-order'
  | 'raw-current-and-published-oracles'
  | 'recursive-container-composition'
  | 'record-lifecycle-states'
  | 'recursive-structured-text-required-cycles'
  | 'required-deletion-scc-preservation'
  | 'sanitized-html-create-and-full-rehydrate-write-guard'
  | 'schema-gating-managed-versus-unrelated-drift'
  | 'selective-publication-locale-membership'
  | 'selective-schedule-validity-slicing'
  | 'same-id-upload-binary-replacement'
  | 'same-byte-upload-rename-authorization'
  | 'shell-component-dependency-order'
  | 'structural-invalid-historical-state'
  | 'transitive-schema-gating-and-presentation-preservation'
  | 'tree-sort-and-workflow-topology'
  | 'typescript-migration-artifact'
  | 'unique-release-swap-and-deletion-boundaries';

export interface ExecutableE2ECoverage {
  /** Exact path relative to test/e2e, as discovered by the recursive Mocha glob. */
  spec: `${string}.e2e.ts`;
  /** Number of declared Mocha cases, including an intentional skip. */
  cases: number;
  summary: string;
  claims: readonly HighRiskClaim[];
  limits: readonly string[];
  evidence: E2EEvidence;
}

/**
 * Change this single value only after the complete glob passes against a
 * disposable project. Source review, focused offline tests, or the mere
 * presence of an E2E spec are not live proof.
 */
export const CURRENT_EXECUTABLE_LIVE_EVIDENCE: E2EEvidence = {
  status: 'live-proven',
  verifiedAt: '2026-09-29',
  command: 'npm run test:e2e:real-cma',
  passingCases: 60,
  pendingCases: 1,
  failedCases: 0,
  keepEnvironments: false,
  primaryVerifiedBeforeAndAfter: true,
  suiteSourceSha256:
    'd5922c98cc7b2b3b12cbd5f52687fd8d84f3f5c841c0b126542e13ff80e851f1',
};

const HISTORICAL_STRUCTURAL_EVIDENCE: E2EEvidence = {
  status: 'historical-unconstructible',
  reason:
    'The current CMA cannot create the excluded-block state and narrows it away when validators change; a curated historical or server-seeded fixture is required.',
};

const executable = (
  entry: Omit<ExecutableE2ECoverage, 'evidence'>,
): ExecutableE2ECoverage => ({
  ...entry,
  evidence: CURRENT_EXECUTABLE_LIVE_EVIDENCE,
});

export const REQUIRED_HIGH_RISK_CLAIMS: readonly HighRiskClaim[] = [
  'asset-bytes-metadata-collections-and-deletion',
  'asset-and-seo-validator-relaxation',
  'cascade-strategy-ordering-and-boundaries',
  'custom-structured-text-children-only-traversal',
  'environment-semantic-gating',
  'exact-validator-key-relaxation',
  'fresh-nested-update-preservation',
  'fresh-nested-update-convergence',
  'future-publication-and-unpublication-schedules',
  'historical-null-after-default-change',
  'mutation-free-replay-and-zero-operation-regeneration',
  'invalid-current-and-published-content',
  'invalid-future-schedule-preservation',
  'localized-media-metadata-and-cross-type-defaults',
  'maximum-block-count-supported-depth-dast-and-large-payload',
  'recursive-container-composition',
  'medium-scale-pagination-and-recursion',
  'migrations-run-lock-and-interruption',
  'mixed-current-and-published-validity',
  'multi-hop-mixed-state-skip-closure',
  'no-draft-singleton-create-order',
  'optional-create-scc-validation',
  'optional-deletion-scc-validation',
  'plugin-runner-artifact-execution',
  'published-tree-operation-order',
  'raw-current-and-published-oracles',
  'record-lifecycle-states',
  'recursive-structured-text-required-cycles',
  'required-deletion-scc-preservation',
  'sanitized-html-create-and-full-rehydrate-write-guard',
  'schema-gating-managed-versus-unrelated-drift',
  'selective-publication-locale-membership',
  'selective-schedule-validity-slicing',
  'same-id-upload-binary-replacement',
  'same-byte-upload-rename-authorization',
  'shell-component-dependency-order',
  'structural-invalid-historical-state',
  'transitive-schema-gating-and-presentation-preservation',
  'tree-sort-and-workflow-topology',
  'typescript-migration-artifact',
  'unique-release-swap-and-deletion-boundaries',
];

export const EXECUTABLE_E2E_COVERAGE: readonly ExecutableE2ECoverage[] = [
  executable({
    spec: 'assets-deletions.e2e.ts',
    cases: 3,
    summary:
      'Bundles source-only upload bytes, converges binary/manual metadata/collections, deletes an unreferenced upload, isolates same-byte stem-rename authorization, and preserves cleared manual fields across EXIF-bearing binary replacement.',
    claims: [
      'asset-bytes-metadata-collections-and-deletion',
      'same-id-upload-binary-replacement',
      'same-byte-upload-rename-authorization',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: ['Deletion coverage is for an unreferenced managed upload.'],
  }),
  executable({
    spec: 'cascade-strategies.e2e.ts',
    cases: 2,
    summary:
      'Exercises managed publish, unpublish, and delete reference cascades plus an external fail-strategy boundary.',
    claims: ['cascade-strategy-ordering-and-boundaries'],
    limits: ['Only the explicitly seeded cascade graph is claimed.'],
  }),
  executable({
    spec: 'advertised-block-limit.e2e.ts',
    cases: 1,
    summary:
      'Migrates 2,000 blocks at the authenticated project-supported depth with published/current drift and exact nested identities.',
    claims: [
      'maximum-block-count-supported-depth-dast-and-large-payload',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: [
      'Requires a disposable project allowing at least 2,000 blocks per record. Does not prove an upload-size limit or every graph at that size.',
    ],
  }),
  executable({
    spec: 'complex-recursive-boundary.e2e.ts',
    cases: 1,
    summary:
      'Migrates 500 blocks at the project-supported depth (four or five, capped at five) with the complete seeded DAST grammar and a record payload of at least 250,000 bytes.',
    claims: [
      'maximum-block-count-supported-depth-dast-and-large-payload',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: [
      'This is one deterministic boundary fixture, not combinatorial proof for every possible block graph.',
    ],
  }),
  executable({
    spec: 'custom-structured-text.e2e.ts',
    cases: 1,
    summary:
      'Traverses custom Structured Text through document children while ignoring reference-shaped sidecar decoys.',
    claims: [
      'custom-structured-text-children-only-traversal',
      'raw-current-and-published-oracles',
    ],
    limits: ['Claims the seeded non-DAST document shape only.'],
  }),
  executable({
    spec: 'environment-semantics.e2e.ts',
    cases: 1,
    summary:
      'Rejects a managed timezone mismatch without artifacts or changes to the captured environment fingerprints.',
    claims: ['environment-semantic-gating'],
    limits: ['This lane covers timezone drift, not every project setting.'],
  }),
  executable({
    spec: 'fresh-nested-lifecycle.e2e.ts',
    cases: 2,
    summary:
      'Creates distinct source-only published/current nested IDs and preserves a destination with an occupied published-only desired current ID.',
    claims: [
      'fresh-nested-update-preservation',
      'fresh-nested-update-convergence',
      'raw-current-and-published-oracles',
    ],
    limits: ['Two bounded nonlocalized single-block lifetimes.'],
  }),
  executable({
    spec: 'fresh-nested-update.e2e.ts',
    cases: 1,
    summary:
      'Converges exact fresh published/current nested IDs from a valid existing destination aggregate.',
    claims: [
      'fresh-nested-update-convergence',
      'raw-current-and-published-oracles',
    ],
    limits: [
      'One nonlocalized single-block field under strict draft validation.',
    ],
  }),
  executable({
    spec: 'historical-null-default.e2e.ts',
    cases: 1,
    summary:
      'Recreates non-localized and localized float nulls after non-null defaults are added, with exact opt-in default suppression and restoration.',
    claims: [
      'historical-null-after-default-change',
      'raw-current-and-published-oracles',
    ],
    limits: ['Cross-type normalized defaults are covered separately.'],
  }),
  executable({
    spec: 'invalid-content.e2e.ts',
    cases: 2,
    summary:
      'Migrates invalid current and published values with exact opt-in relaxations and verifies default fail-closed aggregate skips.',
    claims: [
      'invalid-current-and-published-content',
      'exact-validator-key-relaxation',
      'raw-current-and-published-oracles',
    ],
    limits: ['Validator-family breadth is covered by the gauntlet lane.'],
  }),
  executable({
    spec: 'invalid-schedule-only.e2e.ts',
    cases: 2,
    summary:
      'Preserves invalid aggregates when selective future schedules differ or when the same schedule accompanies a changed invalid current value.',
    claims: ['invalid-future-schedule-preservation'],
    limits: [
      'The safe outcome is preservation rather than schedule convergence.',
    ],
  }),
  executable({
    spec: 'localized-media-defaults.e2e.ts',
    cases: 1,
    summary:
      'Covers localized file, gallery, SEO, video, upload metadata, nested upload references, null/empty/omitted locale distinctions, supported non-string defaults, and exact suppression/restoration for the seven CREATE-time historical null fields.',
    claims: [
      'localized-media-metadata-and-cross-type-defaults',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: [
      'Boolean and text historical nulls are asserted using the CMA-normalized false and empty-text values.',
    ],
  }),
  executable({
    spec: 'medium-scale-recursive.e2e.ts',
    cases: 1,
    summary:
      'Converges 65 paginated records with scalar, localized, lifecycle, ordering, links, and recursive block drift.',
    claims: [
      'medium-scale-pagination-and-recursion',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: [
      'This is a deterministic medium-scale fixture, not a throughput benchmark.',
    ],
  }),
  executable({
    spec: 'mixed-state-skip-closure.e2e.ts',
    cases: 1,
    summary:
      "Propagates a fail-closed skip from invalid A through published B and current-only C, preserves A/C plus A's upload, and independently converges D plus its upload.",
    claims: [
      'multi-hop-mixed-state-skip-closure',
      'raw-current-and-published-oracles',
    ],
    limits: [
      'Claims the seeded three-hop mixed-state dependency chain and one independent aggregate.',
    ],
  }),
  executable({
    spec: 'mixed-validity.e2e.ts',
    cases: 1,
    summary:
      'Recreates records with opposite current/published validity combinations and restores the exact enum validator.',
    claims: [
      'mixed-current-and-published-validity',
      'exact-validator-key-relaxation',
    ],
    limits: ['The validity permutations use one seeded enum-validator model.'],
  }),
  executable({
    spec: 'no-draft-singleton.e2e.ts',
    cases: 1,
    summary:
      'Creates and publishes a source-only dependency before creating its no-draft singleton referrer.',
    claims: ['no-draft-singleton-create-order'],
    limits: ['Claims the seeded singleton dependency graph only.'],
  }),
  executable({
    spec: 'optional-create-validation.e2e.ts',
    cases: 1,
    summary:
      'Creates a three-record optional-reference SCC under an order-dependent size validator with exact opt-in relaxation and restoration.',
    claims: [
      'optional-create-scc-validation',
      'exact-validator-key-relaxation',
    ],
    limits: ['The exercised strict validator is links size.multiple_of.'],
  }),
  executable({
    spec: 'optional-self-cycle.e2e.ts',
    cases: 1,
    summary:
      'Creates a strict two-record optional cycle containing a self-reference, then restores exact self and peer links without invalid-content relaxation.',
    claims: [
      'optional-create-scc-validation',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: [
      'This regression uses draft records with an optional links field and no cardinality validator.',
    ],
  }),
  executable({
    spec: 'optional-deletion-validation.e2e.ts',
    cases: 1,
    summary:
      'Deletes an optional-reference SCC under a strict size validator with exact opt-in relaxation and restoration.',
    claims: [
      'optional-deletion-scc-validation',
      'exact-validator-key-relaxation',
    ],
    limits: ['The exercised strict validator is links size.multiple_of.'],
  }),
  executable({
    spec: 'published-tree.e2e.ts',
    cases: 1,
    summary:
      'Publishes a source-only tree parent-first, then reparents and deletes a destination subtree child-first.',
    claims: [
      'published-tree-operation-order',
      'raw-current-and-published-oracles',
    ],
    limits: ['Claims the seeded tree topology and lifecycle transitions.'],
  }),
  executable({
    spec: 'real-cma-lifecycle.e2e.ts',
    cases: 1,
    summary:
      'Reproduces draft, published, updated, unpublished, and no-draft record states.',
    claims: [
      'record-lifecycle-states',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: ['Selective locale publication is covered separately.'],
  }),
  executable({
    spec: 'real-cma-schedules.e2e.ts',
    cases: 1,
    summary:
      'Reconciles future selective schedules and quiesces/restores unchanged schedules on both changed and noop records.',
    claims: ['future-publication-and-unpublication-schedules'],
    limits: ['Invalid schedule-bearing aggregates are covered separately.'],
  }),
  executable({
    spec: 'real-cma-topology.e2e.ts',
    cases: 1,
    summary: 'Reproduces tree topology, sortable order, and workflow stages.',
    claims: [
      'tree-sort-and-workflow-topology',
      'raw-current-and-published-oracles',
    ],
    limits: ['Claims the seeded topology and workflow transitions.'],
  }),
  executable({
    spec: 'real-cma.e2e.ts',
    cases: 1,
    summary:
      "Runs the basic generated migration through the plugin's own migrations:run, verifies raw CMA state, replays, and regenerates.",
    claims: [
      'plugin-runner-artifact-execution',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: ['This is the portable golden path, not the complex-schema lane.'],
  }),
  executable({
    spec: 'recursive-composition.e2e.ts',
    cases: 2,
    summary:
      'Migrates every ordered pair of the four embedding forms in two locales and distinct current/published slices, using both retained IDs and disjoint baseline/published/current IDs for create and update.',
    claims: [
      'recursive-container-composition',
      'fresh-nested-update-convergence',
      'raw-current-and-published-oracles',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: [
      'Each case uses 46 blocks per owner with alternating depth-five chains. All 1,364 ordered paths through depth five are separately covered offline.',
    ],
  }),
  executable({
    spec: 'recursive-content.e2e.ts',
    cases: 2,
    summary:
      'Exercises a localized published Structured Text-only required cycle with exact relaxation and the default unsafe-cycle skip.',
    claims: [
      'recursive-structured-text-required-cycles',
      'exact-validator-key-relaxation',
      'raw-current-and-published-oracles',
    ],
    limits: ['The two cases use one deterministic required-cycle shape.'],
  }),
  executable({
    spec: 'required-deletion.e2e.ts',
    cases: 2,
    summary:
      'Preserves a destination-only required SCC by default and preserves an opt-in published nested-block SCC that cannot be safely unlinked.',
    claims: ['required-deletion-scc-preservation'],
    limits: ['Both asserted outcomes are preservation, not forced deletion.'],
  }),
  executable({
    spec: 'run-lock.e2e.ts',
    cases: 5,
    summary:
      'Records how the CMA rejects a duplicate lock ID and stores a 255-character lock name, lets only one of two concurrent in-place migrations:run processes execute, refuses content:diff against a locked source or destination, refuses to fork a locked source until --force-unlock clears it, reports a lock copied by a fork, and stops on one SIGINT or exits at once with the printed unlock token on a second.',
    claims: ['migrations-run-lock-and-interruption'],
    limits: [
      'Interruption is exercised with ordinary migrations only; cooperative content-diff runtime checkpoints are covered offline.',
      'Planted locks stand in for crashed runs; stock and older runners, which ignore the lock, are not exercised.',
    ],
  }),
  executable({
    spec: 'sanitized-html-write-guard.e2e.ts',
    cases: 1,
    summary:
      'Rejects active sanitized_html byte rewrites before artifacts for a source-only CREATE and an invalid/full-rehydrate unrelated-field UPDATE.',
    claims: [
      'sanitized-html-create-and-full-rehydrate-write-guard',
      'raw-current-and-published-oracles',
    ],
    limits: [
      'This is an expected-generation-failure lane; the harness proves unchanged source/destination fingerprints and an empty artifact directory, not migration replay.',
    ],
  }),
  executable({
    spec: 'schema-gating.e2e.ts',
    cases: 2,
    summary:
      'Rejects managed validator/default drift before artifacts while allowing unrelated schema drift.',
    claims: ['schema-gating-managed-versus-unrelated-drift'],
    limits: [
      'Transitive fourth-hop and presentation-only drift are covered separately.',
    ],
  }),
  executable({
    spec: 'selective-publication.e2e.ts',
    cases: 1,
    summary:
      'Reproduces exact published locale membership and nonlocalized inclusion while retaining divergent current values.',
    claims: [
      'selective-publication-locale-membership',
      'raw-current-and-published-oracles',
    ],
    limits: ['The fixture uses en, it, and fr with one nonlocalized field.'],
  }),
  executable({
    spec: 'selective-schedule-validity.e2e.ts',
    cases: 1,
    summary:
      'Migrates a provably valid en-only scheduled slice while preserving an it-only invalid slice.',
    claims: [
      'selective-schedule-validity-slicing',
      'raw-current-and-published-oracles',
    ],
    limits: ['Ambiguous validity remains fail-closed and is covered offline.'],
  }),
  executable({
    spec: 'shell-components.e2e.ts',
    cases: 1,
    summary:
      'Preserves a required one-way dependency between independently planned shell SCCs.',
    claims: ['shell-component-dependency-order'],
    limits: ['Claims the seeded two-component dependency graph.'],
  }),
  {
    spec: 'structural-invalid.e2e.ts',
    cases: 1,
    summary:
      'Declares the curated historical structural-invalid fixture requirement as an intentional skip.',
    claims: ['structural-invalid-historical-state'],
    limits: [
      'No live behavior is claimed: the current CMA cannot construct this state.',
    ],
    evidence: HISTORICAL_STRUCTURAL_EVIDENCE,
  },
  executable({
    spec: 'transitive-schema-presentation.e2e.ts',
    cases: 2,
    summary:
      'Rejects content-affecting schema drift at the fourth managed hop and preserves destination presentation metadata during content convergence.',
    claims: ['transitive-schema-gating-and-presentation-preservation'],
    limits: [
      'Claims one four-hop graph and the seeded presentation attributes.',
    ],
  }),
  executable({
    spec: 'typescript-artifact.e2e.ts',
    cases: 1,
    summary:
      "Generates, applies through the plugin's own migrations:run, directly replays, and regenerates a TypeScript migration artifact.",
    claims: [
      'typescript-migration-artifact',
      'plugin-runner-artifact-execution',
      'mutation-free-replay-and-zero-operation-regeneration',
    ],
    limits: ['Uses the portable golden-path content fixture.'],
  }),
  executable({
    spec: 'unique-deletion.e2e.ts',
    cases: 8,
    summary:
      'Covers current/published unique handoffs, cyclic swaps, localized staging, invalid peers, optional deletion SCCs, external referrers, and skipped-owner upload protection.',
    claims: [
      'unique-release-swap-and-deletion-boundaries',
      'exact-validator-key-relaxation',
    ],
    limits: [
      'All cases use the seeded uniqueness and deletion graph families.',
    ],
  }),
  executable({
    spec: 'validator-gauntlet.e2e.ts',
    cases: 2,
    summary:
      'Exercises scalar, date, slug, HTML, upload, image, gallery, SEO, and description validator families with exact restoration and bundled bytes.',
    claims: [
      'exact-validator-key-relaxation',
      'asset-and-seo-validator-relaxation',
      'raw-current-and-published-oracles',
    ],
    limits: [
      'The slug_title_field schema setting is preserved while slug_format is relaxed and restored; slug_title_field is not a separately invalidating content rule.',
    ],
  }),
];

export function executableCoverageByClaim(): ReadonlyMap<
  HighRiskClaim,
  readonly ExecutableE2ECoverage[]
> {
  const result = new Map<HighRiskClaim, ExecutableE2ECoverage[]>();
  for (const entry of EXECUTABLE_E2E_COVERAGE) {
    for (const claim of entry.claims) {
      const entries = result.get(claim) ?? [];
      entries.push(entry);
      result.set(claim, entries);
    }
  }
  return result;
}
