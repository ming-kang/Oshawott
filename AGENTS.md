# Repository contract

Oshawott is a browser extension built on [Pi Durable](https://github.com/earendil-works/pi), providing an agent inside Chromium and Firefox.

## Testing rules

- **Observable behavior:** Test observable behavior, not internals, constants, or mock structures. For bug fixes, write a failing reproduction first when practical.
- **When to test:** Add a test only when it catches a plausible future bug that types and existing tests would miss.
- **Offline fixtures:** Use the existing fake Browser/Port/IndexedDB fixtures, faux providers, demo account, and local smoke servers.

## Git & safety rules

- **Commit on request:** Commit only when the user asks. Stage explicit paths (`git add <path1> <path2>`); review the staged diff before committing. Use Conventional Commits: `<type>[(scope)]: <summary>`.
- **Forbidden git operations:** Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
