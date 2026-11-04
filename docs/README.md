# Design

Status: implemented in `src/`. [Changes from the first draft](#changes-from-the-first-draft)
lists where the operator's request changed this design.

fleet-reviewer is a [Fleet](https://github.com/Thurbeen/fleet) plugin. It finds the open
pull and merge requests of a chosen set of repositories, and it starts one review Task per
change and per head commit. Each review Task reviews the change by its brief: a generic
review by default, or the `pr-review` flow of [thurview](https://github.com/Thurbeen/thurview)
as an optional template.
The plugin is an external plugin controller: it defines two kinds of its own and creates
ordinary Tasks. Fleet core gains nothing review-specific
([Thurbeen/fleet#351](https://github.com/Thurbeen/fleet/issues/351)).

| Read | Answers |
| --- | --- |
| [Kinds](kinds.md) | What do `ReviewSource` and `Review` hold, and what are their JSON Schemas? |
| [State machine](state-machine.md) | How does one `Review` move from a new change to a retired record? |
| [Interface](interface.md) | What does each protocol call do, and what does each plan contain? |
| [Review Task](review-task.md) | Which Task does the plugin create, with which brief, and how does it follow it? |
| [Configuration](configuration.md) | How is the plugin registered, and where do identities and credentials come from? |
| [Fleet core](fleet-core.md) | What does the plugin need that the plugin contract does not give today? |
| [Open questions](open-questions.md) | What is still to decide, with a recommendation for each? |

## One run

```mermaid
flowchart LR
  P[Person] -->|fleet apply| S[ReviewSource<br/>forge, repositories,<br/>filters, policy]
  S -->|observe: list open changes| F[(Forge API)]
  S -->|creates, one per included change| R[Review]
  R -->|creates, one per head| T[Task<br/>dispatch: false]
  R -->|patches dispatch, by: policy, the default| T
  P -.->|dispatch, when by: person| T
  T -->|review, post, approve at the threshold| F
  T -->|fleet result| R
```

1. A person applies a `ReviewSource`. It names one forge host, the token variable for that
   host, an explicit list of repositories, the filters, the TaskConfig the review Tasks run
   with, the output mode and the dispatch policy. The filter `requestedReviewer` names the
   user whose requested reviews the source follows.
2. On each due pass the source asks the forge for the open changes of each repository,
   through the plugin's bounded `observe` call. It records each change and the filter
   verdict in its status. With `requestedReviewer`, a change is included only while it
   requests that user's review. It creates one `Review` for each included change that has no
   `Review` yet.
3. Each `Review` reads its source and its current Task from the store. When the change's
   head has no review yet, the `Review` creates one Task for that head, with
   `dispatch: false`.
4. The policy dispatches the Task when fewer than `maxActive` review Tasks of the source
   run. This is the default. Under `dispatch.by: person`, a person dispatches it.
5. The Task's agent session reviews the change by its brief. It posts one summary and one
   thread per finding, or it only reports, as the source says. With `review.approveAt`, it
   approves the head it reviewed when its confidence reaches that value. It records a
   result with the head it reviewed and the confidence.
6. The `Review` reads the result and records it. A new push starts again at step 3 for the
   new head. A merged or closed change settles the `Review`; after a retention the `Review`
   deletes its Tasks and then itself.

## Why a plugin

- The decisions are review-specific: which changes, which filters, which brief. Fleet core
  stays a host for Tasks and controllers.
- The plugin contract already has every verb the flow needs: own kinds, Task create,
  `dispatch` patch, inbox append, Task delete, store probes and bounded forge reads.
- The plugin persists nothing outside the status of its objects. A crash between two passes
  loses nothing that the next pass cannot recompute.

## Rules

These rules generalise what manual review runs showed.

| Rule | Where it is kept |
| --- | --- |
| A review is scoped. A source names its repositories explicitly; there is no "every repository I can see". | [`ReviewSource.spec.repositories`](kinds.md#reviewsource) |
| Removing a repository from a source cancels its reviews, running ones included. | [State machine](state-machine.md#transitions) |
| Bots, deleted users, drafts, stale changes and the reviewer's own changes are excluded by default. | [Filters](kinds.md#filters) |
| Identity and harness are per forge. Each source names its token variable and its TaskConfig. | [Configuration](configuration.md#identities) |
| One review per head commit. A new push gets a new review; no head is reviewed twice. | [New push](review-task.md#a-new-push) |
| Posting or report-only is a setting, and posting is the default. | [`review.output`](kinds.md#reviewsource) |
| A source can follow one user's requested reviews only. | [`filters.requestedReviewer`](kinds.md#filters) |
| Review Tasks are dispatched by the policy by default. | [`dispatch.by`](kinds.md#reviewsource) |
| Approval is optional, per source, and only of the head the Task reviewed. | [`review.approveAt`](kinds.md#reviewsource) |
| A review can run without publishing a page, and that is the default. | [`review.page`](kinds.md#reviewsource) |
| At most `maxActive` review Tasks of a source run at once. | [Dispatch](review-task.md#dispatch) |
| Forge calls stay under a per-host budget and back off on a rate limit. | [Rate limits](interface.md#rate-limits) |
| An Unknown answer never means absent, closed or empty. | [Unknown answers](interface.md#unknown-answers) |

## Scope

In scope: GitHub and GitLab, on their public hosts and self-hosted; discovery, filters,
one Task per head, dispatch by policy or by a person, following the Task, retiring what
the plugin made.

Out of scope, deliberately:

- Posting on the forge from the plugin. Every forge write is the review Task's. The
  plugin plans no effects.
- Merging or closing a change. The plugin and the brief add no verb for these. Approving
  is in scope only as the review Task's act, at `review.approveAt`.
- Reviewing a change that is not in a source's repositories, however it is found.
- Other forges. The observer half has one adapter per forge; adding one is a later change.

## Changes from the first draft

The operator's request changed the first draft of this design in these places:

| Change | First draft | Now | Why |
| --- | --- | --- | --- |
| Requested reviewer | Every open change of a repository is reviewed. | `filters.requestedReviewer` includes only the changes that request one user's review. On GitHub, a change that user already reviewed stays included while its `Review` exists, because GitHub drops a reviewer from the request after the review. | The request: review every change where the user is a requested reviewer. |
| Dispatch | `dispatch.by` defaults to `person`. | `dispatch.by` defaults to `policy`. | The request: review Tasks start automatically. |
| Output | `review.output` defaults to `report`. | `review.output` defaults to `post`. | The request: post a summary and inline threads. |
| Approval | Out of scope. | `review.approveAt`, 1 to 5, optional. The brief tells the Task to approve the head it reviewed when its confidence reaches the value. The plugin still writes nothing on a forge. | The request: an optional approve threshold. |
| Brief | thurview's `pr-review` flow only. | `review.template`: `generic`, the default, or `thurview`. | The plugin must not depend on one review tool. |
| Stop label | `excludeLabels` defaults to `thurview:stop`. | `review:stop`. | The same reason. |
| Distribution | A bundled `dist/plugin.js`. | `src/plugin.ts`, which Node.js 22.18 or later runs as is. No build and no runtime dependency. | The operator installs no new binary and no package. |
| Test forge | None. | `forge.kind: fake`, which reads Fleet's fake-forge files. Only the tests use it. | The end-to-end tests run against Fleet's fake forge and runtime. |
