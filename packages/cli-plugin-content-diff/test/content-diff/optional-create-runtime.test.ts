import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { semanticHash } from '../../src/content-diff/canonicalize';
import { renderRuntime } from '../../src/content-diff/runtime-template';

const ANCHOR_ID = 'C4xSoA0zT8MrN5oV7uY9Bi';
const FIRST_ID = '-40RNzgBSJaJsXiLSYhtVA';
const SECOND_ID = 'XSPMXvayT-yMUrVxP-YoSw';
const THIRD_ID = 'YhEa5SbeSl6KwIFizzkzig';
const MODEL_ID = '4QI3BfBvQs-hcv_YEkk1wg';
const FIELD_ID = 'B3wRnZ9yS7LqM4nU6tX8Ah';
const temporaryDirectories: string[] = [];

describe('strict optional create-seed runtime preflight', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('preflights every resolvable relaxed seed with its exact create body', async () => {
    const runtime = await loadRuntime();
    const { context, calls } = makeContext();

    await runtime.verify(context, true);

    expect(calls).to.deep.equal([
      {
        item_type: { id: MODEL_ID, type: 'item_type' },
        peers: [ANCHOR_ID],
      },
      {
        item_type: { id: MODEL_ID, type: 'item_type' },
        peers: [ANCHOR_ID],
      },
    ]);
  });

  it('fails before any create when the relaxed exact seed remains invalid', async () => {
    const runtime = await loadRuntime();
    const { context, mutations } = makeContext(
      new Error('size remains invalid'),
    );

    try {
      await runtime.verify(context, true);
    } catch (error) {
      expect(error).to.have.property('code', 'CREATE_SEED_VALIDATION_FAILURE');
      expect(error).to.have.nested.property('details.recordId', FIRST_ID);
      expect(mutations).to.deep.equal([]);
      return;
    }

    throw new Error('Expected relaxed create-seed preflight to fail');
  });

  it('defers a seed with a planned earlier dependency, then validates it exactly just in time', async () => {
    const runtime = await loadRuntime();
    const { context, calls } = makeContext();
    const second = context.recordPlansById.get(SECOND_ID);
    second.desired.current = version({
      peers: [ANCHOR_ID, FIRST_ID, THIRD_ID],
    });
    second.desired.published = version({
      peers: [ANCHOR_ID, FIRST_ID, THIRD_ID],
    });

    await runtime.verifyOne(context, second, true);
    expect(calls).to.deep.equal([]);

    await runtime.verifyOne(context, second, false);
    expect(calls).to.deep.equal([
      {
        item_type: { id: MODEL_ID, type: 'item_type' },
        peers: [ANCHOR_ID, FIRST_ID],
      },
    ]);
  });
});

async function loadRuntime(): Promise<{
  verify(context: Record<string, any>, early: boolean): Promise<void>;
  verifyOne(
    context: Record<string, any>,
    recordPlan: Record<string, any>,
    early: boolean,
  ): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'datocms-runtime-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'runtime.cjs');
  await writeFile(
    path,
    `${renderRuntime(
      'js',
    )}\nmodule.exports.verify = verifyRelaxedCreateSeeds;\nmodule.exports.verifyOne = verifyOneRelaxedCreateSeed;\n`,
  );
  return createRequire(join(directory, 'loader.cjs'))(path);
}

function makeContext(validateError?: Error): {
  context: Record<string, any>;
  calls: unknown[];
  mutations: string[];
} {
  const calls: unknown[] = [];
  const mutations: string[] = [];
  const desired = {
    [FIRST_ID]: version({ peers: [ANCHOR_ID, SECOND_ID] }),
    [SECOND_ID]: version({ peers: [ANCHOR_ID, THIRD_ID] }),
    [THIRD_ID]: version({ peers: [ANCHOR_ID, FIRST_ID] }),
  };
  const records = [FIRST_ID, SECOND_ID, THIRD_ID].map((id) => ({
    id,
    itemTypeId: MODEL_ID,
    action: 'create',
    baseline: null,
    desired: {
      current: desired[id as keyof typeof desired],
      published: desired[id as keyof typeof desired],
    },
  }));
  const itemType = {
    id: MODEL_ID,
    draftModeActive: true,
    draftSavingActive: false,
    fields: [
      {
        id: FIELD_ID,
        apiKey: 'peers',
        fieldType: 'links',
        localized: false,
        validators: {
          items_item_type: { item_types: [MODEL_ID] },
          size: { min: 0, multiple_of: 2 },
        },
      },
    ],
  };

  return {
    calls,
    mutations,
    context: {
      client: {
        items: {
          validateNew: async (body: unknown) => {
            calls.push(body);
            if (validateError) throw validateError;
          },
          create: async () => {
            mutations.push('create');
          },
        },
      },
      plan: {
        records,
        execution: {
          createOrder: [FIRST_ID, SECOND_ID, THIRD_ID],
          shellRecordIds: [],
          shellComponents: [],
        },
        invalidContent: {
          validatorRelaxations: [
            {
              fieldId: FIELD_ID,
              affectedRecordIds: [FIRST_ID, SECOND_ID],
            },
          ],
        },
      },
      schemaById: new Map([[MODEL_ID, itemType]]),
      captureSchemaById: new Map([[MODEL_ID, itemType]]),
      recordPlansById: new Map(records.map((record) => [record.id, record])),
      initialRecords: new Map(records.map((record) => [record.id, null])),
    },
  };
}

function version(fields: Record<string, unknown>) {
  return { fields, hash: semanticHash(fields) };
}
