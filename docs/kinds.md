# Kinds

The plugin defines two kinds, `ReviewSource` and `Review`. Both follow Fleet's
[plugin kinds](https://github.com/Thurbeen/fleet/blob/main/docs/resources/plugin-kinds.md)
contract: Fleet's envelope, a spec that the store validates against the schema below, and a
status that the plugin owns, beside the three fields the host reserves (`notBefore`,
`effects`, `host`).

| Kind | Written by | One per | Finalizer | Spec |
| --- | --- | --- | --- | --- |
| `ReviewSource` | A person, with `fleet apply` | Forge host and set of repositories | No | Mutable |
| `Review` | The plugin, through `creates` | Change (pull or merge request) | Yes | Immutable |

A person applies sources. The plugin creates every `Review`. A person may delete a
`Review`; its finalizer lets the plugin delete the review Tasks first.

## ReviewSource

```json
{
  "apiVersion": "fleet/v1alpha1",
  "kind": "ReviewSource",
  "metadata": {"name": "app"},
  "spec": {
    "forge": {"kind": "github", "host": "github.com", "tokenEnv": "REVIEWER_TOKEN_A",
              "maxCallsPerMinute": 30},
    "repositories": [{"project": "OWNER/app"}, {"project": "OWNER/app-infra"}],
    "filters": {"staleAfterDays": 14, "excludeAuthors": ["release-robot"]},
    "review": {"taskConfig": "review-github", "output": "report", "page": "none"},
    "dispatch": {"by": "person", "maxActive": 2}
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `forge.kind` | required | `github` or `gitlab`. |
| `forge.host` | required | The forge's host name, as in a change URL. |
| `forge.apiUrl` | derived | `https://api.github.com` for `github.com`, `https://<host>/api/v3` for another GitHub host, `https://<host>/api/v4` for GitLab. |
| `forge.tokenEnv` | required | The name of the variable that holds the token the plugin reads this forge with. The value never appears in a spec. See [Configuration](configuration.md#credentials). |
| `forge.maxCallsPerMinute` | `30` | The call budget of this host. Sources on one host share the smallest value any of them declares. See [Rate limits](interface.md#rate-limits). |
| `repositories[].project` | required | `OWNER/repo` on GitHub, `group/sub/project` on GitLab. At least one; at most 50. |
| `repositories[].url` | `https://<host>/<project>` | The URL the review Task's workspace names. It must match a key of the manager's `runtime.repositories`. |
| `repositories[].targetBranches` | all | Only changes into these branches are included. |
| `filters` | see [Filters](#filters) | Which open changes are reviewed. |
| `review.taskConfig` | required | The [TaskConfig](https://github.com/Thurbeen/fleet/blob/main/docs/resources/task-config.md) the review Tasks reference: harness, host, model and the session's credentials. |
| `review.output` | `report` | `post`: the Task posts the summary and the finding threads. `report`: the Task posts nothing and returns the rendered summary in its result. |
| `review.page` | `none` | `none`: no thurview page is published. `snapshot`: the Task publishes thurview's public snapshot and links it. `snapshot` requires `output: post`. |
| `review.guidance` | none | Text the brief adds under "Repository guidance". At most 4000 characters. |
| `dispatch.by` | `person` | `person`: a person dispatches each Task. `policy`: the plugin dispatches it under `maxActive`. |
| `dispatch.maxActive` | `2` | Under `policy`, the most review Tasks of this source that run at once. 1 to 20. |
| `suspend` | `false` | `true` stops listing, creating and dispatching. Running Tasks continue. |
| `pollMs` | `300000` | How often the source lists its repositories. At least 60000. |
| `retention.taskMs` | `3600000` | How long a concluded review Task stays before the `Review` deletes it, which releases its session. |
| `retention.reviewMs` | `604800000` | How long a settled `Review` stays before it retires. |

JSON Schema keywords such as `default` are annotations. The plugin applies the defaults
in the table; the store does not.

### Filters

A change is **included** when every rule below admits it. Otherwise it is **excluded**,
and its status entry names the first rule that excluded it.

| Field | Default | Excludes |
| --- | --- | --- |
| `drafts` | `false` | A draft change, unless `true`. |
| `bots` | `false` | A change by a bot account, unless `true`. |
| `deletedAuthors` | `false` | A change whose author account no longer exists, unless `true`. |
| `ownChanges` | `false` | A change by the account `forge.tokenEnv` authenticates as, unless `true`. |
| `staleAfterDays` | `14` | A change whose head commit is older than this many days. |
| `excludeAuthors` | `[]` | A change by one of these logins. |
| `onlyAuthors` | all | A change by any other login, when the list is given. |
| `requireLabels` | `[]` | A change that lacks one of these labels. |
| `excludeLabels` | `["thurview:stop"]` | A change that has one of these labels. |

How the observer decides each fact, per forge:

| Fact | GitHub | GitLab |
| --- | --- | --- |
| Bot | The author's GraphQL type is `Bot`. | The author's username matches a project or group access token user (`project_<id>_bot…`, `group_<id>_bot…`), or `excludeAuthors` names it. Assumed; checked when the adapter is written. |
| Deleted author | The author is `null`. | The author is the `ghost` user. |
| Head commit date | The last commit's `committedDate`, in the list query. | One commit read per new head, kept in the source's status by head, so a head is read once. |

Staleness uses the head commit, not the change's "updated" time. A review's own comments
move the "updated" time, and an old change would look fresh after each review.

### Status

```json
"status": {
  "phase": "Listing",
  "observedGeneration": 3,
  "account": {"login": "reviewer-login", "checkedAt": 1730000000000},
  "repositories": {
    "OWNER/app": {"listedAt": 1730000300000},
    "OWNER/app-infra": {"listedAt": 1730000000000,
                        "unknown": {"why": "Timeout", "at": 1730000300000}}
  },
  "changes": {
    "OWNER/app!88": {"review": "rv-app-88-1b7d02", "url": "https://github.com/OWNER/app/pull/88",
                     "title": "Retry a lost brief", "author": {"login": "colleague", "kind": "user"},
                     "draft": false, "head": "9f3c2a1e0b7d…", "headAt": 1729900000000,
                     "base": "main", "labels": [], "verdict": "included"},
    "OWNER/app!91": {"review": null, "url": "…", "author": {"login": "deps-bot", "kind": "bot"},
                     "draft": false, "head": "…", "headAt": 1729990000000, "base": "main",
                     "labels": ["dependencies"], "verdict": "excluded", "reason": "bots"}
  },
  "budget": {"minute": 28833338, "calls": 3},
  "throttle": null,
  "conditions": [
    {"type": "Listed", "status": "True", "reason": "Complete",
     "message": "2 of 2 repositories listed; 1 included, 1 excluded",
     "lastTransitionTime": 1730000300000}
  ]
}
```

| Field | Meaning |
| --- | --- |
| `phase` | `Listing`, `Suspended` or `Throttled`. |
| `account` | The login `forge.tokenEnv` authenticates as, read at most once a day. |
| `repositories` | Per project: when it was last listed completely, and the last Unknown answer, if newer. |
| `changes` | One entry per open change last listed, keyed `<project>!<number>`. A project whose last answer was Unknown keeps its previous entries. At most 200 entries. |
| `changes[].review` | The `Review` name, or `null` for an excluded change that never had one. |
| `budget` | Calls made in the current minute, `minute` being `floor(now / 60000)`. |
| `throttle` | `{until, streak, why}` after a rate-limit answer; `null` otherwise. |
| `conditions` | `Listed`, `Throttled`, `Overlap` and `NeedsAttention`. |

`Overlap` is `True` when a change of this source already has a `Review` that another source
created. Such a change is reviewed once, under the other source's settings.

## Review

```json
{
  "apiVersion": "fleet/v1alpha1",
  "kind": "Review",
  "metadata": {"name": "rv-app-88-1b7d02",
               "labels": {"fleet.dev/plugin": "fleet-reviewer", "fleet-reviewer/source": "app"},
               "finalizers": ["fleet.dev/plugin/fleet-reviewer"]},
  "spec": {"source": "app", "forge": {"kind": "github", "host": "github.com"},
           "project": "OWNER/app", "number": 88,
           "url": "https://github.com/OWNER/app/pull/88"},
  "status": {
    "phase": "Reviewing",
    "observedGeneration": 1,
    "head": {"sha": "9f3c2a1e0b7d…", "seenAt": 1730000300000},
    "task": {"name": "rv-app-88-1b7d02-9f3c2a1e0b7d", "uid": "…", "head": "9f3c2a1e0b7d…",
             "told": [], "dispatched": {"by": "policy", "at": 1730000400000}},
    "reviews": [
      {"head": "4a1d…", "task": "rv-app-88-1b7d02-4a1d…", "outcome": "shipped",
       "confidence": 4, "findings": 1, "summaryUrl": "https://github.com/OWNER/app/pull/88#issuecomment-…",
       "at": 1729950000000}
    ],
    "cancelled": [],
    "retiring": [],
    "change": {"state": "open", "checkedAt": null},
    "conditions": [
      {"type": "Reviewed", "status": "False", "reason": "Reviewing",
       "message": "head 9f3c2a1 is being reviewed", "lastTransitionTime": 1730000400000}
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `phase` | `Queued`, `Reviewing`, `Reviewed`, `Excluded`, `Settled` or `Retiring`. See the [state machine](state-machine.md). |
| `head` | The change's head as the source last listed it, and when this `Review` first saw it. |
| `task` | The current review Task: name, `uid` once probed, the head it was briefed for, the heads it was told about since, and who dispatched it. |
| `reviews` | One entry per concluded review Task, newest first, at most 10. A report-only entry carries `report`, the rendered summary, cut at 16 KiB. |
| `cancelled` | Heads whose Task a person deleted before it concluded. The plugin does not review them again. At most 20. |
| `retiring` | Tasks this `Review` asked Fleet to delete, kept until a probe shows each gone. |
| `change` | `open`, `merged` or `closed`, and when the forge was last asked directly. |
| `conditions` | `Reviewed`, `Dispatched` and `NeedsAttention`. |

## Names and labels

| Object | Name | Labels the plugin sets |
| --- | --- | --- |
| `Review` | `rv-<repo>-<number>-<hash>`: `<repo>` is the last path segment of the project, lowercased, with every other character than `a-z`, `0-9` and `-` replaced by `-`, cut at 40; `<hash>` is the first 6 hex digits of SHA-256 of `<host>/<project>!<number>`. | `fleet-reviewer/source` |
| Review Task | `<review name>-<head>`: `<head>` is the first 12 hex digits of the head commit. | `fleet-reviewer/source`, `fleet-reviewer/review` |

The host adds `fleet.dev/plugin: fleet-reviewer` to both. Names derive from facts, so a
repeated pass creates nothing twice: the store answers `already` for a name this plugin
created.

One change has one `Review`, whichever source found it first. The name does not include
the source, so two sources that overlap cannot review the same change twice.

## Manifest

The `manifest` call answers these two kinds. The schemas use only keywords that draft-07
and draft 2020-12 share, because Fleet has not published its dialect. Fleet validates with
the `jsonschema` crate, whose default is draft 2020-12.

### ReviewSource spec schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["forge", "repositories", "review"],
  "properties": {
    "forge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "host", "tokenEnv"],
      "properties": {
        "kind": {"enum": ["github", "gitlab"]},
        "host": {"type": "string", "pattern": "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$"},
        "apiUrl": {"type": "string", "pattern": "^https://[^\\s]+$"},
        "tokenEnv": {"type": "string", "pattern": "^[A-Z_][A-Z0-9_]{0,127}$"},
        "maxCallsPerMinute": {"type": "integer", "minimum": 1, "maximum": 600, "default": 30}
      }
    },
    "repositories": {
      "type": "array",
      "minItems": 1,
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["project"],
        "properties": {
          "project": {"type": "string", "pattern": "^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$"},
          "url": {"type": "string", "pattern": "^[^\\s-][^\\s]*$"},
          "targetBranches": {"type": "array", "uniqueItems": true,
                             "items": {"type": "string", "minLength": 1}}
        }
      }
    },
    "filters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "drafts": {"type": "boolean", "default": false},
        "bots": {"type": "boolean", "default": false},
        "deletedAuthors": {"type": "boolean", "default": false},
        "ownChanges": {"type": "boolean", "default": false},
        "staleAfterDays": {"type": "integer", "minimum": 1, "maximum": 365, "default": 14},
        "excludeAuthors": {"type": "array", "uniqueItems": true,
                           "items": {"type": "string", "minLength": 1}},
        "onlyAuthors": {"type": "array", "uniqueItems": true, "minItems": 1,
                        "items": {"type": "string", "minLength": 1}},
        "requireLabels": {"type": "array", "uniqueItems": true,
                          "items": {"type": "string", "minLength": 1}},
        "excludeLabels": {"type": "array", "uniqueItems": true,
                          "items": {"type": "string", "minLength": 1},
                          "default": ["thurview:stop"]}
      }
    },
    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": ["taskConfig"],
      "properties": {
        "taskConfig": {"type": "string", "pattern": "^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$"},
        "output": {"enum": ["post", "report"], "default": "report"},
        "page": {"enum": ["none", "snapshot"], "default": "none"},
        "guidance": {"type": "string", "maxLength": 4000}
      }
    },
    "dispatch": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "by": {"enum": ["person", "policy"], "default": "person"},
        "maxActive": {"type": "integer", "minimum": 1, "maximum": 20, "default": 2}
      }
    },
    "suspend": {"type": "boolean", "default": false},
    "pollMs": {"type": "integer", "minimum": 60000, "default": 300000},
    "retention": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "taskMs": {"type": "integer", "minimum": 0, "default": 3600000},
        "reviewMs": {"type": "integer", "minimum": 0, "default": 604800000}
      }
    }
  }
}
```

The rule "`snapshot` requires `output: post`" is not in the schema, so that the store's
refusal stays simple. The source's pass refuses it instead: it lists nothing and raises
`NeedsAttention/InvalidSpec`.

### Review spec schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["source", "forge", "project", "number", "url"],
  "properties": {
    "source": {"type": "string", "minLength": 1},
    "forge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "host"],
      "properties": {"kind": {"enum": ["github", "gitlab"]}, "host": {"type": "string"}}
    },
    "project": {"type": "string", "minLength": 1},
    "number": {"type": "integer", "minimum": 1},
    "url": {"type": "string", "pattern": "^https://[^\\s]+$"}
  }
}
```

### Status schemas

Both kinds declare a status schema, so the host refuses a plan whose status the plugin
did not mean to write. Each status schema requires `phase` as one of the kind's phases,
allows the fields in the tables above, and sets `additionalProperties: false` at the top
level. The implementation owns their full text.

### Manifest answer

```json
{"ok": true, "manifest": {
  "protocol": 1,
  "name": "fleet-reviewer",
  "kinds": [
    {"kind": "ReviewSource", "pollMs": 300000, "finalizer": false, "immutableSpec": false,
     "spec": {"…": "the ReviewSource spec schema"}, "status": {"…": "…"}},
    {"kind": "Review", "pollMs": 120000, "finalizer": true, "immutableSpec": true,
     "spec": {"…": "the Review spec schema"}, "status": {"…": "…"}}
  ]}}
```
