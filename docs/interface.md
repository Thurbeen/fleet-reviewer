# Interface

The plugin speaks Fleet's plugin protocol 1, as the
[plugin interface](https://github.com/Thurbeen/fleet/blob/main/docs/controllers/plugin/interface.md)
defines it. It is one Node.js program. The manager runs it once per call, with the call
name as its last argument and one JSON request on stdin.

| Call | Half | What this plugin does |
| --- | --- | --- |
| `manifest` | Controller, pure | Answers the two [kinds](kinds.md#manifest) and their schemas. |
| `probes` | Controller, pure | Answers the store and forge reads that the pass still lacks. |
| `reconcile` | Controller, pure | Answers a plan from the object, the observations and `now`. |
| `observe` | Observer, bounded | Reads one forge fact over HTTPS with the token the request names. |
| `perform` | Observer, bounded | Plans nothing; answers `failed` with `NoEffects`. |

The controller half reads no file, variable, clock or network. Everything it decides
arrives in the request. The observer half reads the token variables and the forge, and
nothing else.

## `probes`

The manager asks in rounds, at most three. Each answer names only what the observations
still lack.

### ReviewSource

| Round | Probe id | Probe | When |
| --- | --- | --- | --- |
| 1 | `sources` | `list ReviewSource` | Always. Gives the host's budget and throttle. |
| 1 | `reviews` | `list Review {fleet-reviewer/source: <name>}` | Always. Gives the Reviews this source has. |
| 2 | `whoami` | `plugin {op: "whoami", …}` | `account` is missing or older than one day, and the host is not throttled. |
| 2 | `list/<project>` | `plugin {op: "listChanges", …}` | Per due repository, within the budget. See [Rate limits](#rate-limits). |
| 3 | `headAt/<project>!<number>` | `plugin {op: "readHeadDate", …}` | GitLab only, per change whose head is new, within the budget. |

### Review

| Round | Probe id | Probe | When |
| --- | --- | --- | --- |
| 1 | `source` | `object ReviewSource <spec.source>` | Always. |
| 1 | `task` | `object Task <status.task.name>` | `status.task` is set. |
| 1 | `retiring/<name>` | `object Task <name>` | Per Task in `status.retiring`. |
| 2 | `queue` | `list Task {fleet-reviewer/source: <spec.source>}` | The current Task waits for dispatch under `policy`. |
| 2 | `change` | `plugin {op: "readChange", …}` | The change is missing from the source's last complete listing, and the host is not throttled. |

Store probes cost no forge call and no lease renewal. A `list` answers at most 200
objects, else Unknown with `TooMany`.

## `observe`

Each request is one forge read. Every request carries the forge and the name of the
token variable, because the observer half receives nothing else of the object:

```json
{"protocol": 1, "plugin": "fleet-reviewer", "call": "observe", "id": "o1",
 "probe": {"id": "list/OWNER/app", "request": {
   "op": "listChanges",
   "forge": {"kind": "github", "apiUrl": "https://api.github.com", "tokenEnv": "REVIEWER_TOKEN_A"},
   "project": "OWNER/app", "maxCalls": 3}}}
```

| `op` | Reads | Known answer | Calls |
| --- | --- | --- | --- |
| `whoami` | The authenticated account | `{login, calls}` | 1 |
| `listChanges` | Every open change of one project, every page | `{changes: [{number, url, title, author: {login, kind}, draft, head, headAt, base, labels}], calls}` | 1 per 100 changes, at most `maxCalls` |
| `readChange` | One change | `{state: "open" \| "merged" \| "closed", head, calls}` | 1 |
| `readHeadDate` | One commit (GitLab) | `{headAt, calls}` | 1 |

`author.kind` is `user`, `bot` or `deleted`, decided per forge as
[Filters](kinds.md#filters) says. `calls` is the number of HTTP requests the answer cost,
so the source counts what it spent.

A list is complete or it is Unknown. `listChanges` answers Unknown with `TooManyPages`
when the open changes need more than `maxCalls` pages; it never answers the first pages
alone.

| Forge answer | `observe` answer |
| --- | --- |
| 2xx, complete | `known` |
| 401 | `unknown {why: "Unauthorized"}` |
| 403 or 429 with a rate-limit header, or a GitHub secondary rate limit | `unknown {why: "Throttled", retryAfterMs}` from `Retry-After`, else from the reset header, else 60000 |
| 404 on a project | `unknown {why: "NotFound"}`. A token without access sees the same answer as a missing project. |
| 5xx, timeout, network error, unparsable body | `unknown {why: …}` |
| The variable `tokenEnv` names is unset or empty | `unknown {why: "NoToken"}` |

`observe` always exits zero with one answer. An answer of Unknown is not a failed call:
Fleet counts three failed calls of one type as an unavailable plugin, and an
unavailable plugin's objects are not reconciled.

## `reconcile`

A plan uses `status`, `notBefore`, `creates`, `patches`, `appends`, `deletes`, `delete`
and `removeFinalizer`. It never uses `declares` or `effects`.

A `ReviewSource` plan, after a listing that found one new included change:

```json
{"id": "r1", "ok": true, "plan": {
  "status": {"phase": "Listing", "observedGeneration": 3, "changes": {"…": "…"},
             "budget": {"minute": 28833338, "calls": 2}, "throttle": null,
             "conditions": ["…"]},
  "notBefore": 1730000600000,
  "creates": [
    {"apiVersion": "fleet/v1alpha1", "kind": "Review",
     "metadata": {"name": "rv-app-88-1b7d02", "labels": {"fleet-reviewer/source": "app"}},
     "spec": {"source": "app", "forge": {"kind": "github", "host": "github.com"},
              "project": "OWNER/app", "number": 88,
              "url": "https://github.com/OWNER/app/pull/88"}}
  ]}}
```

A `Review` plan, for a new head while the Task for the old head is still queued:

```json
{"id": "r2", "ok": true, "plan": {
  "status": {"phase": "Queued", "head": {"sha": "9f3c…", "seenAt": 1730000300000},
             "task": {"name": "rv-app-88-1b7d02-9f3c2a1e0b7d", "head": "9f3c…", "told": []},
             "retiring": [{"name": "rv-app-88-1b7d02-4a1d00c3e9f2", "uid": "…"}],
             "conditions": ["…"]},
  "notBefore": 1730000605000,
  "deletes": [{"kind": "Task", "name": "rv-app-88-1b7d02-4a1d00c3e9f2", "uid": "…"}],
  "creates": [{"apiVersion": "fleet/v1alpha1", "kind": "Task", "metadata": {"…": "…"},
               "spec": {"…": "see the review Task"}}]}}
```

The [review Task](review-task.md#the-task) page shows the Task the plan creates, and the
[state machine](state-machine.md#transitions) lists which plan each rule returns.

### Verbs and the gate

| Verb | Used for | Gate rule this plan meets |
| --- | --- | --- |
| `creates` | A `Review` (source), a Task (review) | Own kind or Task; no status, `uid`, finalizer or `fleet.dev/plugin` label; at most 20. |
| `patches` | `{"dispatch": true}` on a review Task | Task, `dispatch` only, `uid` matches, the Task carries this plugin's label under `tasks = "own"`. |
| `appends` | The "head moved" message to a running review Task | The Task is this plugin's; key `head/<sha>`, unique for the Task. |
| `deletes` | A review Task | By name and `uid`; the Task is this plugin's. |
| `delete` | The `Review` itself, last | Not deleting already. |
| `removeFinalizer` | A deleting `Review`, once its Tasks are gone | The object is deleting and holds this plugin's finalizer. |

The plugin learns a created Task's `uid` from the `task` probe on the next pass. It plans
no `patches`, `appends` or `deletes` against a Task whose `uid` it has not recorded,
because Fleet fences those verbs on the `uid`.

## `perform`

The plugin plans no effects. Every forge write is the review Task's, through thurview, so
a write happens in a session that a person can watch and stop. `perform` answers
`{"outcome": {"failed": {"why": "NoEffects"}}}` and writes nothing.

## Rate limits

Every forge call the plugin makes counts against its host. The review sessions' own calls
do not: `dispatch.maxActive` bounds them.

| Rule | Value |
| --- | --- |
| Host budget | The smallest `forge.maxCallsPerMinute` among the sources on that host. |
| Spent this minute | The sum of `budget.calls` of the sources on that host whose `budget.minute` is the current minute. |
| Before a probe | The source asks only the probes whose declared `maxCalls` fit in what remains. Repositories wait oldest `listedAt` first, so none starves. |
| After a `Throttled` answer | `throttle.until = now + retryAfterMs × 2^streak`, capped at one hour. Every source on that host reads it and waits. |
| After a Known answer | `throttle` is cleared. |
| A Review's `readChange` | Asked only while its source is not throttled. It is not counted: it happens once per change that leaves the listing. |

The sources are reconciled one after another in one manager sweep, so each source reads
the budget its siblings wrote before it. A second manager is excluded by Fleet's lease.

Fleet core does not meter plugin probes per host today. [Fleet core](fleet-core.md#1-a-host-budget-for-plugin-probes)
proposes it; this in-plugin budget then becomes the fallback.

## Unknown answers

An Unknown answer never means absent, closed, empty or excluded.

| Unknown observation | Decision |
| --- | --- |
| A listing | The repository keeps its previous entries. No `Review` is created or retired from it. |
| `whoami` | `ownChanges` filtering uses the last known login. With none, no change is included until it is known. |
| `readHeadDate` | The change is not included until its head date is known. |
| `source` or `task` in a `Review` | No transition. No Task is created, dispatched or deleted. |
| `readChange` | The `Review` stays as it is. |
| `queue` | No dispatch this pass. |

A plan refused by Fleet's gate, or a failed call, leaves the status as it was and sets
`host.error`. The next pass raises `NeedsAttention` from it.

## Bounds

| Item | Bound |
| --- | --- |
| One call | The registration's `callTimeoutMs`. A listing that may not fit is split by repository, one probe each. |
| Repositories per source | 50. |
| Listed changes per source | 200 entries in `status.changes`; past that, `NeedsAttention/TooMany`. |
| Reviews per source | 200, Fleet's `list` bound. Settled Reviews retire after `retention.reviewMs`. |
| `creates` per plan | 20. |
| `reviews` kept per `Review` | 10, and 16 KiB per report. |
| Status size | Fleet's 256 KiB per plan; the bounds above keep a source well under it. |
