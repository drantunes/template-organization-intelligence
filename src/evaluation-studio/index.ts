import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';

import { assertIsolatedEvaluationState, operationalEvaluationExclusions } from '../experiments.js';

const configuredStateDirectory = process.env.ORGANIZATION_EVALUATION_STATE_DIR;
if (!configuredStateDirectory)
  throw new Error('Set ORGANIZATION_EVALUATION_STATE_DIR to an existing isolated experiment directory.');

const stateDirectory = resolve(configuredStateDirectory);
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
await assertIsolatedEvaluationState(stateDirectory, await operationalEvaluationExclusions(projectRoot));
await access(resolve(stateDirectory, 'experiments.db'));

/** Native Studio inspection surface for persisted synthetic datasets and experiment comparisons only. */
export const mastra = new Mastra({
  logger: false,
  server: { host: '127.0.0.1' },
  storage: new LibSQLStore({
    id: 'organization-evaluation-experiments',
    url: `file:${resolve(stateDirectory, 'experiments.db')}`,
  }),
});
