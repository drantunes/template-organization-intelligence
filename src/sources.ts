import { relative, resolve } from 'node:path';

import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import type { AnyWorkspace, WorkspaceFilesystem } from '@mastra/core/workspace';
import { GoogleDriveFilesystem } from '@mastra/google-drive';
import type { GoogleDriveFilesystemOptions } from '@mastra/google-drive';

import type { CatalogSource, SourceCatalog } from './catalog.js';
import { normalizeMountPath, validateCatalog } from './catalog.js';
import { ScopedDriveReader } from './drive-source.js';
import type { DriveAccessToken } from './drive-source.js';
import { validateAndPersistSourceIdentity } from './identity-ledger.js';

const GOOGLE_DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const MAX_INSPECTION_BYTES = 64 * 1024;

type SourceStatus = 'available' | 'configured' | 'unavailable';
type SourceFilesystem = WorkspaceFilesystem;
type DriveFilesystemFactory = (options: GoogleDriveFilesystemOptions) => WorkspaceFilesystem;

export type SourceInspection = {
  sourceId: string;
  mountPath: string;
  status: SourceStatus;
  content?: string;
  error?: string;
};

export type SourceRuntime = {
  catalog: SourceCatalog;
  workspace: AnyWorkspace;
  driveReaders: Map<string, ScopedDriveReader>;
  inspect: (sourceId: string, relativePath: string) => Promise<SourceInspection>;
  sourceStatuses: () => Array<Omit<SourceInspection, 'content'>>;
};

type Credentials = { clientEmail: string; privateKey: string } | undefined;

function configuredDriveCredentials(environment: NodeJS.ProcessEnv): Credentials {
  const clientEmail = environment.GOOGLE_DRIVE_CLIENT_EMAIL?.trim();
  const privateKey = environment.GOOGLE_DRIVE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (!clientEmail && !privateKey) return undefined;
  if (!clientEmail || !privateKey)
    throw new Error('Google Drive credentials are incomplete. Provide both accepted Drive credential settings.');
  return { clientEmail, privateKey };
}

function safeError(source: CatalogSource): string {
  return source.provider === 'google-drive'
    ? `Source ${source.id} is unavailable. Confirm its configured credentials and folder access.`
    : `Source ${source.id} is unavailable. Confirm its configured local root.`;
}

function safeRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    relativePath.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    throw new Error('Requested path must be a non-empty path contained within its source mount.');
  }
  return relativePath;
}

function mountedPath(source: CatalogSource, relativePath: string): string {
  return `${normalizeMountPath(source.mountPath)}/${safeRelativePath(relativePath)}`;
}

function localRoot(source: Extract<CatalogSource, { provider: 'local' }>, catalogPath: string): string {
  return resolve(catalogPath, '..', source.root);
}

function freezeCatalog(catalog: SourceCatalog): SourceCatalog {
  for (const source of catalog.sources) Object.freeze(source);
  Object.freeze(catalog.sources);
  return Object.freeze(catalog);
}

export async function createSourceRuntime(options: {
  catalog: SourceCatalog;
  catalogPath: string;
  ledgerPath: string;
  environment?: NodeJS.ProcessEnv;
  driveFilesystemFactory?: DriveFilesystemFactory;
  driveAccessToken?: DriveAccessToken;
  driveRequest?: typeof fetch;
}): Promise<SourceRuntime> {
  const environment = options.environment ?? process.env;
  const catalog = freezeCatalog(await validateCatalog(options.catalog, options.catalogPath));
  const enabledSources = catalog.sources.filter(source => source.enabled);
  const credentials = configuredDriveCredentials(environment);
  if (enabledSources.some(source => source.provider === 'google-drive') && !credentials) {
    throw new Error('Enabled Google Drive sources require both accepted Drive credential settings.');
  }
  await validateAndPersistSourceIdentity(options.ledgerPath, enabledSources);
  const filesystems = new Map<string, SourceFilesystem>();
  const statuses = new Map<string, SourceStatus>();
  const mounts: Record<string, SourceFilesystem> = {};
  const driveReaders = new Map<string, ScopedDriveReader>();
  const getAccessToken =
    options.driveAccessToken ?? (credentials ? ScopedDriveReader.serviceAccount(credentials) : undefined);

  for (const source of enabledSources) {
    const mountPath = normalizeMountPath(source.mountPath);
    if (source.provider === 'local') {
      const filesystem = new LocalFilesystem({
        id: source.id,
        basePath: localRoot(source, options.catalogPath),
        contained: true,
        readOnly: true,
      });
      await filesystem.init();
      filesystems.set(source.id, filesystem);
      mounts[mountPath] = filesystem;
      statuses.set(source.id, 'available');
      continue;
    }

    const driveOptions: GoogleDriveFilesystemOptions = {
      id: source.id,
      folderId: source.folderId,
      readOnly: true,
      getAccessToken,
      serviceAccount: credentials
        ? {
            clientEmail: credentials.clientEmail,
            privateKey: credentials.privateKey,
            scopes: [GOOGLE_DRIVE_READONLY_SCOPE],
          }
        : undefined,
    };
    const filesystem = options.driveFilesystemFactory?.(driveOptions) ?? new GoogleDriveFilesystem(driveOptions);
    if (getAccessToken)
      driveReaders.set(source.id, new ScopedDriveReader(source.folderId, getAccessToken, options.driveRequest));
    filesystems.set(source.id, filesystem);
    mounts[mountPath] = filesystem;
    if (options.driveFilesystemFactory) {
      try {
        await filesystem.init?.();
        statuses.set(source.id, 'available');
      } catch {
        statuses.set(source.id, 'unavailable');
      }
    } else {
      statuses.set(source.id, credentials ? 'configured' : 'unavailable');
    }
  }

  const workspace = new Workspace({
    id: 'organization-intelligence-sources',
    mounts,
    tools: { enabled: false },
  });

  return {
    catalog,
    workspace,
    driveReaders,
    sourceStatuses: () =>
      enabledSources.map(source => ({
        sourceId: source.id,
        mountPath: normalizeMountPath(source.mountPath),
        status: statuses.get(source.id) ?? 'unavailable',
        ...(statuses.get(source.id) === 'unavailable' ? { error: safeError(source) } : {}),
      })),
    inspect: async (sourceId, relativePath) => {
      const source = enabledSources.find(candidate => candidate.id === sourceId);
      const filesystem = filesystems.get(sourceId);
      if (!source || !filesystem) throw new Error('Requested source is not active in the startup catalog.');
      const path = mountedPath(source, relativePath);

      if (source.provider === 'local') {
        const root = localRoot(source, options.catalogPath);
        const resolved = resolve(root, relativePath);
        if (relative(root, resolved).startsWith('..')) {
          throw new Error('Requested path must be contained within its source mount.');
        }
      }

      try {
        if (source.provider === 'google-drive' && statuses.get(source.id) !== 'available') {
          await filesystem.init?.();
          statuses.set(source.id, 'available');
        }
        const workspaceFilesystem = workspace.filesystem;
        if (!workspaceFilesystem) throw new Error('Configured source mounts are unavailable.');
        const metadata = await workspaceFilesystem.stat(path);
        if (metadata.size > MAX_INSPECTION_BYTES) {
          return {
            sourceId,
            mountPath: normalizeMountPath(source.mountPath),
            status: 'available',
            error: `Record exceeds the ${MAX_INSPECTION_BYTES / 1024} KiB inspection limit.`,
          };
        }
        const content = await workspaceFilesystem.readFile(path, { encoding: 'utf8' });
        if (Buffer.byteLength(content) > MAX_INSPECTION_BYTES) throw new Error('Record exceeds inspection limit.');
        statuses.set(source.id, 'available');
        return {
          sourceId,
          mountPath: normalizeMountPath(source.mountPath),
          status: 'available',
          content: String(content),
        };
      } catch {
        statuses.set(source.id, 'unavailable');
        return {
          sourceId,
          mountPath: normalizeMountPath(source.mountPath),
          status: 'unavailable',
          error: safeError(source),
        };
      }
    },
  };
}

export { GOOGLE_DRIVE_READONLY_SCOPE, MAX_INSPECTION_BYTES };
