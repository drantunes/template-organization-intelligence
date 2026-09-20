# Organization Intelligence

Search institutional records from local folders and Google Drive with source paths, document locators and freshness status. One Mastra workflow indexes records at startup, on demand and every five minutes while the server runs. The Organization Agent returns bounded, source-grounded answers through Studio, a local API route and a read-only MCP query tool.

## Why we built this

Policies and procedures often live in different repositories. Keeping their source identities distinct is the foundation for answering questions with traceable evidence as those repositories change.

## Prerequisites

- [**OpenAI API key**](https://platform.openai.com/api-keys): set `OPENAI_API_KEY` in `.env` for the default application configuration. Indexing sends normalized document text to OpenAI for `text-embedding-3-small` embeddings; search also embeds the question. These operations incur provider usage. The direct source-inspection workflow makes no model calls.
- [**Google service account**](https://docs.cloud.google.com/iam/docs/keys-create-delete): required only when enabling a Drive source. Set `GOOGLE_DRIVE_CLIENT_EMAIL` and `GOOGLE_DRIVE_PRIVATE_KEY` from its credential file. Quote the private key and preserve its escaped `\n` line breaks. Enable the Drive API and Google Docs API for that project and share each selected folder with the service account as Viewer.
- **Source catalog:** edit `source-catalog.json` for folder IDs, stable source IDs and mount paths. Drive examples are disabled initially; the bundled sample is enabled. Both Drive folders use the same `organization` credential reference. Folder IDs do not belong in `.env`.

## Quickstart 🚀

1. **Open this checkout**
   - Work from the directory containing `package.json`. A published template installation reference is not available yet.
2. **Configure credentials**
   - Copy `.env.example` to `.env` and fill the required values described above. Keep the default sample-only catalog for the first local run.
3. **Start the local server**
   - Run `pnpm dev:local`. It installs the frozen dependency set, validates configuration and starts Mastra on loopback. Reruns preserve credentials, catalog and derived state.
   - Open the Studio address printed by Mastra. After startup indexing, select **Organization Agent** and ask “How long are invoices retained?” Expect an answer with the `/sample/records-retention.md` citation, source readiness and freshness. The `POST /organization-answer` route and MCP `answerOrganizationQuestion` tool use the same agent contract.

## Try it out

- Add a Markdown, textual PDF or DOCX record under an enabled local folder. Run `sync-organization-sources` with `{"trigger":"manual"}`, then search for a fact from the new file. It becomes searchable without restarting. The same workflow runs every five minutes while the process is running.
- Edit the record and refresh. Search returns the committed replacement; a no-change refresh reports unchanged records without embedding them again. Review indexed, changed, skipped, failed and removed counts for each source.
- Enable two Drive catalog entries with different folder IDs, then restart. Share the folders with the service account and add native Docs or Sheets. Search evidence in a nested document tab or a second worksheet and inspect its original Drive link and locator.
- Interrupt Drive access after a successful scan. Local refresh continues; cached Drive evidence remains available with a stale warning and its last successful scan time. Only a complete scan can confirm removal. Freshness also becomes stale after ten minutes without success.
- Disable a catalog entry and restart. Its cached evidence is excluded from search. Catalog changes require a restart; document additions and edits under existing roots do not.
- To inspect a small text record directly, select `inspect-organization-source` with `{"sourceId":"sample","path":"records-retention.md"}`. Inspection reads the source and does not establish index freshness.

## Customization

- Ask a coding agent to inspect the implementation and propose a plan before adapting it: “Add a new read-only document source while preserving source identity and the existing containment tests.”
- Replace bundled samples or add catalog entries. Preserve an existing source ID only while its provider and root remain the same; use a new ID for a different root. Keep external credentials out of the catalog.
- Add another local folder or Google Drive folder by adding a catalog entry; no code change is needed. To support a new provider, add its schema to the discriminated union and its identity rule in `src/source-providers.ts`, add root validation in `src/catalog.ts`, and add the native Mastra filesystem plus credential handling in `src/sources.ts`. Keep native Mastra mounts read-only. The scoped Drive ingestion helper shares the provider authentication callback and resolves stable IDs, bounded downloads and native exports; answering tools must not accept arbitrary Drive IDs.

## Local checks and limits

`pnpm check:env` validates local configuration without proving remote access. `pnpm dev` starts an installed checkout. `pnpm test` runs credential-free deterministic tests; `pnpm check` combines formatting, static checks, tests and build. `pnpm build` creates the Mastra build output.

The separate `pnpm test:integration` command contacts real Drive sources. Enable two synthetic folders and place `f1-drive-smoke.txt` in each, containing `source=<configured-source-id>`. Missing setup or failed access is a failed test, not a skipped success. Live Drive validation has not been performed for this checkout.

Inspection accepts text records up to 64 KiB. Indexing supports Markdown, textual PDF, DOCX and native Google Docs/Sheets, including nested tabs and all nonempty worksheets. PDFs retain page locators; image-only pages are not indexed and mixed PDFs report partial extraction. OCR, spreadsheet recalculation and source writes are excluded. Missing cached formula values and formula errors remain visible. Duplicate Drive sibling names and shortcuts are skipped.

Each scan is bounded to 1,000 entries per source and depth 32. Inputs are limited to 20 MiB, native exports to 10 MB, and normalized text to 1 MiB per record. Office extraction also limits inflated XML to 32 MiB, 2,000 archive entries, XML depth 64, 100 worksheets and 100,000 cells; PDFs are limited to 1,000 pages. Partial listings preserve cached records instead of treating them as deleted. Search accepts up to 4,000 characters and returns at most six chunks. This is a trusted local tool, without a public authentication layer.

The server uses one synchronization writer. Overlapping triggers report `skipped`; queries continue using the last committed generation until publication completes. Restart rebuilds hybrid search from committed text and stored embeddings without re-embedding unchanged records. One persisted schedule is reused on restart; missed downtime ticks are not replayed, and startup refreshes once. Run metadata is retained for seven days. Deterministic tests use synthetic files and controlled HTTP, not live Google/OpenAI evidence.

Local state lives under `.mastra/` using file-backed libSQL and a source-identity ledger. No database service or container setup is required. The ledger rejects reusing an existing ID for a different root. Do not delete it to work around a mismatch; assign a new source ID. To rebuild or purge derived data, stop every running instance, then remove only `.mastra/organization-intelligence.db` and its `-wal`/`-shm` sidecars plus `.mastra/source-identities.json`. Restart with `pnpm dev`. This discards cached records, embeddings and schedule/run state and requires a fresh scan and paid embeddings. Preserve `.env`, `source-catalog.json` and every source folder. If Google is unavailable during the rebuild, there is no cached Drive evidence to serve. No automatic destructive reset is provided.

## About Mastra templates

Mastra templates provide starting points for applications built with its agents, workflows and integrations. This local project uses read-only Workspace mounts, persistent synchronization workflows and hybrid retrieval. Publication and template-directory attribution have not been established.
