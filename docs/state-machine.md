# State machine

Fleet defines how an object of a plugin kind moves through one pass: probes, reconcile,
the gate, the status write, the verbs. This page defines what the plugin decides in that
pass. The [interface](interface.md) defines the probes and the plans.

![A Review starts Queued when its source lists an included change and creates a Task for the head, not dispatched. Dispatch moves it to Reviewing. A result for the current head moves it to Reviewed; a result for an older head moves it back to Queued. A new push moves Reviewed back to Queued. A filtered change moves Queued to Excluded, and back when it is included again. Any open state goes to Settled when the change is merged or closed, and to Retiring when it leaves scope, its source is gone or a person deletes it. Settled goes to Retiring after its retention. Retiring deletes every Task, then the Review. An Unknown answer causes no transition.](state-machine.svg)

## Inputs of a Review pass

A `Review` decides from four observations. Each is Known or Unknown.

| Observation | Probe | Asked |
| --- | --- | --- |
| `source` | Store: the `ReviewSource` named in `spec.source` | Every pass. |
| `task` | Store: the Task named in `status.task` | When `status.task` is set. |
| `retiring.<name>` | Store: each Task in `status.retiring` | When the list is not empty. |
| `queue` | Store: Tasks labelled `fleet-reviewer/source: <source>` | When a Task waits for dispatch under `policy`. |
| `change` | Plugin: `readChange`, one forge call | When the change is missing from the source's last complete listing. See [Closed changes](#closed-changes). |

The source's status carries the change as last listed: head, draft state, labels and the
filter verdict. A `Review` therefore reads the forge only to tell a closed change from
one that is no longer listed.

## Phases

| Phase | Meaning |
| --- | --- |
| `Queued` | A Task exists for the current head and is not dispatched. |
| `Reviewing` | The current Task is dispatched and has no result. |
| `Reviewed` | The current head has a recorded result. |
| `Excluded` | The source lists the change, and a filter excludes it. |
| `Settled` | The forge says the change is merged or closed. |
| `Retiring` | The `Review` deletes its Tasks, then itself. |

## Transitions

Rules are checked in order. The first rule that matches decides the pass.

| # | Condition | Next phase | Plan |
| --- | --- | --- | --- |
| 1 | The `Review` is deleting. | `Retiring` | Delete every Task it holds. Remove the finalizer once each Task probe answers `known: null`. |
| 2 | `source` is Unknown, or `task` is Unknown. | unchanged | Nothing but conditions. `notBefore = now + pollMs`. |
| 3 | `source` is `known: null`, or the source is deleting. | `Retiring` | Delete every Task, running ones included. |
| 4 | The project is no longer in the source's `spec.repositories`. | `Retiring` | Delete every Task, running ones included. A person narrowed the scope; this is the cancel. |
| 5 | `Retiring`, and every Task probe answers `known: null`. | gone | `delete: true`. |
| 6 | `Settled`, and `settledAt + retention.reviewMs` is past. | `Retiring` | Delete every Task. |
| 7 | `change` answers `merged` or `closed`. | `Settled` | Delete the current Task if it is not dispatched. A dispatched one finishes; thurview syncs a pass that was in progress once, then stops. |
| 8 | The change is missing from the listing, and `change` answers `open` or Unknown. | unchanged | Nothing. The next pass asks again, after the source's next listing. |
| 9 | The source is suspended. | unchanged | Nothing is created or dispatched. A running Task continues. |
| 10 | The listing excludes the change. | `Excluded` | Delete the current Task if it is not dispatched. A dispatched one finishes, and its result is recorded. |
| 11 | `task` is `known: null`, and its result was not recorded. | `Reviewed` if another head has a result, else `Queued` | Add the Task's head to `cancelled`. A person deleted it. No new Task for that head. |
| 12 | `task` concluded with a result. | `Reviewed` or `Queued` | Record the result in `reviews`. Add the Task to `retiring` after `retention.taskMs`. `Reviewed` when the result's `head` output is the current head; else `Queued`. |
| 13 | `task` is Stalled, or raises `NeedsAttention`. | unchanged | Raise `NeedsAttention` naming the Task's reason. A person decides. |
| 14 | The current head has a result or is `cancelled`. | `Reviewed` | Nothing. |
| 15 | No Task, or the Task is for an older head and not dispatched. | `Queued` | Delete the old Task. Create a Task for the current head, `dispatch: false`. |
| 16 | The Task is for an older head and is dispatched. | `Reviewing` | Append one inbox entry, "the head moved to `<sha>`", once per head. See [A new push](review-task.md#a-new-push). |
| 17 | The Task is for the current head, not dispatched, `dispatch.by: policy`, and the Task is first in the [queue](review-task.md#dispatch). | `Reviewing` | Patch the Task's `dispatch` to `true`. |
| 18 | The Task is for the current head and not dispatched. | `Queued` | Nothing. Set `Dispatched=False` with the reason: `AwaitingPerson` or `AtCapacity`. |
| 19 | The Task is dispatched and has no result. | `Reviewing` | Nothing. |

A person may dispatch a queued Task at any time, whatever the policy. Rule 19 then
applies on the next pass. The plugin never sets `dispatch` back to `false`.

## Timing

| Phase | `notBefore` |
| --- | --- |
| `Reviewing` | `now + 60000`: the plugin follows the Task closely. |
| `Queued` under `policy` | `now + 60000`: a slot may free up. |
| `Queued` under `person`, `Reviewed`, `Excluded` | The source's own `notBefore` plus 5000: nothing changes before the next listing. |
| `Settled` | `settledAt + retention.reviewMs`, or the next Task retention, whichever is first. |
| `Retiring` | `now + 30000`, until every Task is gone. |

A spec change of the source does not make its Reviews due. Rules 3 and 4 apply on each
Review's next pass, within the source's poll interval.

## A ReviewSource pass

A source has no phase machine of its own beyond `Listing`, `Suspended` and `Throttled`.
Each pass does this:

1. Read every `ReviewSource` from the store, and this source's Reviews by label.
2. Stop at `Suspended` when `spec.suspend` is `true`. Nothing is listed or created.
3. Stop at `Throttled` while any source on the same host has `throttle.until` in the
   future. `notBefore` is that time.
4. Read `whoami` when `account` is missing or older than one day.
5. List each repository that is due and fits in the host's remaining budget, oldest
   `listedAt` first. See [Rate limits](interface.md#rate-limits).
6. Replace the entries of each repository that answered Known. Keep the entries of each
   repository that answered Unknown.
7. Apply the [filters](kinds.md#filters) to every entry.
8. Create a `Review` for each included change that has none, at most 20 per pass. More
   wait for the next pass, which is due in 5 seconds.
9. Raise `Overlap` for each change whose `Review` names another source.

The source never deletes a `Review`. Each `Review` retires itself from what it reads.

## Closed changes

A listing holds open changes only. A change missing from the listing may be merged, closed
or beyond the listing's bound. Absence is not proof that the change closed. A `Review`
whose change is missing from the last complete listing asks the forge once, with
`readChange`:

| Answer | Decision |
| --- | --- |
| `merged` or `closed` | Rule 7: `Settled`. |
| `open` | Rule 8. The source raises `NeedsAttention/TooMany` when a listing reaches its bound. |
| Unknown | Rule 8. Asked again after the source's next listing. |

The `Review` does not ask while the host is throttled. It reads the throttle from its
source's status.

## Deletion

| Deleted object | What follows |
| --- | --- |
| A review Task, by a person | Rule 11: the head is `cancelled`. The plugin does not recreate it. |
| A `Review`, by a person | Rule 1: its Tasks are deleted, then the finalizer is removed. If the change is still listed, the source creates a new `Review` on its next pass. To stop reviewing a change, exclude it in the source. |
| A `ReviewSource`, by a person | Rule 3 on each `Review`: every Task is deleted, then each `Review`. |
| A Task the plugin deleted | The Task's own controller releases its session, as for any deletion. |

## Conditions

| Kind | Type | Status when |
| --- | --- | --- |
| `Review` | `Reviewed` | `True` when the current head has a result. |
| `Review` | `Dispatched` | `False/AwaitingPerson`, `False/AtCapacity`, `False/Suspended`, `True`. |
| `Review` | `NeedsAttention` | The Task stalled, a plan was refused (`host.error`), or a verb was refused (`host.verbs`). |
| `ReviewSource` | `Listed` | `True/Complete` when every repository answered Known on its last listing. |
| `ReviewSource` | `Throttled` | `True` while `throttle.until` is in the future. |
| `ReviewSource` | `Overlap` | `True` when another source owns one of this source's changes. |
| `ReviewSource` | `NeedsAttention` | `InvalidSpec`, `TooMany`, `Unauthorized`, or a refused plan. |

Each condition keeps its `lastTransitionTime` until its status changes, so a quiet pass
writes nothing new.
