import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
import type { ContentDiffPlan } from '../../src/content-diff/types';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type ScheduleDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: true };
  };
};

type ScheduleSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    publicationRecordId: string;
    unpublishingRecordId: string;
    unchangedScheduleUpdateRecordId: string;
    unchangedScheduleNoopRecordId: string;
  }>;

type PublicationSchedule = Readonly<{
  at: string;
  contentInLocales: readonly string[] | null;
  nonLocalizedContent: boolean | null;
}>;

type UnpublishingSchedule = Readonly<{
  at: string;
  contentInLocales: readonly string[] | null;
}>;

type ScheduleState = Readonly<{
  publication: PublicationSchedule | null;
  unpublishing: UnpublishingSchedule | null;
}>;

type ScheduleExpected = Readonly<{
  publication: ScheduleState;
  unpublishing: ScheduleState;
  unchangedScheduleUpdate: Readonly<{
    schedule: ScheduleState;
    title: Readonly<{ en: string; it: string }>;
  }>;
  unchangedScheduleNoop: Readonly<{
    schedule: ScheduleState;
    title: Readonly<{ en: string; it: string }>;
  }>;
}>;

export const scheduleScenario: RealCmaScenario<ScheduleSeed, ScheduleExpected> =
  {
    name: 'publication and unpublishing schedules with selective locales',

    async seedSource({ client, runId }) {
      console.log('[content-diff e2e] Creating schedule fixture schema');
      await client.site.update({ locales: ['en', 'it'] });
      const apiKey = `cde2e_schedule_${runId.replace(/-/g, '')}`;
      const model = await client.itemTypes.create({
        name: `Schedule ${runId}`,
        api_key: apiKey,
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
        localized: true,
        validators: { required: {} },
      });
      const publicationRecord = await client.items.create<ScheduleDefinition>({
        item_type: { id: model.id, type: 'item_type' },
        title: { en: 'scheduled publication', it: 'pubblicazione programmata' },
      });
      const unpublishingRecord = await client.items.create<ScheduleDefinition>({
        item_type: { id: model.id, type: 'item_type' },
        title: {
          en: 'scheduled unpublishing',
          it: 'rimozione programmata',
        },
      });
      await client.items.publish<ScheduleDefinition>(unpublishingRecord.id);
      const unchangedScheduleUpdateRecord =
        await client.items.create<ScheduleDefinition>({
          item_type: { id: model.id, type: 'item_type' },
          title: {
            en: 'unchanged schedule baseline',
            it: 'programma invariato iniziale',
          },
        });
      const unchangedScheduleNoopRecord =
        await client.items.create<ScheduleDefinition>({
          item_type: { id: model.id, type: 'item_type' },
          title: {
            en: 'scheduled noop dependency',
            it: 'dipendenza invariata programmata',
          },
        });
      await client.items.publish<ScheduleDefinition>(
        unchangedScheduleNoopRecord.id,
      );

      return {
        itemTypeApiKeys: [apiKey],
        modelId: model.id,
        publicationRecordId: publicationRecord.id,
        unpublishingRecordId: unpublishingRecord.id,
        unchangedScheduleUpdateRecordId: unchangedScheduleUpdateRecord.id,
        unchangedScheduleNoopRecordId: unchangedScheduleNoopRecord.id,
      };
    },

    async introduceDrift({ seed, sourceClient, destinationClient }) {
      console.log('[content-diff e2e] Creating schedule drift');
      const base = Date.now();
      const sourcePublicationAt = new Date(
        base + 48 * 60 * 60 * 1000,
      ).toISOString();
      const sourceUnpublishingAt = new Date(
        base + 72 * 60 * 60 * 1000,
      ).toISOString();
      const destinationPublicationAt = new Date(
        base + 96 * 60 * 60 * 1000,
      ).toISOString();
      const destinationUnpublishingAt = new Date(
        base + 120 * 60 * 60 * 1000,
      ).toISOString();
      const unchangedPublicationAt = new Date(
        base + 144 * 60 * 60 * 1000,
      ).toISOString();
      const unchangedUnpublishingAt = new Date(
        base + 168 * 60 * 60 * 1000,
      ).toISOString();

      await sourceClient.scheduledPublication.create(seed.publicationRecordId, {
        publication_scheduled_at: sourcePublicationAt,
        selective_publication: {
          content_in_locales: ['it'],
          non_localized_content: true,
        },
      });
      await sourceClient.scheduledUnpublishing.create(
        seed.unpublishingRecordId,
        {
          unpublishing_scheduled_at: sourceUnpublishingAt,
          content_in_locales: ['it'],
        },
      );

      await destinationClient.scheduledPublication.create(
        seed.publicationRecordId,
        {
          publication_scheduled_at: destinationPublicationAt,
          selective_publication: null,
        },
      );
      await destinationClient.scheduledUnpublishing.create(
        seed.unpublishingRecordId,
        {
          unpublishing_scheduled_at: destinationUnpublishingAt,
          content_in_locales: null,
        },
      );

      const unchangedPublication = {
        publication_scheduled_at: unchangedPublicationAt,
        selective_publication: {
          content_in_locales: ['en'],
          non_localized_content: true,
        },
      };
      const unchangedUnpublishing = {
        unpublishing_scheduled_at: unchangedUnpublishingAt,
        content_in_locales: ['it'],
      };
      await Promise.all([
        sourceClient.scheduledPublication.create(
          seed.unchangedScheduleUpdateRecordId,
          unchangedPublication,
        ),
        destinationClient.scheduledPublication.create(
          seed.unchangedScheduleUpdateRecordId,
          unchangedPublication,
        ),
        sourceClient.scheduledUnpublishing.create(
          seed.unchangedScheduleNoopRecordId,
          unchangedUnpublishing,
        ),
        destinationClient.scheduledUnpublishing.create(
          seed.unchangedScheduleNoopRecordId,
          unchangedUnpublishing,
        ),
      ]);
      await sourceClient.items.update<ScheduleDefinition>(
        seed.unchangedScheduleUpdateRecordId,
        {
          title: {
            en: 'unchanged schedule desired',
            it: 'programma invariato desiderato',
          },
        },
      );

      return {
        publication: await readScheduleState(
          sourceClient,
          seed.publicationRecordId,
        ),
        unpublishing: await readScheduleState(
          sourceClient,
          seed.unpublishingRecordId,
        ),
        unchangedScheduleUpdate: {
          schedule: await readScheduleState(
            sourceClient,
            seed.unchangedScheduleUpdateRecordId,
          ),
          title: await readTitle(
            sourceClient,
            seed.unchangedScheduleUpdateRecordId,
          ),
        },
        unchangedScheduleNoop: {
          schedule: await readScheduleState(
            sourceClient,
            seed.unchangedScheduleNoopRecordId,
          ),
          title: await readTitle(
            sourceClient,
            seed.unchangedScheduleNoopRecordId,
          ),
        },
      };
    },

    async verifyGeneratedPlan({ seed, planFilePath }) {
      const envelope = JSON.parse(await readFile(planFilePath, 'utf8')) as {
        plan: ContentDiffPlan;
      };
      const update = envelope.plan.records.find(
        ({ id }) => id === seed.unchangedScheduleUpdateRecordId,
      );
      const noop = envelope.plan.records.find(
        ({ id }) => id === seed.unchangedScheduleNoopRecordId,
      );
      assert.ok(update, 'unchanged-schedule update is absent from the plan');
      assert.equal(update.action, 'update');
      assert.equal(update.changes.current, true);
      assert.equal(update.changes.schedules, false);
      assert.ok(noop, 'scheduled noop dependency is absent from the plan');
      assert.equal(noop.action, 'noop');
      assert.equal(noop.changes.schedules, false);
      assert.equal(envelope.plan.requiredPermissions.manageSchedules, true);
      const modelPermission = envelope.plan.requiredPermissions.itemTypes.find(
        ({ id }) => id === seed.modelId,
      );
      assert.ok(modelPermission);
      assert.ok(modelPermission.actions.includes('publish'));
    },

    async verify({ seed, expected, appliedClient }) {
      console.log('[content-diff e2e] Verifying schedule state');
      assert.deepEqual(
        await readScheduleState(appliedClient, seed.publicationRecordId),
        expected.publication,
        'publication schedule did not converge',
      );
      assert.deepEqual(
        await readScheduleState(appliedClient, seed.unpublishingRecordId),
        expected.unpublishing,
        'unpublishing schedule did not converge',
      );
      assert.deepEqual(
        await readScheduleState(
          appliedClient,
          seed.unchangedScheduleUpdateRecordId,
        ),
        expected.unchangedScheduleUpdate.schedule,
        'unchanged publication schedule around a content update did not converge',
      );
      assert.deepEqual(
        await readTitle(appliedClient, seed.unchangedScheduleUpdateRecordId),
        expected.unchangedScheduleUpdate.title,
        'content under an unchanged publication schedule did not converge',
      );
      assert.deepEqual(
        await readScheduleState(
          appliedClient,
          seed.unchangedScheduleNoopRecordId,
        ),
        expected.unchangedScheduleNoop.schedule,
        'noop dependency schedule did not survive global quiescence',
      );
      assert.deepEqual(
        await readTitle(appliedClient, seed.unchangedScheduleNoopRecordId),
        expected.unchangedScheduleNoop.title,
        'noop dependency content changed during global quiescence',
      );
    },
  };

async function readTitle(
  client: CmaClient.Client,
  recordId: string,
): Promise<{ en: string; it: string }> {
  const record = await client.items.find<ScheduleDefinition>(recordId);
  const en = record.title.en;
  const it = record.title.it;
  assert.ok(typeof en === 'string');
  assert.ok(typeof it === 'string');
  return { en, it };
}

async function readScheduleState(
  client: CmaClient.Client,
  recordId: string,
): Promise<ScheduleState> {
  const response = await client.items.rawCurrentVsPublishedState(recordId);
  const publicationId =
    response.data.relationships.scheduled_publication.data?.id ?? null;
  const unpublishingId =
    response.data.relationships.scheduled_unpublishing.data?.id ?? null;
  const publication = publicationId
    ? response.included.find(
        ({ id, type }) =>
          id === publicationId && type === 'scheduled_publication',
      )
    : undefined;
  const unpublishing = unpublishingId
    ? response.included.find(
        ({ id, type }) =>
          id === unpublishingId && type === 'scheduled_unpublishing',
      )
    : undefined;

  if (publicationId && publication?.type !== 'scheduled_publication') {
    throw new Error(
      `scheduled publication ${publicationId} is missing from raw includes`,
    );
  }
  if (unpublishingId && unpublishing?.type !== 'scheduled_unpublishing') {
    throw new Error(
      `scheduled unpublishing ${unpublishingId} is missing from raw includes`,
    );
  }

  return {
    publication:
      publication?.type === 'scheduled_publication'
        ? {
            at: new Date(
              publication.attributes.publication_scheduled_at,
            ).toISOString(),
            contentInLocales:
              publication.attributes.selective_publication
                ?.content_in_locales ?? null,
            nonLocalizedContent:
              publication.attributes.selective_publication
                ?.non_localized_content ?? null,
          }
        : null,
    unpublishing:
      unpublishing?.type === 'scheduled_unpublishing'
        ? {
            at: new Date(
              unpublishing.attributes.unpublishing_scheduled_at,
            ).toISOString(),
            contentInLocales: unpublishing.attributes.content_in_locales,
          }
        : null,
  };
}
