import { CmaClient, CmaClientCommand, oclif } from '@datocms/cli-utils';
import { writeDump } from '../../engine/dump';
import type { DumpManifest } from '../../engine/dump';
import type { ContentFailureContext } from '../../engine/errors';
import { environmentId } from '../../engine/generation';
import {
  jsonFailure,
  outputPath,
  requestLogLevel,
} from '../../utils/command-helpers';
import { withInterruptHandling } from '../../utils/interruption';

type ContentExportResult = DumpManifest & { dumpPath: string };
type ClientOptions = Awaited<
  ReturnType<CmaClientCommand['buildBaseClientInitializationOptions']>
>;

export default class ContentExportCommand extends CmaClientCommand {
  static description =
    'Export an environment to a project dump: a zip of JSON lines that content:diff can use as its source';
  static examples = [
    '<%= config.bin %> <%= command.id %> backup',
    '<%= config.bin %> <%= command.id %> backup --environment=staging --include-assets --output=./backups',
  ];
  static args = {
    NAME: oclif.Args.string({
      description: 'Name used for the timestamped dump file name',
      default: 'dump',
    }),
  };
  static flags = {
    environment: oclif.Flags.string({
      description: 'Environment ID to export, or "primary"',
      default: 'primary',
    }),
    'include-assets': oclif.Flags.boolean({
      description: 'Also store every asset file in the dump',
      default: false,
    }),
    output: oclif.Flags.string({
      description:
        'Dump .zip file, or directory for a timestamped name (defaults to the current directory)',
    }),
    concurrency: oclif.Flags.integer({
      description: 'Maximum concurrent read requests (1–16)',
      default: 8,
      min: 1,
      max: 16,
    }),
  };

  private path?: Promise<(includesAssets: boolean) => string>;
  private clientOptions?: Promise<ClientOptions>;

  /** The dump's path, checked once. */
  private dumpPath() {
    this.path ??= this.parse(ContentExportCommand).then(({ flags, args }) =>
      outputPath({
        output: flags.output,
        directory: process.cwd(),
        name: args.NAME,
        kind: 'dump',
      }),
    );
    return this.path;
  }

  // CmaClientCommand.init resolves the API token and builds the client, so the
  // command's own option checks run first: a bad name or path fails without
  // authentication or network access.
  protected async init(): Promise<void> {
    await this.dumpPath();
    await super.init();
  }

  // The environment client reuses the options `init` resolved for
  // `this.client`; resolving them again would repeat a linked project's
  // Dashboard request. CmaClientCommand reads any --output as an output
  // format and silences request logs; here --output names the dump.
  protected buildBaseClientInitializationOptions(): Promise<ClientOptions> {
    this.clientOptions ??= (async () => {
      const { flags } = await this.parse(ContentExportCommand);
      return {
        ...(await super.buildBaseClientInitializationOptions()),
        logLevel: requestLogLevel(
          flags as Parameters<typeof requestLogLevel>[0],
          this.datoProfileConfig,
        ),
      };
    })();
    return this.clientOptions;
  }

  async run(): Promise<ContentExportResult> {
    return withInterruptHandling(
      (signal) => this.runOperation(signal),
      () =>
        this.logToStderr(
          'Interrupted. Waiting for active requests and removing the partial dump.',
        ),
    );
  }

  private async runOperation(
    signal: AbortSignal,
  ): Promise<ContentExportResult> {
    const { flags } = await this.parse(ContentExportCommand);
    const path = await this.dumpPath();
    const environments = await this.client.environments.list();
    const id = environmentId(flags.environment, environments);
    const options = await this.buildBaseClientInitializationOptions();
    const dumpPath = path(flags['include-assets']);
    const manifest = await writeDump({
      client: CmaClient.buildClient({ ...options, environment: id }),
      environmentId: id,
      primary: environments.some(
        (environment) => environment.id === id && environment.meta.primary,
      ),
      path: dumpPath,
      includeAssets: flags['include-assets'],
      options: {
        signal,
        concurrency: flags.concurrency,
        progress: (message) => this.logToStderr(message),
      },
    });
    this.log(
      `Project dump: ${dumpPath} (${manifest.counts.records} records, ${manifest.counts.uploads} uploads, ${manifest.counts.uploadCollections} folders)`,
    );
    return { ...manifest, dumpPath };
  }

  protected async catch(
    error: Error & ContentFailureContext & { exitCode?: number },
  ): Promise<void> {
    if (this.jsonEnabled()) return this.logJson(jsonFailure(error));
    return super.catch(error);
  }
}
