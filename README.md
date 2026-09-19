# Organization Intelligence

Inspect institutional records from a local folder and Google Drive through separate, read-only Mastra Workspace mounts. Each result identifies its source and mount path. This checkout currently provides source inspection; indexing, scheduled refresh, grounded answers and MCP consumption are not implemented yet.

## Why we built this

Policies and procedures often live in different repositories. Keeping their source identities distinct is the foundation for answering questions with traceable evidence as those repositories change.

## Prerequisites

- [**OpenAI API key**](https://platform.openai.com/api-keys): set `OPENAI_API_KEY` in `.env` for the default application configuration. The source-inspection workflow makes no model calls.
- [**Google service account**](https://docs.cloud.google.com/iam/docs/keys-create-delete): required only when enabling a Drive source. Set `GOOGLE_DRIVE_CLIENT_EMAIL` and `GOOGLE_DRIVE_PRIVATE_KEY` from its credential file. Quote the private key and preserve its escaped `\n` line breaks. Enable the Drive API for that project and share each selected folder with the service account as Viewer.
- **Source catalog:** edit `source-catalog.json` for folder IDs, stable source IDs and mount paths. Drive examples are disabled initially; the bundled sample is enabled. Both Drive folders use the same `organization` credential reference. Folder IDs do not belong in `.env`.

## Quickstart 🚀

1. **Open this checkout**
   - Work from the directory containing `package.json`. A published template installation reference is not available yet.
2. **Configure credentials**
   - Copy `.env.example` to `.env` and fill the required values described above. Keep the default sample-only catalog for the first local run.
3. **Start the local server**
   - Run `pnpm dev:local`. It installs the frozen dependency set, validates configuration and starts Mastra on loopback. Reruns preserve credentials, catalog and derived state.
   - Open the Studio address printed by Mastra. Select the `inspect-organization-source` workflow and use `{"sourceId":"sample","path":"records-retention.md"}`. Expect an `available` result from `/sample` containing the seven-year invoice retention example.

## Try it out

- Inspect the bundled record and confirm its `sourceId`, `mountPath` and content. This reads a source directly; it does not prove the source has been indexed.
- Enable two Drive entries with different folder IDs, then restart. Place different synthetic `guide.md` documents in those folders and inspect each source using the same relative path. Their contents and source identities remain distinct.
- Disable a catalog entry and restart. The previous source ID is no longer accessible. Editing the catalog without restarting does not replace the active configuration.
- Submit `../outside.txt` as a record path. The workflow rejects traversal; source content is never modified.

## Customization

- Ask a coding agent to inspect the implementation and propose a plan before adapting it: “Add a new read-only document source while preserving source identity and the existing containment tests.”
- Replace bundled samples or add catalog entries. Preserve an existing source ID only while its provider and root remain the same; use a new ID for a different root. Keep external credentials out of the catalog.
- Add another local folder or Google Drive folder by adding a catalog entry; no code change is needed. To support a new provider, add its schema to the discriminated union and its identity rule in `src/source-providers.ts`, add root validation in `src/catalog.ts`, and add the native Mastra filesystem plus credential handling in `src/sources.ts`. Keep provider transport, authentication, listing, and reads inside the installed Mastra driver.

## Local checks and limits

`pnpm check:env` validates local configuration without proving remote access. `pnpm dev` starts an installed checkout. `pnpm test` runs credential-free deterministic tests; `pnpm check` combines formatting, static checks, tests and build. `pnpm build` creates the Mastra build output.

The separate `pnpm test:integration` command contacts real Drive sources. Enable two synthetic folders and place `f1-drive-smoke.txt` in each, containing `source=<configured-source-id>`. Missing setup or failed access is a failed test, not a skipped success. Live Drive validation has not been performed for this checkout.

Inspection accepts small text records up to 64 KiB. Native Google Docs/Sheets export and PDF/DOCX extraction belong to the later indexing implementation. An unavailable source returns a sanitized error; local records remain inspectable. This is a trusted local tool, without a public authentication layer.

Local state lives under `.mastra/` using file-backed libSQL and a source-identity ledger. No database service or container setup is required. The ledger rejects reusing an existing ID for a different root. Do not delete it to work around a mismatch; assign a new source ID. No automatic destructive reset is provided.

## About Mastra templates

Mastra templates provide starting points for applications built with its agents, workflows and integrations. This local project uses Workspace mounts and a source-inspection workflow. Publication and template-directory attribution have not been established.
