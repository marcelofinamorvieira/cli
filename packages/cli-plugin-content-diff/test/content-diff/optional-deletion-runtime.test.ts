import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { semanticHash } from '../../src/content-diff/canonicalize';
import { renderRuntime } from '../../src/content-diff/runtime-template';

const RECORD_ID = 'C4xSoA0zT8MrN5oV7uY9Bi';
const MODEL_ID = 'A2vQnY8xR6KpL3mT5sW7Zg';
const RETAINED_PEER = 'E6zUqC2bV0OtP7qX9wA1Dk';
const temporaryDirectories: string[] = [];

describe('strict optional deletion release runtime preflight', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('validates a non-publishing release for a no-draft model', async () => {
    const runtime = await loadRuntime();
    const { context, calls } = makeContext(false, false, false);

    await runtime.verify(context, false);

    expect(calls).to.deep.equal([
      { id: RECORD_ID, body: { peers: [RETAINED_PEER] } },
    ]);
  });

  it('validates a non-publishing release when invalid draft saving is disabled', async () => {
    const runtime = await loadRuntime();
    const { context, calls } = makeContext(true, false, false);

    await runtime.verify(context, false);

    expect(calls).to.have.length(1);
  });

  it('does not require validation for a native invalid-draft release', async () => {
    const runtime = await loadRuntime();
    const { context, calls } = makeContext(true, true, false);

    await runtime.verify(context, false);

    expect(calls).to.deep.equal([]);
  });

  it('defers a relaxed strict release until validators are relaxed', async () => {
    const runtime = await loadRuntime();
    const { context, calls } = makeContext(false, false, true);

    await runtime.verify(context, false);
    expect(calls).to.deep.equal([]);

    await runtime.verify(context, true);
    expect(calls).to.have.length(1);
  });
});

async function loadRuntime(): Promise<{
  verify(context: Record<string, any>, relaxed: boolean): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'datocms-runtime-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'runtime.cjs');
  await writeFile(
    path,
    `${renderRuntime(
      'js',
    )}\nmodule.exports.verify = verifyPublishedDeleteReleases;\n`,
  );
  return createRequire(join(directory, 'loader.cjs'))(path);
}

function makeContext(
  draftModeActive: boolean,
  draftSavingActive: boolean,
  relaxed: boolean,
): {
  context: Record<string, any>;
  calls: Array<{ id: string; body: unknown }>;
} {
  const calls: Array<{ id: string; body: unknown }> = [];
  const fields = { peers: [RETAINED_PEER] };
  const release = {
    recordId: RECORD_ID,
    fields,
    intermediateCurrentHash: semanticHash(fields),
    publish: false,
    transientNestedBlockIds: [],
  };
  const itemType = {
    id: MODEL_ID,
    draftModeActive,
    draftSavingActive,
    fields: [
      {
        id: 'B3wRnZ9yS7LqM4nU6tX8Ah',
        apiKey: 'peers',
        fieldType: 'links',
        localized: false,
        validators: {},
      },
    ],
  };

  return {
    calls,
    context: {
      client: {
        items: {
          validateExisting: async (id: string, body: unknown) => {
            calls.push({ id, body });
          },
        },
      },
      initialRecords: new Map([[RECORD_ID, {}]]),
      recordPlansById: new Map([
        [RECORD_ID, { id: RECORD_ID, itemTypeId: MODEL_ID }],
      ]),
      captureSchemaById: new Map([[MODEL_ID, itemType]]),
      plan: {
        execution: { deleteReleases: [release] },
        invalidContent: {
          validatorRelaxations: relaxed
            ? [{ affectedRecordIds: [RECORD_ID] }]
            : [],
        },
      },
    },
  };
}
