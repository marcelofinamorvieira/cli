import { CmaClient, CmaClientCommand, oclif } from '@datocms/cli-utils';
import { applyContentMigration } from '../../engine/apply';
import {
  ContentError,
  type ContentFailureContext,
  contentErrorReport,
  describeDestinationDifference,
} from '../../engine/errors';
import type { ApplyOutcome } from '../../engine/types';
import { jsonFailure } from '../../utils/command-helpers';
import { withInterruptHandling } from '../../utils/interruption';

type ClientOptions = Awaited<
  ReturnType<CmaClientCommand['buildBaseClientInitializationOptions']>
>;

export default class ContentApplyCommand extends CmaClientCommand {
  static description =
    'Run a TypeScript content migration in a new isolated destination fork';
  static examples = [
    '<%= config.bin %> <%= command.id %> ./migrations/content/sync.ts',
    '<%= config.bin %> <%= command.id %> ./migrations/content/sync.ts --in-place',
    '<%= config.bin %> <%= command.id %> ./migrations/content/sync.ts --preflight-only',
    '<%= config.bin %> <%= command.id %> ./migrations/content/sync.ts --fork-name=content-review',
  ];
  static args = {
    SCRIPT: oclif.Args.string({
      description: 'TypeScript content migration entrypoint',
      required: true,
    }),
  };
  static flags = {
    destination: oclif.Flags.string({
      description:
        'Apply against this destination environment ID instead of the migration binding',
    }),
    'preflight-only': oclif.Flags.boolean({
      description:
        'Check artifacts, read access and the original destination baseline without executing the script or creating a fork',
      exclusive: ['keep-failed-fork'],
      default: false,
    }),
    'fork-name': oclif.Flags.string({
      description:
        'Name of the new fork to create (defaults to a unique generated name)',
      exclusive: ['in-place'],
    }),
    // No defaults: oclif only enforces `dependsOn` for a flag left unset.
    'in-place': oclif.Flags.boolean({
      description: 'Write directly into the destination environment',
    }),
    'allow-primary': oclif.Flags.boolean({
      description: 'Permit in-place writes to primary',
      dependsOn: ['in-place'],
    }),
    'keep-failed-fork': oclif.Flags.boolean({
      description: 'Keep a fork created by this run after failure',
      default: false,
    }),
    'fast-fork': oclif.Flags.boolean({
      description:
        'Create the fork with a fast fork (the default), which blocks writes to the destination while it copies; use --no-fast-fork for a regular fork',
      default: true,
      allowNo: true,
    }),
    verification: oclif.Flags.custom<'versions' | 'full'>({
      description:
        'Skip rereading records whose version did not change ("versions"), or reread every record in each check ("full")',
      options: ['versions', 'full'],
      default: 'versions',
    })(),
    concurrency: oclif.Flags.integer({
      description:
        'Maximum concurrent baseline read requests (1–16); script calls execute as written',
      default: 8,
      min: 1,
      max: 16,
    }),
  };

  private clientOptions?: Promise<ClientOptions>;

  // CmaClientCommand.init resolves the API token and builds the client, so the
  // command's own option checks run first: a bad flag fails without
  // authentication or network access.
  protected async init(): Promise<void> {
    const { args } = await this.parse(ContentApplyCommand);
    if (!args.SCRIPT.endsWith('.ts'))
      throw new ContentError(
        'INVALID_MIGRATION_PATH',
        'Pass the generated .ts migration entrypoint to content:apply.',
      );
    await super.init();
  }

  // Environment clients reuse the options `init` resolved for `this.client`;
  // resolving them again would repeat a linked project's Dashboard request.
  protected buildBaseClientInitializationOptions(): Promise<ClientOptions> {
    this.clientOptions ??= super.buildBaseClientInitializationOptions();
    return this.clientOptions;
  }

  async run(): Promise<ApplyOutcome> {
    return withInterruptHandling(
      (signal) => this.runOperation(signal),
      () =>
        this.progress(
          'Interrupted. Waiting for active requests before cleanup.',
        ),
    );
  }

  private async runOperation(signal: AbortSignal): Promise<ApplyOutcome> {
    const { flags, args } = await this.parse(ContentApplyCommand);
    const options = await this.buildBaseClientInitializationOptions();
    const result = await applyContentMigration({
      rootClient: this.client,
      buildEnvironmentClient: (environment, fetchFn) =>
        CmaClient.buildClient({
          ...options,
          environment,
          ...(fetchFn ? { fetchFn } : {}),
        }),
      scriptPath: args.SCRIPT,
      options: {
        signal,
        inPlace: flags['in-place'] ?? false,
        allowPrimary: flags['allow-primary'] ?? false,
        keepFailedFork: flags['keep-failed-fork'],
        destinationEnvironmentId: flags.destination,
        ...(flags['fork-name'] !== undefined
          ? { forkName: flags['fork-name'] }
          : {}),
        ...(flags['preflight-only'] ? { preflightOnly: true } : {}),
        concurrency: flags.concurrency,
        fastFork: flags['fast-fork'],
        verification: flags.verification,
        log: (message) => this.progress(message),
      },
    });
    if (!this.jsonEnabled()) {
      if ('preflightOnly' in result) {
        this.log(
          `Preflight checks passed against environment "${result.environmentId}". The script was not executed; edited effects were not previewed.`,
        );
        if (result.partial)
          this.log(
            'Partial migration: generation omitted unsupported content.',
          );
        return result;
      }
      const partial = result.partial
        ? ' (generation omitted unsupported content)'
        : '';
      this.log(
        `Executed content migration in environment "${result.environmentId}"${partial}.`,
      );
    }
    return result;
  }

  protected async catch(
    error: Error & { exitCode?: number | undefined },
  ): Promise<void> {
    if (this.jsonEnabled()) return this.logJson(jsonFailure(error));
    const report = contentErrorReport(error);
    // The baseline message is fixed; the first difference follows it, also
    // when removing the fork failed afterwards.
    const cause = report.details?.cause as
      | { code?: unknown; details?: Record<string, unknown> }
      | undefined;
    const changed =
      report.code === 'DESTINATION_CHANGED'
        ? report.details
        : cause?.code === 'DESTINATION_CHANGED'
          ? cause.details
          : undefined;
    const fork = report.keptForkEnvironmentId;
    const notes = [
      changed && describeDestinationDifference(changed),
      fork && !(error as ContentFailureContext).forkOutcomeStated
        ? `The fork "${fork}" was kept.`
        : undefined,
    ].filter((note): note is string => Boolean(note));
    if (!notes.length) return super.catch(error);
    let { message } = error;
    let { suggestions } = report;
    let exit =
      error.exitCode ??
      (error as Error & { oclif?: { exit?: number } }).oclif?.exit ??
      1;
    if (error instanceof CmaClient.ApiError) {
      // Authorization and permission failures keep the native message,
      // suggestions and exit status; the notes follow the message.
      const raised: unknown = await super
        .catch(error)
        .catch((native) => native);
      if (raised !== error && raised instanceof Error) {
        message = raised.message;
        suggestions = (raised as { suggestions?: string[] }).suggestions;
        exit = (raised as { oclif?: { exit?: number } }).oclif?.exit ?? exit;
      }
    }
    this.error([message, ...notes].join('\n'), {
      code: report.code,
      exit,
      suggestions,
    });
  }

  private progress(message: string): void {
    if (!this.jsonEnabled()) this.logToStderr(message);
  }
}
