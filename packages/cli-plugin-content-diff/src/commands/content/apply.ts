import { oclif } from '@datocms/cli-utils';
import { validateForkName } from '../../engine/apply';
import { ContentError } from '../../engine/errors';
import type { ApplyOutcome, RepairResult } from '../../engine/types';
import { applyContentMigration, repairContentMigration } from '../../migration';
import { ContentCommand, concurrency } from '../../utils/content-command';
import { withInterruptHandling } from '../../utils/interruption';

export default class ContentApplyCommand extends ContentCommand {
  static description =
    'Run a TypeScript content migration in a new isolated destination fork';
  static examples = [
    '<%= config.bin %> <%= command.id %> ./migrations/content/sync.ts',
    '<%= config.bin %> <%= command.id %> ./migrations/content/sync.ts --in-place',
    '<%= config.bin %> <%= command.id %> ./migrations/content/sync.ts --repair',
    '<%= config.bin %> <%= command.id %> ./migrations/content/sync.ts --dry-run',
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
    'dry-run': oclif.Flags.boolean({
      description:
        'Validate the script and preview its rebuilt plan without applying changes or creating a fork',
      exclusive: ['repair', 'keep-failed-fork'],
      default: false,
    }),
    'fork-name': oclif.Flags.string({
      description:
        'Name of the new fork to create (defaults to a unique generated name)',
      exclusive: ['in-place', 'repair'],
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
        'Permit supported temporary validator and default changes required by this migration',
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

  async run(): Promise<ApplyOutcome | RepairResult> {
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
  ): Promise<ApplyOutcome | RepairResult> {
    const { flags, args } = await this.parse(ContentApplyCommand);
    const maximum = concurrency(flags.concurrency);
    validateForkName({
      forkName: flags['fork-name'],
      inPlace: flags['in-place'],
    });
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
    if (!args.SCRIPT.endsWith('.ts'))
      throw new ContentError(
        'INVALID_MIGRATION_PATH',
        'Pass the generated .ts migration entrypoint to content:apply.',
      );
    const endpoint = await this.endpoint();
    if (flags.repair) {
      const repaired = await repairContentMigration({
        rootClient: endpoint.rootClient,
        buildEnvironmentClient: endpoint.buildEnvironmentClient,
        scriptPath: args.SCRIPT,
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
    const result = await applyContentMigration({
      rootClient: endpoint.rootClient,
      buildEnvironmentClient: endpoint.buildEnvironmentClient,
      scriptPath: args.SCRIPT,
      options: {
        signal,
        inPlace: flags['in-place'],
        allowPrimary: flags['allow-primary'],
        keepFailedFork: flags['keep-failed-fork'],
        allowTemporarySchemaChanges: flags['allow-temporary-schema-changes'],
        destinationEnvironmentId: flags.destination,
        ...(flags['fork-name'] !== undefined
          ? { forkName: flags['fork-name'] }
          : {}),
        ...(flags['dry-run'] ? { dryRun: true } : {}),
        concurrency: maximum,
        scheduleWindowMinutes: flags['schedule-window'],
        fastFork: flags['fast-fork'],
        verification: flags.verification,
        log: (message) => this.progress(message),
      },
    });
    if (!this.jsonEnabled()) {
      if ('dryRun' in result && result.dryRun) {
        this.log(
          `Dry run validated against environment "${result.environmentId}". No changes applied.`,
        );
        for (const group of result.groups) {
          const label = group.model
            ? `${group.model.name} (${group.model.apiKey})`
            : group.kind === 'upload'
              ? 'Assets'
              : 'Asset folders';
          const { create, update, delete: deleted, skip } = group.counts;
          this.log(
            `${label}: ${create} create, ${update} update, ${deleted} delete${
              skip ? `, ${skip} skip` : ''
            }.`,
          );
        }
        if (result.groups.length === 0) this.log('No content changes planned.');
        if (result.temporarySchemaChanges)
          this.log(
            `${result.temporarySchemaChanges} temporary field changes required; original settings will be restored during apply.`,
          );
        if (result.partial)
          this.log(
            'Partial migration: generation omitted unsupported content.',
          );
        return result;
      }
      const partial = result.partial
        ? ' from a partial migration; skipped entries were not applied'
        : '';
      this.log(
        `Applied ${result.mutations} mutations in environment "${result.environmentId}"${partial}.`,
      );
    }
    return result;
  }
}
