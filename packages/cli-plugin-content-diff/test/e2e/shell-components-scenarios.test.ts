import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { RUNTIME_VERSION } from '../../src/content-diff/runtime-template';
import {
  buildShellComponentsApiKey,
  independentRequiredShellComponentsScenario,
} from './shell-components-scenarios';

describe('independent shell-components real-CMA scenario contract', () => {
  it('uses a live-valid isolated model API key', () => {
    const apiKey = buildShellComponentsApiKey('test-run');
    expect(apiKey).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    expect(apiKey).to.have.length.at.most(30);
  });

  it('requires explicit invalid-content migration authorization', () => {
    expect(
      independentRequiredShellComponentsScenario.contentDiffArgs,
    ).to.deep.equal(['--migrate-invalid-content']);
  });
  it('accepts mixed-case component memberships independently of their serialization order', async () => {
    await verifyShellPlan(() => undefined);
    await verifyShellPlan((execution) => {
      execution.shellComponents.reverse();
      for (const component of execution.shellComponents) component.reverse();
    });
  });

  it('rejects wrong component membership even when the overall record set matches', async () => {
    await assert.rejects(
      verifyShellPlan((execution) => {
        const [first, second] = execution.shellComponents;
        [first[1], second[1]] = [second[1], first[1]];
      }),
      /preserve the expected partition/,
    );
  });

  it('rejects creating a downstream component before its upstream dependencies', async () => {
    await assert.rejects(
      verifyShellPlan((execution) => {
        execution.createOrder.reverse();
      }),
      /upstream shell component must be created before its consumers/,
    );
  });
});

async function verifyShellPlan(
  mutate: (execution: {
    shellComponents: string[][];
    shellRecordIds: string[];
    createOrder: string[];
  }) => void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shell-components-oracle-'));
  const planFilePath = join(directory, 'plan.json');
  const first = [`${'Y'.repeat(21)}Q`, `${'Z'.repeat(21)}Q`] as const;
  const second = [`${'a'.repeat(21)}Q`, `${'b'.repeat(21)}Q`] as const;
  const components = [first, second] as const;
  const codepointOrder = components
    .map((component) => [...component].sort())
    .sort((left, right) =>
      left.join(',') < right.join(',')
        ? -1
        : left.join(',') > right.join(',')
          ? 1
          : 0,
    );
  const itemItemType = {
    item_types: ['model'],
    on_publish_with_unpublished_references_strategy: 'fail',
    on_reference_unpublish_strategy: 'delete_references',
    on_reference_delete_strategy: 'delete_references',
  };
  const originalValidators = { item_item_type: itemItemType, required: {} };
  const plan = {
    formatVersion: 10,
    execution: {
      shellComponents: codepointOrder,
      shellRecordIds: components.flat().sort(),
      createOrder: [...first, ...second],
    },
    invalidContent: {
      skippedRecords: [],
      migratedRecordIds: components.flat().sort(),
      validatorRelaxations: [
        {
          fieldId: 'peer-field',
          relaxedValidatorKeys: ['required'],
          originalValidators,
          relaxedValidators: { item_item_type: itemItemType },
        },
      ],
    },
  };
  mutate(plan.execution);
  try {
    await writeFile(
      planFilePath,
      JSON.stringify({
        formatVersion: 10,
        runtimeVersion: RUNTIME_VERSION,
        plan,
      }),
    );
    await independentRequiredShellComponentsScenario.verifyGeneratedPlan!({
      seed: {
        itemTypeApiKeys: ['shell_model'],
        modelId: 'model',
        baselineId: 'baseline',
        peerFieldId: 'peer-field',
        upstreamFieldId: 'upstream-field',
      },
      expected: {
        components,
        source: [],
        destination: [],
        validators: [
          { id: 'peer-field', apiKey: 'peer', validators: originalValidators },
        ],
      },
      sourceClient: {} as never,
      destinationClient: {} as never,
      migrationFilename: 'migration.js',
      migrationFilePath: join(directory, 'migration.js'),
      planFilePath,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
