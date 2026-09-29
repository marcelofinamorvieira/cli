import { runInNewContext } from 'node:vm';
import { expect } from 'chai';
import { CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION as RUNNER_PROTOCOL_VERSION } from '../../src/commands/migrations/run';
import { GENERATED_RUNTIME_SHARED_SOURCE } from '../../src/content-diff/generated/runtime-shared';
import { SAFELY_RELAXABLE_VALIDATOR_KEYS as PLAN_RELAXABLE_VALIDATOR_KEYS } from '../../src/content-diff/plan';
import {
  RUNTIME_VERSION,
  CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION as TEMPLATE_PROTOCOL_VERSION,
  renderRuntime,
} from '../../src/content-diff/runtime-template';
import * as contract from '../../src/content-diff/shared/contract';
import {
  CONTENT_DIFF_MAPPING_FIELD_API_KEY,
  CONTENT_DIFF_MAPPING_NAME_FIELD_API_KEY,
  CONTENT_DIFF_MAPPING_RECORD_MAX_BYTES,
  CONTENT_PLAN_FORMAT_VERSION,
  DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
  LEGACY_ID_MAPPING_FORMAT_VERSION,
} from '../../src/content-diff/types';
import { CONTENT_DIFF_MAPPING_MODEL_API_KEY } from '../../src/utils/environments-diff/fetch-schema';

/** Every value the shared contract exports, with Sets as sorted arrays. */
function comparable(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      value instanceof Set ? [...value].sort() : value,
    ]),
  );
}

describe('shared contract constants', () => {
  it('pins the runtime, protocol, plan, manifest, and ledger contract values', () => {
    expect(comparable({ ...contract })).to.deep.equal({
      CONTENT_DIFF_RUNTIME_VERSION: '17',
      CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION: 1,
      CONTENT_DIFF_PLAN_VERSION: 10,
      CONTENT_DIFF_MANIFEST_VERSION: 10,
      LEGACY_ID_MAPPING_FORMAT_VERSION: 1,
      LEGACY_ID_MAPPING_MODEL_API_KEY: 'datocms_content_diff',
      LEGACY_ID_MAPPING_MODEL_NAME: 'Content diff',
      LEGACY_ID_MAPPING_NAME_FIELD_API_KEY: 'name',
      LEGACY_ID_MAPPING_NAME_FIELD_LABEL: 'Name',
      LEGACY_ID_MAPPING_FIELD_API_KEY: 'mapping',
      LEGACY_ID_MAPPING_FIELD_LABEL: 'Mapping',
      LEGACY_ID_MAPPING_MAX_DOCUMENT_BYTES: 131_072,
      LEGACY_ID_MAPPING_ENTITY_TYPES: [
        'block',
        'record',
        'upload',
        'upload_collection',
      ],
      SAFELY_RELAXABLE_VALIDATOR_KEYS: [
        'date_range',
        'date_time_range',
        'description_length',
        'enum',
        'extension',
        'file_size',
        'format',
        'image_aspect_ratio',
        'image_dimensions',
        'length',
        'number_range',
        'required',
        'required_alt_title',
        'required_seo_fields',
        'sanitized_html',
        'size',
        'slug_format',
        'slug_title_field',
        'title_length',
        'unique',
      ],
      RELAXABLE_VALIDATOR_KEYS: [...contract.SAFELY_RELAXABLE_VALIDATOR_KEYS],
    });
    expect(contract.RELAXABLE_VALIDATOR_KEYS.size).to.equal(
      contract.SAFELY_RELAXABLE_VALIDATOR_KEYS.length,
    );
  });

  it('gives the emitted runtime exactly the planner values', () => {
    const names = Object.keys(contract);
    const emitted = runInNewContext(
      `${GENERATED_RUNTIME_SHARED_SOURCE}\n({ ${names
        .map(
          (name) =>
            `${name}: ${name} instanceof Set ? [...${name}].sort() : ${name}`,
        )
        .join(', ')} })`,
    ) as Record<string, unknown>;

    // JSON round trip: values built in the vm realm have foreign prototypes.
    expect(JSON.parse(JSON.stringify(emitted))).to.deep.equal(
      comparable({ ...contract }),
    );
  });

  it('keeps the planner names as aliases of the shared values', () => {
    expect(RUNTIME_VERSION).to.equal(contract.CONTENT_DIFF_RUNTIME_VERSION);
    expect(TEMPLATE_PROTOCOL_VERSION).to.equal(
      contract.CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
    );
    expect(RUNNER_PROTOCOL_VERSION).to.equal(
      contract.CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
    );
    expect(CONTENT_PLAN_FORMAT_VERSION).to.equal(
      contract.CONTENT_DIFF_PLAN_VERSION,
    );
    expect(LEGACY_ID_MAPPING_FORMAT_VERSION).to.equal(
      contract.LEGACY_ID_MAPPING_FORMAT_VERSION,
    );
    expect(DEFAULT_CONTENT_DIFF_MODEL_API_KEY).to.equal(
      contract.LEGACY_ID_MAPPING_MODEL_API_KEY,
    );
    expect(CONTENT_DIFF_MAPPING_MODEL_API_KEY).to.equal(
      contract.LEGACY_ID_MAPPING_MODEL_API_KEY,
    );
    expect(CONTENT_DIFF_MAPPING_NAME_FIELD_API_KEY).to.equal(
      contract.LEGACY_ID_MAPPING_NAME_FIELD_API_KEY,
    );
    expect(CONTENT_DIFF_MAPPING_FIELD_API_KEY).to.equal(
      contract.LEGACY_ID_MAPPING_FIELD_API_KEY,
    );
    expect(CONTENT_DIFF_MAPPING_RECORD_MAX_BYTES).to.equal(
      contract.LEGACY_ID_MAPPING_MAX_DOCUMENT_BYTES,
    );
    expect(PLAN_RELAXABLE_VALIDATOR_KEYS).to.equal(
      contract.SAFELY_RELAXABLE_VALIDATOR_KEYS,
    );
  });

  it('exports the shared runtime version from both runtime formats', () => {
    expect(renderRuntime('js')).to.match(
      /\nconst CONTENT_DIFF_RUNTIME_VERSION = '17';\n[\s\S]*\nmodule\.exports = \{\n {2}RUNTIME_VERSION: CONTENT_DIFF_RUNTIME_VERSION,\n/,
    );
    expect(renderRuntime('ts')).to.match(
      /\nconst CONTENT_DIFF_RUNTIME_VERSION = '17';\n[\s\S]*\nexport \{ CONTENT_DIFF_RUNTIME_VERSION as RUNTIME_VERSION, runContentDiffMigration \};\n$/,
    );
  });
});
