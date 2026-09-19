import { z } from 'zod';

export const sourceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  provider: z.string(),
  mountPath: z.string(),
  enabled: z.boolean(),
  displayName: z.string().min(1).optional(),
});

export const localSourceSchema = sourceSchema.extend({
  provider: z.literal('local'),
  root: z.string().min(1),
});

export const googleDriveSourceSchema = sourceSchema.extend({
  provider: z.literal('google-drive'),
  folderId: z.string().min(1),
  credentialRef: z.literal('organization'),
});

export const catalogSourceSchema = z.discriminatedUnion('provider', [localSourceSchema, googleDriveSourceSchema]);

export type LocalSource = z.infer<typeof localSourceSchema>;
export type GoogleDriveSource = z.infer<typeof googleDriveSourceSchema>;
export type CatalogSource = LocalSource | GoogleDriveSource;

function unsupportedProvider(source: never): never {
  throw new Error(`Unsupported source provider: ${String(source)}`);
}

export function sourceIdentity(source: CatalogSource): string {
  switch (source.provider) {
    case 'local':
      return source.root;
    case 'google-drive':
      return source.folderId;
    default:
      return unsupportedProvider(source);
  }
}
