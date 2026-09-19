import { fileURLToPath } from 'node:url';

import { Mastra } from '@mastra/core/mastra';

import { createOrganizationApplication } from '../application.js';

// Both source and bundled entry points are two levels below the repository root.
const application = await createOrganizationApplication({
  projectRoot: fileURLToPath(new URL('../../', import.meta.url)),
});
export const mastra = new Mastra(application.config);
