import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { oclif } from '@datocms/cli-utils';
import { applyBundle, repairBundle } from '../../engine/apply';
import { ContentError } from '../../engine/errors';
import type {
  ApplyResult,
  BundleManifest,
  RepairResult,
} from '../../engine/types';
import { ContentCommand, concurrency } from '../../utils/content-command';
import { withInterruptHandling } from '../../utils/interruption';

export default class ContentApplyCommand extends ContentCommand {
  static description =
    'Apply a content bundle into a new isolated destination fork';
  static examples = [
    '<%= config.bin %> <%= command.id %> ./content-bundle',
    '<%= config.bin %> <%= command.id %> ./content-bundle --in-place',
    '<%= config.bin %> <%= command.id %> ./content-bundle --repair',
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
      description: 'Permit in-place or repair writes to primary',
      default: false,
    }),
    repair: oclif.Flags.boolean({
      description:
        'Restore schedules and field settings left behind by an interrupted in-place apply',
      exclusive: [
        'in-place',
        'keep-failed-fork',
        'allow-temporary-schema-changes',
      ],
      default: false,
    }),
    'schedule-window': oclif.Flags.integer({
      description:
        'Refuse to start when a schedule falls due within this many minutes',
      default: 120,
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
    'fast-fork': oclif.Flags.boolean({
      description:
        'Create the fork with a fast fork, which blocks writes to the destination while it copies',
      default: false,
    }),
    verification: oclif.Flags.custom<'versions' | 'full'>({
      description:
        'Skip rereading records whose version did not change ("versions"), or reread every record in each check ("full")',
      options: ['versions', 'full'],
      default: 'versions',
    })(),
    concurrency: oclif.Flags.integer({
      description: 'Maximum concurrent independent requests (1–16)',
      default: 8,
    }),
  };

  async run(): Promise<ApplyResult | RepairResult> {
    return withInterruptHandling(
      (signal) => this.runOperation(signal),
      () =>
        this.progress(
          'Interrupted. Waiting for active requests before restoration and cleanup.',
        ),
    );
  }

  private async runOperation(
    signal: AbortSignal,
  ): Promise<ApplyResult | RepairResult> {
    const { flags, args } = await this.parse(ContentApplyCommand);
    const maximum = concurrency(flags.concurrency);
    if (flags['allow-primary'] && !flags['in-place'] && !flags.repair)
      throw new ContentError(
        'INVALID_PRIMARY_AUTHORIZATION',
        '--allow-primary requires --in-place or --repair.',
      );
    if (
      !Number.isSafeInteger(flags['schedule-window']) ||
      flags['schedule-window'] < 0
    )
      throw new ContentError(
        'INVALID_SCHEDULE_WINDOW',
        '--schedule-window must be a whole number of minutes, 0 or more.',
      );
    const endpoint = await this.endpoint();
    if (flags.repair) {
      const repaired = await repairBundle({
        rootClient: endpoint.rootClient,
        buildEnvironmentClient: endpoint.buildEnvironmentClient,
        bundlePath: args.BUNDLE,
        options: {
          signal,
          allowPrimary: flags['allow-primary'],
          destinationEnvironmentId: flags.destination,
          log: (message) => this.progress(message),
        },
      });
      if (!this.jsonEnabled())
        this.log(
          `Repaired environment "${repaired.environmentId}": restored ${repaired.restoredSchedules} schedules and ${repaired.restoredFields} field settings.`,
        );
      return repaired;
    }
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
        scheduleWindowMinutes: flags['schedule-window'],
        fastFork: flags['fast-fork'],
        verification: flags.verification,
        log: (message) => this.progress(message),
      },
    });
    if (!this.jsonEnabled()) {
      const partial = result.partial ? await partialSummary(args.BUNDLE) : '';
      this.log(
        `Applied ${result.mutations} mutations in environment "${result.environmentId}"${partial}.`,
      );
    }
    return result;
  }
}

/** Describes how many entries an applied partial bundle skipped. */
async function partialSummary(bundlePath: string): Promise<string> {
  try {
    const { counts } = JSON.parse(
      await readFile(join(bundlePath, 'manifest.json'), 'utf8'),
    ) as BundleManifest;
    const skipped = Object.values(counts).reduce(
      (total, actions) => total + actions.skip,
      0,
    );
    return ` from a partial bundle; ${skipped} skipped ${
      skipped === 1 ? 'entry was' : 'entries were'
    } not applied`;
  } catch {
    // The manifest was verified before any write; this summary is optional.
    return ' from a partial bundle; its skipped entries were not applied';
  }
}
