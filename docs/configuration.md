# Configuration

The plugin has two kinds of configuration. The operator registers it once in the
manager's native config. People configure each review scope with a `ReviewSource`.
The controller half reads neither the config nor the environment: what it needs is spec.

## Registration

A release ships one bundled file, `dist/plugin.js`, that runs on Node.js with no other
dependency. The operator installs it on the manager and registers it under
[`[plugins.<name>]`](https://github.com/Thurbeen/fleet/blob/main/docs/configuration/fleet-toml.md#plugins-section):

```toml
[plugins.fleet-reviewer]
program = "/usr/local/bin/node"
args = ["/opt/fleet-plugins/fleet-reviewer/dist/plugin.js"]
cwd = "/opt/fleet-plugins/fleet-reviewer"
callTimeoutMs = 15000
tasks = "own"
envFrom = [{ name = "fleet-reviewer-tokens" }]
```

| Field | Value | Why |
| --- | --- | --- |
| Key | `fleet-reviewer` | The manifest's `name` must equal it. |
| `program`, `args`, `cwd` | Absolute paths on the manager | Fleet runs no shell and searches no `PATH`. |
| `callTimeoutMs` | `15000` | One forge page per call fits in it. A slow self-hosted forge may need more. |
| `tasks` | `"own"` | The plugin patches, sends to and deletes only the Tasks it created. |
| `envFrom` | The EnvProvider that holds the forge tokens | Only the observer half receives it. |

`fleet up` makes the `manifest` call once and refuses to start if it fails. Then
`fleet list plugins --json` shows the plugin, its two kinds and its protocol.

## Identities

Two identities act for each forge, and each has its own place:

| Identity | Acts in | Configured by |
| --- | --- | --- |
| The plugin's forge reader | `observe`: listings and reads, no write | `ReviewSource.spec.forge.tokenEnv` names a variable that `envFrom` delivers. |
| The review session | The review Task: checkout, thurview, posts | `ReviewSource.spec.review.taskConfig` names a TaskConfig. |

The TaskConfig picks the harness, the host, the model, and the EnvProviders that give the
session its forge login and its harness account. Two forges with two accounts and two
harness organisations are two TaskConfigs and two sources:

```json
[
  {"apiVersion": "fleet/v1alpha1", "kind": "TaskConfig", "metadata": {"name": "review-forge-a"},
   "spec": {"harness": "claude-code", "envFrom": [{"name": "forge-a-session"}]}},
  {"apiVersion": "fleet/v1alpha1", "kind": "TaskConfig", "metadata": {"name": "review-forge-b"},
   "spec": {"harness": "claude-code", "envFrom": [{"name": "forge-b-session"}]}}
]
```

Each `forge-*-session` EnvProvider gives the variables its harness and its forge CLI read,
for example `GH_TOKEN` or `GITLAB_TOKEN` and `GITLAB_HOST`. Their sources are files or
commands on the manager, never values in a manifest.

## Credentials

The observer half needs one read token per forge account. The operator puts every such
token in one EnvProvider, under a name of their choice:

```json
{"apiVersion": "fleet/v1alpha1", "kind": "EnvProvider",
 "metadata": {"name": "fleet-reviewer-tokens"},
 "spec": {"sources": [{"type": "command", "program": "/usr/local/bin/print-reviewer-tokens",
                       "cwd": "/", "timeoutMs": 5000}]}}
```

The command prints an [environment JSON](https://github.com/Thurbeen/fleet/blob/main/docs/configuration/environment-json.md)
map such as `{"REVIEWER_TOKEN_A": "…", "REVIEWER_TOKEN_B": "…"}`. Each source names its
variable in `forge.tokenEnv`. An `observe` call reads only that variable and passes the
value in the request's `Authorization` header. The value never reaches a spec, a status,
a plan, argv or a log line.

| Token | Scope it needs |
| --- | --- |
| GitHub | Read access to pull requests and metadata of the source's repositories. A fine-grained token restricted to those repositories is enough. |
| GitLab | `read_api`. |

Every `observe` call receives every variable of `envFrom`. A source for one account can
therefore be read with another account's token if its `tokenEnv` names it. The plugin is
one trusted program, so this is a rule of the operator's config, not a boundary. [Fleet
core](fleet-core.md#3-observer-environment-per-request) proposes a narrower delivery.

## A ReviewSource

```json
{
  "apiVersion": "fleet/v1alpha1",
  "kind": "ReviewSource",
  "metadata": {"name": "product-a"},
  "spec": {
    "forge": {"kind": "gitlab", "host": "gitlab.example.com", "tokenEnv": "REVIEWER_TOKEN_B",
              "maxCallsPerMinute": 20},
    "repositories": [
      {"project": "group/product-a/api", "url": "https://gitlab.example.com/group/product-a/api"},
      {"project": "group/product-a/web", "url": "https://gitlab.example.com/group/product-a/web"}
    ],
    "filters": {"staleAfterDays": 30},
    "review": {"taskConfig": "review-forge-b", "output": "post", "page": "none"},
    "dispatch": {"by": "policy", "maxActive": 1}
  }
}
```

```sh
fleet --config fleet.toml apply -f review-source.json
fleet --config fleet.toml status reviewsource product-a
fleet --config fleet.toml list review --json
fleet --config fleet.toml get review rv-api-42-3e91c0
```

Each `url` must be a key of the manager's `runtime.repositories`, which maps it to a
checkout. A source scoped to one product names that product's repositories and no other.

## Dispatching by hand

Under `dispatch.by: person`, a person dispatches a queued review Task. Fleet has no verb
that sets only `dispatch` today, so the person applies the Task again with
`dispatch: true`. The manifest keeps the Task's labels except `fleet.dev/plugin`, which
`apply` refuses and the store keeps:

```sh
fleet --config fleet.toml get task rv-api-42-3e91c0-0a1b2c3d4e5f \
  | jq '{apiVersion, kind,
         metadata: {name: .metadata.name,
                    labels: (.metadata.labels | del(.["fleet.dev/plugin"]))},
         spec: (.spec + {dispatch: true})}' \
  | fleet --config fleet.toml apply -f -
```

[Fleet core](fleet-core.md#2-a-dispatch-verb) proposes a verb for this.

A `Review` in phase `Queued` with `Dispatched=False/AwaitingPerson` names the Task that
waits. `fleet list review --json` shows every `Review` with its status.

## Removing the plugin

Fleet has no forced delete, and a plugin removed from the config holds its finalizers
until it is back. To remove fleet-reviewer:

1. Delete every `ReviewSource`. Each `Review` deletes its Tasks, then itself.
2. Wait until `fleet list review` is empty.
3. Remove the `[plugins.fleet-reviewer]` entry.
