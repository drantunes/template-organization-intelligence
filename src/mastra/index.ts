import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';

import { loadCatalog, validateEnvironment } from '../catalog.js';
import { createSourceRuntime } from '../sources.js';
import { createSourceInspectionWorkflow } from '../workflows/source-inspection.js';

// Both src/mastra and the generated .mastra/output directory are two levels below the project root.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const catalogPath = resolve(projectRoot, 'source-catalog.json');
const ledgerPath = resolve(projectRoot, '.mastra', 'source-identities.json');
const localDatabaseUrl = `file:${resolve(projectRoot, '.mastra', 'organization-intelligence.db')}`;
const catalog = await loadCatalog(catalogPath);
const environmentIssues = validateEnvironment(catalog, process.env);
if (environmentIssues.length) throw new Error(environmentIssues.join(' '));
const sources = await createSourceRuntime({ catalog, catalogPath, ledgerPath });
const sourceInspectionWorkflow = createSourceInspectionWorkflow(sources);

export const mastra = new Mastra({
  logger: false,
  server: { host: '127.0.0.1' },
  storage: new LibSQLStore({ id: 'organization-intelligence-state', url: localDatabaseUrl }),
  workspace: sources.workspace,
  workflows: { sourceInspectionWorkflow },
});
