import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';

import { catalogSourceSchema } from './source-providers.ts';
export { sourceIdentity } from './source-providers.ts';
export type { CatalogSource } from './source-providers.ts';

const catalogSchema = z.object({
  version: z.literal(1),
  sources: z.array(catalogSourceSchema).min(1),
});

export type SourceCatalog = z.infer<typeof catalogSchema>;

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogValidationError';
  }
}

export function normalizeMountPath(mountPath: string): string {
  if (mountPath.includes('\\') || mountPath.includes('\0')) {
    throw new CatalogValidationError('Mount paths may not contain backslashes or control characters.');
  }
  if (!mountPath.startsWith('/')) throw new CatalogValidationError('Mount paths must begin with /.');
  if (mountPath.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new CatalogValidationError('Mount paths may not contain relative segments.');
  }
  const normalized = normalize(mountPath).replace(/\\/g, '/');
  if (normalized === '/' || normalized.includes('..')) {
    throw new CatalogValidationError('Mount paths must name a contained non-root path.');
  }
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export async function validateCatalog(input: unknown, catalogPath: string): Promise<SourceCatalog> {
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success) throw new CatalogValidationError('Source catalog has an invalid source entry.');
  const sourceCatalog = parsed.data;
  const sourceIds = new Set<string>();
  const mountPaths = new Set<string>();
  const driveRoots = new Set<string>();
  const localRoots = new Set<string>();
  const catalogDirectory = resolve(catalogPath, '..');

  for (const source of sourceCatalog.sources) {
    if (sourceIds.has(source.id)) throw new CatalogValidationError(`Duplicate source id: ${source.id}.`);
    sourceIds.add(source.id);

    const mountPath = normalizeMountPath(source.mountPath);
    if (mountPaths.has(mountPath)) throw new CatalogValidationError(`Duplicate mount path: ${mountPath}.`);
    for (const existingMount of mountPaths) {
      if (mountPath.startsWith(`${existingMount}/`) || existingMount.startsWith(`${mountPath}/`)) {
        throw new CatalogValidationError(`Source mount paths must not overlap: ${existingMount} and ${mountPath}.`);
      }
    }
    mountPaths.add(mountPath);

    if (source.provider === 'local') {
      const sourceRoot = isAbsolute(source.root) ? source.root : resolve(catalogDirectory, source.root);
      source.root = sourceRoot;
      if (!source.enabled) continue;
      try {
        source.root = await realpath(sourceRoot);
        if (!(await stat(source.root)).isDirectory()) throw new Error('Not a directory.');
      } catch {
        throw new CatalogValidationError(`Local source ${source.id} root is inaccessible or is not a directory.`);
      }
      for (const existing of localRoots) {
        if (
          source.root === existing ||
          source.root.startsWith(`${existing}/`) ||
          existing.startsWith(`${source.root}/`)
        ) {
          throw new CatalogValidationError('Local source roots must not overlap.');
        }
      }
      localRoots.add(source.root);
      continue;
    }

    if (driveRoots.has(source.folderId)) {
      throw new CatalogValidationError(`Duplicate Google Drive folder root for source ${source.id}.`);
    }
    driveRoots.add(source.folderId);
  }

  return {
    ...sourceCatalog,
    sources: sourceCatalog.sources.map(source => ({ ...source, mountPath: normalizeMountPath(source.mountPath) })),
  };
}

export async function loadCatalog(catalogPath: string): Promise<SourceCatalog> {
  let content: string;
  try {
    content = await readFile(catalogPath, 'utf8');
  } catch {
    throw new CatalogValidationError(
      'Source catalog could not be read. Check source-catalog.json in the project directory.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CatalogValidationError('Source catalog must be valid JSON.');
  }

  return validateCatalog(parsed, catalogPath);
}

export function validateEnvironment(catalog: SourceCatalog, environment: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  if (!environment.OPENAI_API_KEY?.trim())
    issues.push('OPENAI_API_KEY is required for the default OpenAI local server.');
  const clientEmail = environment.GOOGLE_DRIVE_CLIENT_EMAIL?.trim();
  const privateKey = environment.GOOGLE_DRIVE_PRIVATE_KEY?.trim();
  if ((clientEmail && !privateKey) || (!clientEmail && privateKey)) {
    issues.push('Google Drive credentials are incomplete. Provide both accepted Drive credential settings.');
  }
  if (
    catalog.sources.some(source => source.enabled && source.provider === 'google-drive') &&
    (!clientEmail || !privateKey)
  ) {
    issues.push('Enabled Google Drive sources require both accepted Drive credential settings.');
  }
  return issues;
}
