import type { CmaClient } from '@datocms/cli-utils';
import { userError } from './errors';

export interface EnvironmentChoice {
  id: string;
  primary: boolean;
}

/** The environment named by its ID, or by "primary". */
export function findEnvironment(
  environments: CmaClient.ApiTypes.Environment[],
  requested: string,
): EnvironmentChoice {
  const environment = environments.find((candidate) =>
    requested === 'primary'
      ? candidate.meta.primary
      : candidate.id === requested,
  );
  if (!environment)
    throw userError(
      'ENVIRONMENT_NOT_FOUND',
      `Environment "${requested}" does not exist in this project.`,
    );
  return { id: environment.id, primary: environment.meta.primary };
}
