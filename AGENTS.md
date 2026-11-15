# Development Rules

Oshawott is a browser extension built on [Pi Durable](https://github.com/earendil-works/pi), providing an agent inside browsers (Firefox and Chromium).

## Documentation

- Do not document details already expressed by code or configuration.

## Testing

- Add a test only when it would catch a plausible future bug that types and existing tests miss. If unsure, don't add it.
- Test observable behavior through public entry points. For bug fixes, write a failing reproduction first when practical.
- Do not test constants, registries, plain lookups, mock structures, or dependency behavior (e.g. standard Markdown syntax).
- Cover each behavior at one layer, the cheapest that can observe it: unit tests before panel self-tests and smoke tests. Extend an existing test before adding a new one.
- Do not add production code that only tests use; reuse the fakes in `test/support/`.
- When behavior changes, rewrite or delete the tests it obsoletes instead of keeping both.
- Before finishing, run `npm run check` and `npm test`; run the smoke tests when changing browser integration.

## Git

- **Commit on request:** Commit only when the user asks. Stage explicit paths (`git add <path1> <path2>`); review the staged diff before committing. Use Conventional Commits: `<type>[(scope)]: <summary>`.
- **Forbidden git operations:** Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
