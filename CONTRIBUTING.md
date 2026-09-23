# Contributing

Contributions to Organization Intelligence are welcome. For bugs, include steps to reproduce the problem and the expected behavior. For larger changes, open an issue to discuss the approach before starting implementation.

## Local setup

1. Fork and clone the template repository.
2. Run `npm ci` to install the locked dependencies.
3. To run the application, copy `.env.example` to `.env`, add your OpenAI API key, and run `npm run dev`. The default catalog uses the bundled local documents.

## Making changes

- Keep Mastra components under `src/mastra`, grouped by responsibility.
- Keep test data in `fixtures` folders and test helpers alongside the tests that use them.
- Add or update tests when changing behavior, and update documentation when setup or usage changes.
- Keep credentials, private documents, and generated `.mastra` data out of commits.

## Before opening a pull request

Run `npm run check` from the project directory. It checks formatting, linting, types, deterministic tests, and the build. These checks do not require live provider calls. Use `npm run format` to fix formatting when needed.

Describe the problem, what changed, and how you verified it. Link the related issue if there is one, and mention any provider behavior you could not test.

## Conversational retrieval evaluation

After changing contextualization prompts or models, run `npm run eval:conversations -- --allow-live` with `OPENAI_API_KEY` configured. It makes at most seven model calls against synthetic conversations, without reading company documents or changing application state. The JSON report checks references, topic changes, corrections, ambiguity, and instructions embedded in history. These checks are a smoke evaluation, not a semantic guarantee. The command exits nonzero on a failed case.
