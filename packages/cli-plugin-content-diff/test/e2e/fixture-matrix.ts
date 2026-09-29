/**
 * Historical declarative fixture design catalog. It includes aspirational and
 * currently out-of-scope lanes, so it must not be used as evidence of
 * executable or live coverage. See executable-coverage.ts for that inventory.
 * Nothing in this module imports content-diff implementation code.
 */

export const FIRST_LIVE_LANE_ID = 'golden_portable_basic' as const;

export type FixtureFeature =
  | 'portable_ids'
  | 'localized_scalar'
  | 'localized_reference'
  | 'missing_locale_key'
  | 'link'
  | 'links'
  | 'record_cycle'
  | 'rich_text'
  | 'single_block'
  | 'structured_text_block'
  | 'structured_text_inline_block'
  | 'structured_text_inline_item'
  | 'structured_text_item_link'
  | 'recursive_blocks'
  | 'block_ownership'
  | 'draft'
  | 'published'
  | 'updated'
  | 'no_draft_mode'
  | 'selective_publication'
  | 'tree'
  | 'sortable'
  | 'workflow_stage'
  | 'scheduled_publication'
  | 'scheduled_unpublishing'
  | 'selective_schedule_locales'
  | 'upload'
  | 'upload_metadata'
  | 'localized_upload_metadata'
  | 'gallery'
  | 'seo_upload'
  | 'upload_collection'
  | 'destination_only_content'
  | 'record_deletion'
  | 'upload_deletion'
  | 'delete_retention_boundary'
  | 'invalid_content'
  | 'validator_relaxation'
  | 'structural_invalidity'
  | 'skip_propagation'
  | 'legacy_record_id'
  | 'legacy_block_id'
  | 'legacy_upload_id'
  | 'legacy_upload_collection_id'
  | 'typed_reference_rewrite'
  | 'ledger_append_only'
  | 'ledger_multichunk'
  | 'ledger_tamper_rejection'
  | 'ledger_lifecycle'
  | 'schema_exclusion'
  | 'navigation_isolation'
  | 'role_permission_exclusion'
  | 'tracking_model_collision'
  | 'idempotent_rerun';

export type FixtureOutcome =
  | 'converges'
  | 'converges_with_skips'
  | 'generation_rejects'
  | 'runtime_rejects';

export interface FixtureRunOptions {
  includeDeletions: boolean;
  includeInvalidContent: boolean;
  bundleAssets: boolean;
  expectedOutcome: FixtureOutcome;
}

export interface FixtureLane {
  id: string;
  title: string;
  priority: 'smoke' | 'core' | 'extended' | 'negative';
  features: FixtureFeature[];
  /** Stable symbolic handles that setup code should resolve to real CMA IDs. */
  fixtureKeys: string[];
  source: string[];
  destination: string[];
  run: FixtureRunOptions;
  oracle: string[];
  rerun: string[];
}

export const REQUIRED_FIXTURE_FEATURES: readonly FixtureFeature[] = [
  'portable_ids',
  'localized_scalar',
  'localized_reference',
  'missing_locale_key',
  'link',
  'links',
  'record_cycle',
  'rich_text',
  'single_block',
  'structured_text_block',
  'structured_text_inline_block',
  'structured_text_inline_item',
  'structured_text_item_link',
  'recursive_blocks',
  'block_ownership',
  'draft',
  'published',
  'updated',
  'no_draft_mode',
  'selective_publication',
  'tree',
  'sortable',
  'workflow_stage',
  'scheduled_publication',
  'scheduled_unpublishing',
  'selective_schedule_locales',
  'upload',
  'upload_metadata',
  'localized_upload_metadata',
  'gallery',
  'seo_upload',
  'upload_collection',
  'destination_only_content',
  'record_deletion',
  'upload_deletion',
  'delete_retention_boundary',
  'invalid_content',
  'validator_relaxation',
  'structural_invalidity',
  'skip_propagation',
  'legacy_record_id',
  'legacy_block_id',
  'legacy_upload_id',
  'legacy_upload_collection_id',
  'typed_reference_rewrite',
  'ledger_append_only',
  'ledger_multichunk',
  'ledger_tamper_rejection',
  'ledger_lifecycle',
  'schema_exclusion',
  'navigation_isolation',
  'role_permission_exclusion',
  'tracking_model_collision',
  'idempotent_rerun',
];

export const FIXTURE_MATRIX: readonly FixtureLane[] = [
  {
    id: FIRST_LIVE_LANE_ID,
    title: 'Portable-ID draft/published golden path',
    priority: 'smoke',
    features: [
      'portable_ids',
      'link',
      'draft',
      'published',
      'updated',
      'destination_only_content',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'model.article',
      'record.source.published',
      'record.source.draft',
      'record.destination.preserved',
    ],
    source: [
      'Create one draft-mode article model with nonlocalized title:string, body:text, and related:link fields.',
      'Publish one record, update its current body, and keep one second record draft-only; link the updated record to the draft.',
    ],
    destination: [
      'Fork the environment before source mutations, then add one destination-only record outside the managed record selection.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Capture selected source and destination records through raw current and published item-list slices.',
      'Compare normalized id/itemTypeId/title/body/related values and sorted slice ID sets.',
      'Merge the expected managed state with the destination-only record and prove it is retained.',
      'Confirm the reserved legacy ledger is absent and was not created for a zero-legacy run.',
    ],
    rerun: [
      'Apply the same migration again and require zero CMA mutations.',
      'Regenerate from the converged environments and require an empty content plan.',
    ],
  },
  {
    id: 'localized_all_field_shapes',
    title: 'Localized scalars, references, uploads, and missing keys',
    priority: 'core',
    features: [
      'localized_scalar',
      'localized_reference',
      'missing_locale_key',
      'link',
      'links',
      'upload',
      'localized_upload_metadata',
      'rich_text',
      'single_block',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'model.localized_page',
      'record.localized.en_it_fr',
      'upload.localized.hero',
    ],
    source: [
      'Use project locales en, it, fr with localized string/text/link/links/file/gallery/rich_text/single_block fields.',
      'Mix null values, empty arrays, explicit empty strings, and omitted locale keys; keep fr absent on selected fields.',
      'Give the localized file different alt/title/custom_data/focal_point per locale.',
    ],
    destination: [
      'Seed stale it values and extra fr keys so removal and null-versus-omission semantics are exercised.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Compare locale-key presence as well as values in raw attributes.',
      'Resolve every typed record, block, and upload reference per locale.',
      'Compare localized upload metadata without treating key order as semantic.',
    ],
    rerun: [
      'Require byte-stable normalized raw state and zero second-run mutations.',
    ],
  },
  {
    id: 'links_and_cycles',
    title: 'Optional links, link arrays, cycles, and dependency shells',
    priority: 'core',
    features: [
      'link',
      'links',
      'record_cycle',
      'draft',
      'no_draft_mode',
      'validator_relaxation',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'model.node.draft',
      'model.node.no_draft',
      'record.cycle.a',
      'record.cycle.b',
      'record.self_link',
    ],
    source: [
      'Create A to B to A and self-link cycles using both link and ordered links fields.',
      'Repeat the dependency shape on a no-draft model whose required link must be relaxed during shell creation.',
    ],
    destination: ['Seed reversed links order and a stale optional link.'],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Require exact links array order and exact current/published membership.',
      'Require all references to resolve after temporary cycle-shell creation.',
    ],
    rerun: ['Require validators restored and no residual shell/null state.'],
  },
  {
    id: 'recursive_block_cross_product',
    title: 'Recursively nested rich text, single blocks, and Structured Text',
    priority: 'core',
    features: [
      'rich_text',
      'single_block',
      'structured_text_block',
      'structured_text_inline_block',
      'structured_text_inline_item',
      'structured_text_item_link',
      'recursive_blocks',
      'block_ownership',
      'localized_reference',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'model.block.container',
      'model.block.leaf',
      'record.recursive.en_it',
      'block.root',
      'block.middle',
      'block.leaf',
    ],
    source: [
      'Create rich_text to single_block to Structured Text block to rich_text nesting, plus the reverse direction.',
      'Put block, inlineBlock, inlineItem, and itemLink DAST nodes in the same document and localize two branches.',
      'Use unique block IDs per owner field and locale; include ordinary URL strings resembling IDs as controls.',
    ],
    destination: [
      'Seed stale nested blocks, reorder modular blocks, and move no block ID across an owner slot.',
    ],
    run: {
      includeDeletions: true,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Recursively walk nested raw item resources and DAST nodes independent of plugin canonicalization.',
      'Require every block ID to have exactly one owner field/locale slot.',
      'Compare typed node references after ID remapping while preserving ordinary text and URL values.',
    ],
    rerun: [
      'Require identical block ownership and no create/update/delete calls.',
    ],
  },
  {
    id: 'publication_state_matrix',
    title:
      'Current, published, updated, draft-only, no-draft, and selective publication',
    priority: 'core',
    features: [
      'draft',
      'published',
      'updated',
      'no_draft_mode',
      'selective_publication',
      'localized_scalar',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'record.state.draft',
      'record.state.published',
      'record.state.updated',
      'record.state.no_draft',
      'record.state.selective',
    ],
    source: [
      'Create one record for each lifecycle state and an en/it/fr record with only en+it published.',
      'For updated state, diverge current values from the published version.',
    ],
    destination: ['Seed each record in a different wrong lifecycle state.'],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Compare raw current and published slices separately.',
      'Compare status/validity/timestamps only through explicit lifecycle expectations, not volatile version IDs.',
      'Require selective published locales to match exactly.',
    ],
    rerun: ['Require no extra versions and no publication mutations.'],
  },
  {
    id: 'topology_workflow_and_order',
    title: 'Trees, sortable collections, and workflow stages',
    priority: 'extended',
    features: [
      'tree',
      'sortable',
      'workflow_stage',
      'destination_only_content',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'model.tree',
      'model.sortable',
      'workflow.editorial',
      'stage.review',
      'stage.ready',
    ],
    source: [
      'Create a three-level tree with ordered siblings and a separate sortable collection.',
      'Assign draft records to distinct workflow stages.',
    ],
    destination: [
      'Move a child, reverse sibling/order positions, change stages, and add an unmanaged sibling.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Compare parent relationships, sibling order, collection position, and stage IDs.',
      'Require destination-only topology to remain valid and retained.',
    ],
    rerun: ['Require topology and stages unchanged on replay.'],
  },
  {
    id: 'schedules_and_selective_locales',
    title: 'Publication and unpublishing schedules with locale selection',
    priority: 'extended',
    features: [
      'scheduled_publication',
      'scheduled_unpublishing',
      'selective_schedule_locales',
      'selective_publication',
      'localized_scalar',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'record.schedule.publish_all',
      'record.schedule.publish_selective',
      'record.schedule.unpublish_all',
      'record.schedule.unpublish_selective',
    ],
    source: [
      'Use fixed future instants and cover no job, publication only, unpublishing only, and both jobs.',
      'Mix all-locales jobs with en+it locale selections and nonLocalized true/false.',
    ],
    destination: [
      'Seed wrong instants, swapped job types, and different locale selections.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Read current-vs-published raw includes and compare normalized UTC instants plus selective locale sets.',
      'Require obsolete jobs cancelled and desired jobs created exactly once.',
    ],
    rerun: [
      'Require schedule IDs may differ but semantic jobs and mutation count remain stable.',
    ],
  },
  {
    id: 'uploads_collections_and_metadata',
    title: 'Upload bytes, metadata, field overrides, and collection topology',
    priority: 'core',
    features: [
      'upload',
      'upload_metadata',
      'localized_upload_metadata',
      'gallery',
      'seo_upload',
      'upload_collection',
      'destination_only_content',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'collection.root',
      'collection.child',
      'upload.image',
      'upload.video',
      'upload.document',
      'record.media_fields',
    ],
    source: [
      'Create nested ordered upload collections and image/video/document uploads with fixed byte fixtures.',
      'Vary basename/filename, tags, author, copyright, notes, alt/title/custom_data/focal_point, and localized field metadata.',
      'Reference uploads from file, gallery, SEO, and nested block fields.',
    ],
    destination: [
      'Seed equal bytes with stale metadata, different bytes under another ID, stale collection placement, and destination-only assets.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: true,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Hash independently downloaded fixture bytes and compare raw upload md5/size/mime/metadata/tags.',
      'Compare collection parent/children/position and every upload relationship.',
      'Require destination-only uploads and collections to remain.',
    ],
    rerun: [
      'Require no reupload, metadata update, or collection reorder on replay.',
    ],
  },
  {
    id: 'deletions_and_retention_boundaries',
    title: 'Managed deletions versus retained external references',
    priority: 'core',
    features: [
      'record_deletion',
      'upload_deletion',
      'delete_retention_boundary',
      'destination_only_content',
      'link',
      'record_cycle',
      'upload_collection',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'record.delete.leaf',
      'record.delete.cycle_a',
      'record.delete.cycle_b',
      'record.retain.external_referrer',
      'upload.delete.unused',
      'collection.retain.empty',
    ],
    source: [
      'Omit records/uploads present in the forked destination and include an internal deletion cycle.',
      'Keep upload collections absent from source deletion semantics.',
    ],
    destination: [
      'Add an unmanaged draft and a published record referring to a deletion candidate.',
      'Reference one upload from unmanaged content and leave another truly unused.',
    ],
    run: {
      includeDeletions: true,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'generation_rejects',
    },
    oracle: [
      'Prove publication-boundary deletion rejection before artifact application.',
      'In a safe subcase, require dependency-ordered record deletion, unused upload deletion, and collection retention.',
    ],
    rerun: [
      'Safe subcase must converge with no missing-reference cleanup on replay.',
    ],
  },
  {
    id: 'invalid_content_default_skip',
    title: 'Invalid aggregate skip propagation and reservation hygiene',
    priority: 'core',
    features: [
      'invalid_content',
      'skip_propagation',
      'legacy_record_id',
      'legacy_block_id',
      'ledger_append_only',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'record.invalid.root',
      'block.invalid.descendant',
      'record.valid.depends_on_invalid',
      'record.valid.independent',
    ],
    source: [
      'Create invalid current and published aggregates, including a nested invalid block and a dependent valid record.',
      'Use legacy numeric IDs inside the skipped aggregate and a portable independent record.',
    ],
    destination: [
      'Keep stale copies of skipped records and a divergent independent record.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'converges_with_skips',
    },
    oracle: [
      'Require one explicit diagnostic per root skip and transitive dependency skip.',
      'Require the independent record to converge while every skipped aggregate stays untouched.',
      'Require no ledger source/target claim or orphan target reservation for skipped legacy entities.',
    ],
    rerun: ['Require the same deterministic diagnostics and zero mutations.'],
  },
  {
    id: 'invalid_content_relaxation',
    title: 'Relaxable validators versus structural invalidity',
    priority: 'extended',
    features: [
      'invalid_content',
      'validator_relaxation',
      'structural_invalidity',
      'record_cycle',
      'recursive_blocks',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'field.required',
      'field.unique',
      'field.length',
      'field.reference_validator',
      'record.invalid.relaxable',
      'record.invalid.structural',
    ],
    source: [
      'Separate required/unique/length failures needed for shells from wrong-shape, missing-model, and duplicate-block-owner failures.',
      'Include a cyclic no-draft dependency whose required relationship is temporarily relaxed.',
    ],
    destination: [
      'Start with exact source schema validators and no helper records.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: true,
      bundleAssets: false,
      expectedOutcome: 'generation_rejects',
    },
    oracle: [
      'Safe subcase must relax only allowlisted validators and restore byte-equivalent validator JSON.',
      'Structural-invalid subcase must fail closed before mutations or ledger writes.',
    ],
    rerun: [
      'Safe subcase must show restored schema and zero content mutations.',
    ],
  },
  {
    id: 'legacy_full_graph',
    title: 'Legacy numeric IDs across a recursively typed content graph',
    priority: 'core',
    features: [
      'legacy_record_id',
      'legacy_block_id',
      'legacy_upload_id',
      'legacy_upload_collection_id',
      'typed_reference_rewrite',
      'recursive_blocks',
      'structured_text_inline_item',
      'structured_text_item_link',
      'ledger_append_only',
      'ledger_multichunk',
      'ledger_lifecycle',
      'schema_exclusion',
      'idempotent_rerun',
    ],
    fixtureKeys: [
      'legacy.record.1',
      'legacy.block.2',
      'legacy.upload.3',
      'legacy.collection.4',
      'legacy.graph.large_batch',
    ],
    source: [
      'Use canonical decimal IDs at 0, ordinary, and maximum 281474976710655 boundaries for records, blocks, uploads, and collections.',
      'Reference them through link/links/file/gallery/SEO, rich_text/single_block, and all Structured Text typed node kinds.',
      'Create enough aliases to force multiple canonical ledger chunks.',
    ],
    destination: [
      'Prove each raw legacy source ID is absent in destination before mapping and seed unrelated portable IDs.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: true,
      expectedOutcome: 'converges',
    },
    oracle: [
      'Read aliases only from exact reserved ledger records and remap expected source raw state independently.',
      'Require every typed reference to target the mapped ID and ordinary string occurrences to remain unchanged.',
      'Require complete sequential chunks, wholeHash integrity, exact projectId, exact draft-only lifecycle, and no source/target namespace collisions.',
    ],
    rerun: [
      'Require existing ledger record hashes unchanged and no duplicate aliases.',
      'Require an exact partial-prefix retry to append only missing planned chunks, followed by zero mutations.',
    ],
  },
  {
    id: 'legacy_collision_preflight',
    title: 'Raw legacy source-ID and generated target collision rejection',
    priority: 'negative',
    features: [
      'legacy_record_id',
      'legacy_block_id',
      'legacy_upload_id',
      'legacy_upload_collection_id',
      'ledger_tamper_rejection',
      'typed_reference_rewrite',
    ],
    fixtureKeys: [
      'collision.raw_source_item',
      'collision.raw_source_upload',
      'collision.mapped_target',
      'collision.ledger_record',
    ],
    source: ['Expose one numeric ID in each entity namespace.'],
    destination: [
      'Occupy the same raw item/upload/collection ID in separate subcases and occupy a deterministic generated target ID.',
      'Make an item target collide with a reserved ledger record ID.',
    ],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'generation_rejects',
    },
    oracle: [
      'Require preflight rejection before artifacts or mutations for raw source-ID occupancy.',
      'Require runtime rejection if target occupancy changes between generation and apply.',
    ],
    rerun: [
      'Not applicable: rejected runs must leave destination and ledger byte-identical.',
    ],
  },
  {
    id: 'ledger_schema_and_tamper_negative',
    title: 'Reserved ledger, schema exclusion, and tamper fail-closed matrix',
    priority: 'negative',
    features: [
      'ledger_append_only',
      'ledger_multichunk',
      'ledger_tamper_rejection',
      'ledger_lifecycle',
      'schema_exclusion',
      'navigation_isolation',
      'role_permission_exclusion',
      'tracking_model_collision',
    ],
    fixtureKeys: [
      'model.reserved.ledger',
      'model.reserved.migrations_tracking',
      'ledger.batch.valid',
      'ledger.batch.tampered',
    ],
    source: [
      'Start from one exact ledger model/batch, then independently mutate every model/field/default/appearance/relationship/lifecycle/chunk/hash/projectId/name contract.',
      'Add custom menu/filter/schema-menu parent or child, inbound validators, role permissions, and migrations tracking-model collisions as separate subcases.',
    ],
    destination: ['Clone the valid control before each one-variable mutation.'],
    run: {
      includeDeletions: false,
      includeInvalidContent: false,
      bundleAssets: false,
      expectedOutcome: 'generation_rejects',
    },
    oracle: [
      'Valid control must be excluded from managed schema and roles while schema-menu positions compact around it.',
      'Every drift/tamper subcase must fail closed before environment fork, tracking upsert, content mutation, or ledger append.',
      'Existing ledger record canonical bytes and SHA-256 hashes must never change.',
    ],
    rerun: [
      'Valid append must preserve the old record hash set and add only complete new batches.',
    ],
  },
];

export function fixtureLane(id: string): FixtureLane {
  const lane = FIXTURE_MATRIX.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`Unknown content-diff E2E fixture lane: ${id}`);
  return lane;
}

export function fixtureCoverage(): Map<FixtureFeature, string[]> {
  const result = new Map<FixtureFeature, string[]>();
  for (const lane of FIXTURE_MATRIX) {
    for (const feature of lane.features) {
      result.set(feature, [...(result.get(feature) ?? []), lane.id]);
    }
  }
  return result;
}

export function assertFixtureMatrixComplete(): void {
  const laneIds = new Set<string>();
  for (const lane of FIXTURE_MATRIX) {
    if (laneIds.has(lane.id))
      throw new Error(`Duplicate fixture lane: ${lane.id}`);
    laneIds.add(lane.id);
    if (
      lane.features.length === 0 ||
      lane.fixtureKeys.length === 0 ||
      lane.source.length === 0 ||
      lane.destination.length === 0 ||
      lane.oracle.length === 0 ||
      lane.rerun.length === 0
    ) {
      throw new Error(`Fixture lane ${lane.id} is incomplete.`);
    }
    if (
      new Set(lane.features).size !== lane.features.length ||
      new Set(lane.fixtureKeys).size !== lane.fixtureKeys.length
    ) {
      throw new Error(
        `Fixture lane ${lane.id} contains duplicate declarations.`,
      );
    }
  }
  if (!laneIds.has(FIRST_LIVE_LANE_ID)) {
    throw new Error('The first live golden-path fixture lane is missing.');
  }
  const coverage = fixtureCoverage();
  const missing = REQUIRED_FIXTURE_FEATURES.filter(
    (feature) => !coverage.has(feature),
  );
  if (missing.length > 0) {
    throw new Error(`Fixture matrix misses: ${missing.join(', ')}`);
  }
}
