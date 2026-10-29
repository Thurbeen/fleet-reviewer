# fleet-reviewer

A [Fleet](https://github.com/Thurbeen/fleet) plugin that finds the open pull and merge
requests of chosen repositories and starts one review Task per change and per head commit.
Each review Task reviews with [thurview](https://github.com/Thurbeen/thurview), under its
`pr-review` rules: a confidence from 1 to 5, categorised findings, one summary edited in
place and one thread per finding, with or without a published page.

**Status: design.** Nothing is implemented. The design is in [docs/](docs/README.md) and
waits for approval
([Thurbeen/fleet#351](https://github.com/Thurbeen/fleet/issues/351)).

## How it works

A person applies a `ReviewSource`: one forge host, an explicit list of repositories,
filters, the TaskConfig the reviews run with, post or report-only, and who dispatches.
The plugin lists each repository's open changes, creates one `Review` per included change,
and one Task per head. A person or the policy dispatches each Task. The plugin follows the
Task to its result, reviews a new push again, and retires everything when the change
closes.

| Read | For |
| --- | --- |
| [Design overview](docs/README.md) | The flow, the rules and the scope. |
| [Kinds](docs/kinds.md) | `ReviewSource` and `Review`, with their JSON Schemas. |
| [State machine](docs/state-machine.md) | How a `Review` moves. |
| [Interface](docs/interface.md) | Every protocol call, rate limits and Unknown answers. |
| [Review Task](docs/review-task.md) | The Task, its brief, dispatch and new pushes. |
| [Configuration](docs/configuration.md) | Registration, identities and credentials. |
| [Fleet core](docs/fleet-core.md) | What Fleet would need to add. |
| [Open questions](docs/open-questions.md) | What is left to decide. |

## Registration

Once released, the plugin is one file, `dist/plugin.js`, run by Node.js. The operator
registers it in the manager's native config:

```toml
[plugins.fleet-reviewer]
program = "/usr/local/bin/node"
args = ["/opt/fleet-plugins/fleet-reviewer/dist/plugin.js"]
cwd = "/opt/fleet-plugins/fleet-reviewer"
tasks = "own"
envFrom = [{ name = "fleet-reviewer-tokens" }]
```

[Configuration](docs/configuration.md) explains each field and the credentials.

## Contributing

Read [AGENTS.md](AGENTS.md). Commits and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org/); pull requests are squash
merged.

## License

[MIT](LICENSE)
