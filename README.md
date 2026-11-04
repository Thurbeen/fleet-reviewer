# fleet-reviewer

A [Fleet](https://github.com/Thurbeen/fleet) plugin that finds the open pull and merge
requests of chosen repositories, or only those that request one user's review, and starts
one review Task per change, kept until the change merges or closes. A new push amends it.
Each review Task posts one summary and one
thread per finding, records a confidence from 1 to 5, and can approve the head it reviewed
above a threshold. It never merges. A generic brief is the default;
[thurview](https://github.com/Thurbeen/thurview)'s `pr-review` flow is an optional template.

**Status: implemented.** The design is in [docs/](docs/README.md)
([Thurbeen/fleet#351](https://github.com/Thurbeen/fleet/issues/351)). It runs on the
Node.js already installed: no build, no package, no new binary.

## How it works

A person applies a `ReviewSource`: one forge host, an explicit list of repositories,
filters, the TaskConfig the reviews run with, post or report-only, an optional approve
threshold, and who dispatches. The plugin lists each repository's open changes, creates one
`Review` per included change, and one Task per change. The policy dispatches each Task, or
a person does. The plugin follows the Task to its result, amends it on each push, and
deletes it when the change merges or closes.

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

Node.js 22.18 or later runs `src/plugin.ts` as is. Check out a pinned commit or release tag
on the manager:

```sh
git clone https://github.com/Thurbeen/fleet-reviewer /opt/fleet-plugins/fleet-reviewer
```

Register it in the manager's native config, with `program` set to the Node.js already
installed:

```toml
[plugins.fleet-reviewer]
program = "/usr/local/bin/node"
args = ["/opt/fleet-plugins/fleet-reviewer/src/plugin.ts"]
cwd = "/opt/fleet-plugins/fleet-reviewer"
tasks = "own"
envFrom = [{ name = "fleet-reviewer-tokens" }]
```

Then apply a source. This one reviews every open change of `OWNER/app` that requests the
review of `reviewer-login`, posts, and approves at a confidence of 4 or more:

```json
{
  "apiVersion": "fleet/v1alpha1",
  "kind": "ReviewSource",
  "metadata": {"name": "app"},
  "spec": {
    "forge": {"kind": "gitlab", "host": "gitlab.example.com", "tokenEnv": "REVIEWER_TOKEN_A"},
    "repositories": [{"project": "OWNER/app"}],
    "filters": {"requestedReviewer": "reviewer-login"},
    "review": {"taskConfig": "review-gitlab", "approveAt": 4},
    "dispatch": {"maxActive": 2}
  }
}
```

[Configuration](docs/configuration.md) explains each field and the credentials.

## Contributing

Read [AGENTS.md](AGENTS.md). `pnpm install`, then `pnpm check` runs the type-check, the
format check and the tests. Set `FLEET_BIN` to a `fleet` binary to run the end-to-end
tests too; CI runs them against a pinned Fleet release. Commits and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org/); pull requests are squash
merged.

## License

[MIT](LICENSE)
