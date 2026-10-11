import { CmaClientCommand, oclif } from '@datocms/cli-utils';
import { applyContentDiff } from '../../engine/apply';
import {
  ContentError,
  type ContentFailureContext,
  contentErrorReport,
  exitStatus,
  firstDifference,
} from '../../engine/errors';
import type { ApplyOutcome } from '../../engine/types';
import { jsonFailure } from '../../utils/command-helpers';
import { withInterruptHandling } from '../../utils/interruption';

type ClientOptions = Awaited<
  ReturnType<CmaClientCommand['buildBaseClientInitializationOptions']>
>;

export default class ContentApplyCommand extends CmaClientCommand {
  static description =
    'Run a content diff in a new isolated fork of the destination';
  static examples = [
    '<%= config.bin %> <%= command.id %> ./migrations/content/1791559800_sync.diff-records.zip',
    '<%= config.bin %> <%= command.id %> ./migrations/content/1791559800_sync.diff-records.zip --in-place',
    '<%= config.bin %> <%= command.id %> ./migrations/content/1791559800_sync.diff-records.zip --preflight-only',
    '<%= config.bin %> <%= command.id %> ./migrations/content/1791559800_sync.diff-records.zip --fork-name=content-review',
  ];
  static args = {
    FILE: oclif.Args.string({
      description: 'Content diff (.zip) written by content:diff',
      required: true,
    }),
  };
  static flags = {
    destination: oclif.Flags.string({
      description:
        'Apply against this destination environment ID, or "primary", instead of the one the diff was generated for',
    }),
    'preflight-only': oclif.Flags.boolean({
      description:
        'Check the diff and what it touches in the destination without running it or creating a fork',
      exclusive: ['keep-failed-fork'],
      default: false,
    }),
    'fork-name': oclif.Flags.string({
      description:
        'Name of the new fork to create (defaults to content-apply-<seconds>)',
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
        'Run a fast fork. A fast fork reduces processing time, but it also prevents writing to the destination environment during the process',
    }),
    force: oclif.Flags.boolean({
      description:
        'Forces the start of a fast fork, even there are users currently editing records in the environment to copy',
      dependsOn: ['fast-fork'],
    }),
    concurrency: oclif.Flags.integer({
      description:
        'Maximum concurrent check requests (1–16); operations run one at a time',
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
    const { args, flags } = await this.parse(ContentApplyCommand);
    if (!args.FILE.endsWith('.zip'))
      throw new ContentError(
        'INVALID_DIFF_PATH',
        'Pass the .zip diff written by content:diff to content:apply.',
      );
    // Environment IDs go into request paths.
    if (
      flags['fork-name'] !== undefined &&
      !/^[a-z0-9-]+$/.test(flags['fork-name'])
    )
      throw new ContentError(
        'INVALID_FORK_NAME',
        'The fork name can only contain lowercase letters, numbers and dashes.',
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
        this.logToStderr(
          'Interrupted. Waiting for active requests before cleanup.',
        ),
    );
  }

  private async runOperation(signal: AbortSignal): Promise<ApplyOutcome> {
    const { flags, args } = await this.parse(ContentApplyCommand);
    const result = await applyContentDiff({
      rootClient: this.client,
      buildEnvironmentClient: (environment) =>
        this.buildClient({ environment }),
      diffPath: args.FILE,
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
        fastFork: flags['fast-fork'] ?? false,
        force: flags.force ?? false,
        log: (message) => this.logToStderr(message),
      },
    });
    if ('preflightOnly' in result) {
      this.log(
        `Preflight checks passed against environment "${result.environmentId}" for ${result.operations} operations. Nothing was run.`,
      );
      return result;
    }
    this.log(
      `Ran ${result.operations} operations in environment "${result.environmentId}".`,
    );
    return result;
  }

  protected async catch(
    error: Error & ContentFailureContext & { exitCode?: number },
  ): Promise<void> {
    if (this.jsonEnabled()) return this.logJson(jsonFailure(error));
    const report = contentErrorReport(error);
    const notes = [firstDifference(report), error.outcome].filter(
      (note): note is string => Boolean(note),
    );
    if (!notes.length) return super.catch(error);
    // The native handler still runs first: it prints the failure's stack and
    // details, and gives authorization and permission failures their native
    // message, suggestions and exit status. The notes follow the message.
    const native: unknown = await super
      .catch(error)
      .catch((raised: unknown) => raised);
    const base = native instanceof Error && native !== error ? native : error;
    this.error([base.message, ...notes].join('\n'), {
      code: report.code,
      exit: exitStatus(base),
      suggestions: contentErrorReport(base).suggestions,
    });
  }
}
