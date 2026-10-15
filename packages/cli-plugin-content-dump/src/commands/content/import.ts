import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClientCommand, oclif } from '@datocms/cli-utils';
import { openDump } from '../../dump/format';
import { type ImportResult, importDump } from '../../import/import-dump';
import { assertSameSchema } from '../../import/schema-check';
import { readRawSchema, schemaView } from '../../schema';
import { findEnvironment } from '../../utils/environments';
import { userError } from '../../utils/errors';
import { onInterrupt } from '../../utils/interrupt';

/** The model the native migration runner records its migrations in. */
const DEFAULT_TRACKING_MODEL_API_KEY = 'schema_migration';

export default class ImportCommand extends CmaClientCommand {
  static description =
    "Import a dump written by content:export into an empty sandbox environment that has the dump's schema: no records, uploads or upload folders";

  static examples = [
    '<%= config.bin %> <%= command.id %> ./main-20261015T094500Z.dump.zip --environment=restore',
  ];

  static args = {
    DUMP: oclif.Args.string({
      description: 'Path of the dump file',
      required: true,
    }),
  };

  static flags = {
    environment: oclif.Flags.string({
      char: 'e',
      description: 'ID of the empty sandbox environment to import into',
      required: true,
    }),
  };

  async run(): Promise<ImportResult> {
    const { args, flags } = await this.parse(ImportCommand);
    const dump = await openDump(args.DUMP);
    try {
      const environments = await this.client.environments.list();
      const target = findEnvironment(environments, flags.environment);
      if (target.primary)
        throw userError(
          'PRIMARY_ENVIRONMENT',
          `Environment "${target.id}" is the primary environment. content:import writes only into an empty sandbox environment.`,
          [
            `Import into a sandbox environment, then promote it with "datocms environments:promote <sandbox>" once it is ready.`,
          ],
        );
      const client = await this.buildClient({ environment: target.id });
      const trackingModelApiKey =
        this.datoProfileConfig?.migrations?.modelApiKey ??
        DEFAULT_TRACKING_MODEL_API_KEY;
      const schema = schemaView(dump.schema, trackingModelApiKey);
      await assertSameSchema({
        dump,
        expected: schema,
        target: target.id,
        trackingModelApiKey,
        readSchema: async (environment) =>
          readRawSchema(
            environment === target.id
              ? client
              : await this.buildClient({ environment }),
          ),
      });

      const directory = await mkdtemp(
        join(tmpdir(), 'datocms-content-import-'),
      );
      const stopListening = onInterrupt(
        () => rmSync(directory, { recursive: true, force: true }),
        `Interrupted: environment "${target.id}" may hold part of the dump. Destroy it with "datocms environments:destroy ${target.id}" and import into a new empty sandbox environment.`,
      );
      try {
        const result = await importDump({
          dump,
          client,
          environment: target.id,
          schema,
          directory,
          progress: (message) => this.logToStderr(message),
        });
        this.log(summary(result));
        return result;
      } finally {
        stopListening();
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      dump.zip.close();
    }
  }
}

function summary({
  environment,
  counts,
  skippedRecords,
  skippedSchedules,
}: ImportResult): string {
  const lines = [
    `Imported ${counts.records} records (${counts.published} published), ${counts.uploads} uploads and ${counts.uploadCollections} upload folders into environment "${environment}".`,
  ];
  if (skippedRecords)
    lines.push(
      `${skippedRecords} records of the migration tracking model were left out.`,
    );
  if (skippedSchedules)
    lines.push(
      `${skippedSchedules} scheduled publications or unpublishings had already passed and were not recreated.`,
    );
  return lines.join('\n');
}
