# Contributing

Read [AGENTS.md](AGENTS.md) and [the design](docs/README.md) first.

## Setup

```sh
pnpm install
prek install
```

Node.js 22.18 or later runs the plugin and its tests. [prek](https://github.com/j178/prek)
runs the hooks; [cocogitto](https://github.com/cocogitto/cocogitto) checks commit messages.

## The gate

`prek run --all-files` is the gate. The `publish` skill and CI run the same checks:

- gitleaks, rumdl and ShellCheck;
- `pnpm typecheck`, `pnpm fmt:check` and `pnpm test`.

The end-to-end tests run only when `FLEET_BIN` names a `fleet` binary. CI downloads the
pinned Fleet release, checks its checksum and requires them.

## Commits and pull requests

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/), with the
  types in `cog.toml`. The `commit-msg` hook runs `cog verify`.
- Pull requests are squash merged. The title becomes the commit on `main`, so the
  `PR Title` check validates it.
- A `feat` or `fix` on `main` cuts a release: `cd.yml` tags the version and publishes
  its notes.
