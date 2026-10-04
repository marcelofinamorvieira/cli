import { oclif } from '@datocms/cli-utils';
import { applyBundle } from '../../engine/apply';
import { ContentError } from '../../engine/errors';
import type { ApplyResult } from '../../engine/types';
import { ContentCommand, concurrency } from '../../utils/content-command';
import { withInterruptHandling } from '../../utils/interruption';

export default class ContentApplyCommand extends ContentCommand {
  static description =
    'Apply a content bundle into a new isolated destination fork';
  static examples = [
    '<%= config.bin %> <%= command.id %> ./content-bundle',
    '<%= config.bin %> <%= command.id %> ./content-bundle --in-place',
  ];
  static args = {
    BUNDLE: oclif.Args.string({
      description: 'Complete content bundle directory',
      required: true,
    }),
  };
  static flags = {
    destination: oclif.Flags.string({
      description:
        'Apply against this destination environment ID instead of the bundle binding',
    }),
    'in-place': oclif.Flags.boolean({
      description: 'Write directly into the destination environment',
      default: false,
    }),
    'allow-primary': oclif.Flags.boolean({
      description: 'Permit in-place writes to primary',
      dependsOn: ['in-place'],
      default: false,
    }),
    'keep-failed-fork': oclif.Flags.boolean({
      description: 'Keep a fork created by this run after failure',
      default: false,
    }),
    'allow-temporary-schema-changes': oclif.Flags.boolean({
      description:
        'Permit the exact temporary validator and default changes in the bundle',
      default: false,
    }),
    concurrency: oclif.Flags.integer({
      description: 'Maximum concurrent independent requests (1–16)',
      default: 4,
    }),
  };

  async run(): Promise<ApplyResult> {
    return withInterruptHandling(
      (signal) => this.runOperation(signal),
      () =>
        this.progress(
          'Interrupted. Waiting for active requests before restoration and cleanup.',
        ),
    );
  }

  private async runOperation(signal: AbortSignal): Promise<ApplyResult> {
    const { flags, args } = await this.parse(ContentApplyCommand);
    const maximum = concurrency(flags.concurrency);
    if (flags['allow-primary'] && !flags['in-place'])
      throw new ContentError(
        'INVALID_PRIMARY_AUTHORIZATION',
        '--allow-primary requires --in-place.',
      );
    const endpoint = await this.endpoint();
    const result = await applyBundle({
      rootClient: endpoint.rootClient,
      buildEnvironmentClient: endpoint.buildEnvironmentClient,
      bundlePath: args.BUNDLE,
      options: {
        signal,
        inPlace: flags['in-place'],
        allowPrimary: flags['allow-primary'],
        keepFailedFork: flags['keep-failed-fork'],
        allowTemporarySchemaChanges: flags['allow-temporary-schema-changes'],
        destinationEnvironmentId: flags.destination,
        concurrency: maximum,
        log: (message) => this.progress(message),
      },
    });
    if (!this.jsonEnabled())
      this.log(
        `Applied ${result.mutations} mutations in environment "${result.environmentId}".`,
      );
    return result;
  }
}
