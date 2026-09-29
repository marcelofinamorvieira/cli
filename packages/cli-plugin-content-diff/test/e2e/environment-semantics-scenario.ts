import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

export const ENVIRONMENT_SEMANTICS_FAILURE_PATTERN =
  /Incompatible environment activation\/settings:[\s\S]*No content records were read and no migration artifacts were created\.[\s\S]*Align the destination timezone and product-update activations[\s\S]*Schema autogeneration alone may not repair activation mismatches[\s\S]*does not bypass environment compatibility/;

type SemanticsSeed = RealCmaScenarioSeed &
  Readonly<{
    sourceTimezone: string;
  }>;

export const environmentTimezoneMismatchScenario: RealCmaScenario<
  SemanticsSeed,
  void
> = {
  name: 'environment timezone mismatch fails before content reads',
  expectedGenerationFailure: {
    messagePattern: ENVIRONMENT_SEMANTICS_FAILURE_PATTERN,
  },

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating environment-semantics fixture');
    const modelApiKey = semanticsModelApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Environment semantics ${runId}`,
      api_key: modelApiKey,
      singleton: false,
      all_locales_required: false,
      sortable: false,
      modular_block: false,
      draft_mode_active: true,
      draft_saving_active: false,
      tree: false,
      collection_appearance: 'compact',
      inverse_relationships_enabled: false,
    });
    await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const record = await client.items.create({
      item_type: { id: model.id, type: 'item_type' },
      title: 'content must remain unread',
    });
    await client.items.publish(record.id);

    const site = await client.site.find();
    return {
      itemTypeApiKeys: [modelApiKey],
      sourceTimezone: site.timezone,
    };
  },

  async introduceDrift({ seed, destinationClient }) {
    const destinationTimezone =
      seed.sourceTimezone === 'Europe/London'
        ? 'America/New_York'
        : 'Europe/London';
    console.log(
      `[content-diff e2e] Changing only destination timezone to ${destinationTimezone}`,
    );
    await destinationClient.site.update({ timezone: destinationTimezone });
  },
};

function semanticsModelApiKey(runId: string): string {
  const suffix = runId.replace(/[^a-z0-9]/g, '').slice(-12);
  return `cde2e_sem_r${suffix}`;
}
