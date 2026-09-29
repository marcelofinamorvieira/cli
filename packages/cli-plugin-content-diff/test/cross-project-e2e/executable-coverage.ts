export type CrossProjectE2EEvidence =
  | Readonly<{
      status: 'live-proven';
      verifiedAt: string;
      command: 'npm run test:e2e:cross-project';
      passingCases: 1;
      failedCases: 0;
      keepEnvironments: false;
      bothPrimariesVerifiedBeforeAndAfter: true;
      suiteSourceSha256: string;
    }>
  | Readonly<{
      status: 'unrun';
      reason: string;
    }>;

/**
 * Change this only after the complete two-project suite passes with cleanup and
 * independent before/after fingerprints for both primary environments.
 */
export const CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE: CrossProjectE2EEvidence = {
  status: 'live-proven',
  verifiedAt: '2026-09-28',
  command: 'npm run test:e2e:cross-project',
  passingCases: 1,
  failedCases: 0,
  keepEnvironments: false,
  bothPrimariesVerifiedBeforeAndAfter: true,
  suiteSourceSha256:
    '13e90c6dcf7870e4fb99de419bdc2d67fa8a6695fa04cda326647c6c588ebc72',
};

export const CROSS_PROJECT_EXECUTABLE_E2E_COVERAGE = [
  {
    spec: 'cross-project.e2e.ts',
    cases: 1,
    summary:
      'Exercises read-only aligned-project generation and destination-only execution with retained and source-only current/published records through four nested block containers, opaque JSON and record references, exact bundled PNG bytes, wrong-project zero mutation, replay, zero-operation regeneration, original sandbox and primary preservation, and cleanup.',
    evidence: CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE,
  },
] as const;
