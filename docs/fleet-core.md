# Fleet core

The design uses Fleet's plugin contract as it stands on `main` at
[`aa69bad`](https://github.com/Thurbeen/fleet/commit/aa69bad). It needs no change to
Fleet to work. This page lists where the contract is thin for a reviewer, what the plugin
does instead, and the change proposed to Fleet. Each proposal is to be filed on
Thurbeen/fleet once the design is approved, and none is assumed by the design.

| # | Proposal | Without it | Priority |
| --- | --- | --- | --- |
| 1 | A host budget for plugin probes | The plugin meters its own calls per host through its sources' statuses. | High |
| 2 | A dispatch verb | A person re-applies the Task with `dispatch: true`. | Medium |
| 3 | Observer environment per request | Every `observe` call receives every token. | Medium |
| 4 | Schema refusals that name the field | `apply` of a wrong `ReviewSource` says only that the schema refused it. | Medium |
| 5 | None: confirmations | The facts the design relies on, read in the source. | — |

## 1. A host budget for plugin probes

**Gap.** The manager runs plugin probes one after another with no per-host meter.
[Thurbeen/fleet#334](https://github.com/Thurbeen/fleet/issues/334) asks for a per-host
poll interval, call budget and back-off for ChangeRequests. The plugin has the same need,
and its calls hit the same forge accounts.

**Instead.** Sources on one host share a budget through their statuses, as
[Rate limits](interface.md#rate-limits) describes. It is exact inside one sweep. It does
not see Fleet's own ChangeRequest polls on the same host, nor a Review's `readChange`.

**Proposal.** A plugin probe may carry `"meter": {"host": "<host>", "calls": <n>}`. The
manager charges `n` against the host's `maxCallsPerMinute` from `[forge.hosts]`, the same
budget #334 adds for ChangeRequests. When the budget cannot cover the probe, the manager
answers `unknown {why: "Budget", retryAfterMs}` without running `observe`. A `Throttled`
answer with `retryAfterMs` backs off the whole host, for ChangeRequests and plugins alike.

## 2. A dispatch verb

**Gap.** `dispatch` is the only Task field a person changes after creation, and `apply` is
the only verb that changes it. `apply` needs the whole manifest, without status and
without `fleet.dev/plugin`, so dispatching a plugin's Task by hand takes a `jq` program
([Dispatching by hand](configuration.md#dispatching-by-hand)).

**Proposal.** `fleet dispatch TASK [--off]`, a manager verb that writes `spec.dispatch`
alone, under the same rules as `apply`.

## 3. Observer environment per request

**Gap.** Every `observe` and `perform` call receives every variable of `passEnv` and
`envFrom`. One plugin that reads two clients' forges holds both clients' tokens in every
call.

**Instead.** Each request names its token variable, and `observe` reads only that one.
This is a rule the plugin keeps, not a boundary Fleet enforces.

**Proposal.** `[plugins.<name>.envSets.<set>]`, each an `envFrom` list, and a plugin probe
field `"envSet": "<set>"`. The manager resolves only that set for that call. A probe that
names an unknown set is refused by the gate.

## 4. Schema refusals that name the field

**Gap.** The store validates a plugin spec with `jsonschema::validator_for` and maps any
failure to `plugin value fails JSON Schema`
(`crates/fleet-store/src/lib.rs`, `fn schema`). The plugin kinds page says the refusal
carries the schema's message, but the message is dropped. A person who mistypes a field
of a 30-line `ReviewSource` learns nothing about which one.

**Proposal.** Keep the first validation error's instance path and message in the
refusal, as the plugin kinds page already promises. The same for status validation, so
`host.error` names the status field a plugin got wrong.

## 5. Confirmations

These are facts the design relies on. Each was read in the Fleet source at `aa69bad`;
none is a change request.

| Fact | Where |
| --- | --- |
| The gate admits `patches` on a Task for `dispatch` and `forge` only, and only on this plugin's Tasks under `tasks = "own"`. | `crates/fleet-controllers/src/plugin.rs` |
| The manager reads each patched, appended or deleted Task from the store before admission, so a plan names Tasks by name and `uid`. | `crates/fleet-manager/src/plugins.rs` |
| `apply` refuses `fleet.dev/plugin` in a manifest and keeps the stored one. | `crates/fleet-store/src/lib.rs` |
| An object is due when `notBefore` is past or the spec generation moved. | `crates/fleet-manager/src/plugins.rs` |
| A `list` probe filters by labels and answers Unknown `TooMany` above 200. | `crates/fleet-manager/src/plugins.rs` |
| Labels other than `fleet.dev/plugin` are free. | No label key validation found in `fleet-api` or `fleet-store`. |

Not needed, deliberately: a plugin-owned status on Task, a forge write port for plugins,
and a persistent plugin process. The review Task writes on the forge as any worker does,
and the plugin follows it through the Task's public status.
