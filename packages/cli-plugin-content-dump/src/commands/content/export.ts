import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CmaClientCommand, oclif } from '@datocms/cli-utils';
import type { DumpManifest } from '../../dump/format';
import { partialPath } from '../../dump/zip';
import { exportEnvironment } from '../../export/export-environment';
import { findEnvironment } from '../../utils/environments';
import { userError } from '../../utils/errors';
import { onInterrupt } from '../../utils/interrupt';

type ExportResult = DumpManifest & { path: string };

export default class ExportCommand extends CmaClientCommand {
  static description =
    "Export an environment's content to a dump file: every record (with its published version and newer draft), upload and upload folder, and optionally every asset file";

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --environment=staging --include-assets --out=./backups/staging.dump.zip',
  ];

  static flags = {
    environment: oclif.Flags.string({
      char: 'e',
      description: 'ID of the environment to export, or "primary"',
      default: 'primary',
    }),
    out: oclif.Flags.string({
      description:
        'Path of the dump file to write (defaults to <environment>-<UTC timestamp>.dump.zip in the current directory)',
    }),
    'include-assets': oclif.Flags.boolean({
      description:
        'Also store the file of every asset, so the dump does not depend on the project serving them',
      default: false,
    }),
  };

  async run(): Promise<ExportResult> {
    const { flags } = await this.parse(ExportCommand);
    const environment = findEnvironment(
      await this.client.environments.list(),
      flags.environment,
    );
    const path = resolve(flags.out ?? defaultFileName(environment.id));
    if (existsSync(path))
      throw userError(
        'OUTPUT_EXISTS',
        `${path} already exists. Choose another --out.`,
      );
    const client = await this.buildClient({ environment: environment.id });
    const stopListening = onInterrupt(
      () => rmSync(partialPath(path), { force: true }),
      'Interrupted: the partial dump was removed.',
    );
    try {
      const manifest = await exportEnvironment({
        client,
        environment,
        path,
        includeAssets: flags['include-assets'],
        progress: (message) => this.logToStderr(message),
      });
      const { records, uploads, uploadCollections } = manifest.counts;
      this.log(
        `Exported ${records} records, ${uploads} uploads and ${uploadCollections} upload folders of environment "${environment.id}" to ${path}`,
      );
      return { path, ...manifest };
    } finally {
      stopListening();
    }
  }
}

/** `<environment>-<UTC timestamp>.dump.zip`, for example `main-20261015T094500Z.dump.zip`. */
function defaultFileName(environment: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  return `${environment}-${timestamp}.dump.zip`;
}
