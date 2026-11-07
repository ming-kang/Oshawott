# AGENTS.md

Oshawatt is a browser extension built on [Pi Durable](https://github.com/earendil-works/pi), providing an agent inside Chromium and Firefox.

## Repository Map

```text
Oshawatt/
|-- AGENTS.md                Coding-agent guidance
|-- README.md                Features, setup and user workflows
|-- src/
|   |-- contracts/           chord hosts, identities and shared API contracts
|   |-- engine/              Durable harness, tools, files, credentials and Code Mode
|   |-- broker/              Tabs, page-script injection and alarms
|   |-- page/                DOM implementation of page tools
|   |-- panel/               Chat UI, Markdown, models, tools, files and site access
|   |-- entries/             Chromium and Firefox runtime entry points
|   |-- link/                runtime.Port transport for chord
|   |-- platform/            WebExtension types, build targets and permission patterns
|   |-- tools/               Single source of page-tool specifications
|   |-- lib/                 chord import facade and platform-independent helpers
|   `-- manifest.ts          Browser manifest generation
|-- static/                  Extension HTML, CSS and icons
|-- scripts/                 Builds, browser smoke tests, screenshots and icons
|-- test/                    Unit tests and fixtures
|-- docs/                    Documents
`-- dist/                    Generated builds and local test output; ignored by Git
```

## Git & Safety Rules

- **Commit on request:** Stage explicit paths; review the staged diff before committing.
- **Conventional Commits**: `<type>[(scope)]: <summary>`.
- **Forbidden git operations:** Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.