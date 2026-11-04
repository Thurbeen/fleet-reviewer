// The Review controller: probes and reconcile, pure. One review Task per
// change, named after the Review, kept until the change merges or closes.
// A push amends it. The transition rules are docs/state-machine.md#transitions,
// checked in order.

import { brief } from "./brief.ts";
import {
  type J,
  LABEL_REVIEW,
  LABEL_SOURCE,
  changeKey,
  condition,
  known,
  sameHead,
  sourceSpec,
} from "./util.ts";

const ACTIVE = ["Pending", "Spawning", "Spawned", "Briefed"];
const MAX_REVIEWS = 10;
const MAX_CANCELLED = 20;
const REPORT_BYTES = 16 * 1024;
const FOLLOW_MS = 60_000;
const RETIRE_MS = 30_000;

function deleting(o: J): boolean {
  return o?.metadata?.deletionTimestamp != null;
}

/** What the source's status says about this change. */
function listing(source: J, spec: J) {
  const key = changeKey(spec.project, spec.number);
  const st = source?.status ?? {};
  const entry = st.changes?.[key];
  const repo = st.repositories?.[spec.project];
  const complete = !!repo?.listedAt && !(repo.unknown && repo.unknown.at >= repo.listedAt);
  return { entry, missing: !entry && complete };
}

/** The amendment text for a new head. The head in it is how a pass sees it was sent. */
export function amendText(head: string): string {
  return (
    `The change's head moved to ${head}. Review what the new push added since the head you ` +
    `last reviewed, then record a result for this generation with --output head='"${head}"'.`
  );
}

/** Heads the Task was asked to review: its brief's, then one per amendment. */
function askedHeads(task: J, briefed: string | undefined): string[] {
  const out = briefed ? [briefed] : [];
  for (const a of task?.spec?.amendments ?? []) {
    const m = /head moved to ([0-9a-f]{7,64})/i.exec(String(a?.text ?? ""));
    if (m) out.push(m[1]);
  }
  return out;
}

export function probes(req: J): J[] {
  const me = req.object;
  const obs = req.observations ?? {};
  const st = me.status ?? {};
  const out: J[] = [];
  const ask = (p: J) => {
    if (!(p.id in obs)) out.push(p);
  };
  ask({ id: "source", type: "object", kind: "ReviewSource", name: me.spec.source });
  ask({ id: "task", type: "object", kind: "Task", name: me.metadata.name });
  if (out.length) return out;

  const source = known(obs.source);
  if (!source.ok || !source.value || deleting(me)) return [];
  const spec = sourceSpec(source.value.spec);
  const { missing } = listing(source.value, me.spec);
  const throttled = Number(source.value.status?.throttle?.until ?? 0) > Number(req.now ?? 0);
  if (missing && !throttled && st.phase !== "Settled") {
    const { kind, host, apiUrl, tokenEnv } = spec.forge;
    ask({
      id: "change",
      type: "plugin",
      request: {
        op: "readChange",
        forge: { kind, host, apiUrl, tokenEnv },
        project: me.spec.project,
        number: me.spec.number,
      },
    });
  }
  const task = known(obs.task);
  if (spec.dispatch.by === "policy" && task.ok && task.value && !task.value.spec?.dispatch) {
    ask({ id: "queue", type: "list", kind: "Task", labels: { [LABEL_SOURCE]: me.spec.source } });
  }
  return out;
}

/** Is `mine` among the Tasks the policy may dispatch now? (docs/review-task.md#dispatch) */
function firstInQueue(queue: J[], mine: string, maxActive: number): boolean {
  const live = queue.filter((t) => !deleting(t));
  const active = live.filter(
    (t) => t.spec?.dispatch && ACTIVE.includes(t.status?.phase ?? "Pending"),
  ).length;
  const free = maxActive - active;
  if (free <= 0) return false;
  const waiting = live
    .filter((t) => !t.spec?.dispatch)
    .sort(
      (a, b) =>
        Number(a.metadata?.creationTimestamp ?? 0) - Number(b.metadata?.creationTimestamp ?? 0) ||
        String(a.metadata?.name).localeCompare(String(b.metadata?.name)),
    );
  return waiting.slice(0, free).some((t) => t.metadata?.name === mine);
}

export function reconcile(req: J): J {
  const me = req.object;
  const obs = req.observations ?? {};
  const now = Number(req.now ?? 0);
  const name = me.metadata.name;
  const st = me.status ?? {};
  const oldConds: J[] = st.conditions ?? [];

  const status: J = {
    phase: st.phase ?? "Queued",
    observedGeneration: me.metadata.generation,
    head: st.head ?? null,
    task: st.task ?? null,
    reviews: st.reviews ?? [],
    cancelled: st.cancelled ?? [],
    change: st.change ?? { state: "open", checkedAt: null },
    conditions: oldConds,
  };
  if (st.settledAt) status.settledAt = st.settledAt;
  const conds = (reviewed: boolean, dispatched: [string, string], attention?: [string, string]) => [
    condition(
      oldConds,
      "Reviewed",
      reviewed ? "True" : "False",
      reviewed ? "Reviewed" : "NotYet",
      "",
      now,
    ),
    condition(
      oldConds,
      "Dispatched",
      dispatched[0] === "True" ? "True" : "False",
      dispatched[1],
      "",
      now,
    ),
    attention
      ? condition(oldConds, "NeedsAttention", "True", attention[0], attention[1], now)
      : condition(oldConds, "NeedsAttention", "False", "None", "", now),
  ];

  const source = known(obs.source);
  const task = known(obs.task);
  const t = task.ok ? task.value : undefined;
  const deleteTask = () =>
    t && !deleting(t) ? [{ kind: "Task", name: t.metadata.name, uid: t.metadata.uid }] : [];

  // 1. Deleting: delete the Task, then let go.
  if (deleting(me)) {
    if (task.ok && t == null) return { removeFinalizer: true };
    const deletes = deleteTask();
    return { ...(deletes.length ? { deletes } : {}), notBefore: now + RETIRE_MS };
  }
  // 2. Unknown source or Task: no transition.
  if (!source.ok || !task.ok) return { notBefore: now + 300_000 };

  const retire = (why: string): J => {
    if (st.phase === "Retiring" && t == null) return { delete: true };
    status.phase = "Retiring";
    status.task = null;
    status.conditions = [
      ...conds(false, ["False", "Retiring"]),
      condition(oldConds, "Retiring", "True", why, "", now),
    ];
    const deletes = deleteTask();
    return { status, notBefore: now + RETIRE_MS, ...(deletes.length ? { deletes } : {}) };
  };
  // 3, 4, 5. The source is gone or no longer covers the project; or retiring.
  if (source.value == null || deleting(source.value)) return retire("SourceGone");
  const spec = sourceSpec(source.value.spec);
  if (!spec.repositories.some((r: J) => r.project === me.spec.project)) return retire("OutOfScope");
  if (st.phase === "Retiring") {
    return retire(String(oldConds.find((c) => c.type === "Retiring")?.reason ?? "Retiring"));
  }
  // 6. Settled past its retention.
  if (st.phase === "Settled" && now >= Number(st.settledAt ?? now) + spec.retention.reviewMs) {
    return retire("Settled");
  }

  const plan: J = {};
  let deletes: J[] = [];
  let attention: [string, string] | undefined;
  if (t) status.task = { ...(status.task ?? {}), name, uid: t.metadata.uid };

  // Record each new result, one per generation, whatever the phase.
  const result = t?.status?.result;
  const recorded = (status.reviews as J[]).some(
    (r) => r.task === t?.metadata?.uid && r.generation === result?.generation,
  );
  if (result && !recorded) {
    const head = result.outputs?.head;
    const expected = askedHeads(t, status.task?.head).some((h) => sameHead(h, head));
    const entry: J = {
      head,
      generation: result.generation,
      task: t.metadata.uid,
      outcome: result.outcome,
      at: now,
    };
    for (const k of ["confidence", "findings", "summaryUrl"]) {
      if (result.outputs?.[k] !== undefined) entry[k] = result.outputs[k];
    }
    if (typeof result.outputs?.report === "string") {
      entry.report = result.outputs.report.slice(0, REPORT_BYTES);
    }
    if (!expected) {
      attention = ["UnexpectedHead", `the result names head ${head}`];
      entry.outcome = "unexpected-head";
    }
    status.reviews = [entry, ...status.reviews].slice(0, MAX_REVIEWS);
  }

  const { entry, missing } = listing(source.value, me.spec);
  const head: string | undefined = entry?.head ?? status.head?.sha;
  if (entry && !sameHead(status.head?.sha, entry.head))
    status.head = { sha: entry.head, seenAt: now };
  const reviewedHead = (h: string | undefined) =>
    !!h && (status.reviews as J[]).some((r) => r.outcome === "shipped" && sameHead(r.head, h));
  const cancelledHead = (h: string | undefined) =>
    !!h && (status.cancelled as string[]).some((c) => sameHead(c, h));
  const dispatched = !!t?.spec?.dispatch;

  const finish = (phase: string, notBefore: number, dispatchedCond: [string, string]) => {
    status.phase = phase;
    status.conditions = conds(reviewedHead(head), dispatchedCond, attention);
    plan.status = status;
    plan.notBefore = notBefore;
    if (deletes.length) plan.deletes = deletes;
    return plan;
  };
  const listingWait = Number(source.value.status?.notBefore ?? now + spec.pollMs) + 5000;

  // 7. Merged or closed: the review ends with the change.
  const change = known(obs.change);
  const state = change.ok ? change.value?.state : undefined;
  if (state === "merged" || state === "closed" || st.phase === "Settled") {
    if (!st.settledAt) status.settledAt = now;
    if (state) status.change = { state, checkedAt: now };
    deletes = deleteTask();
    status.task = null;
    return finish(
      "Settled",
      Math.min(Number(status.settledAt) + spec.retention.reviewMs, now + 10 * FOLLOW_MS),
      ["False", "Settled"],
    );
  }
  // 8. Missing from the listing, and the forge says open or nothing.
  if (missing) {
    if (state) status.change = { state, checkedAt: now };
    return finish(status.phase, listingWait, ["False", "Waiting"]);
  }
  // 9. Suspended source: nothing is created, amended or dispatched.
  if (spec.suspend) return finish(status.phase, now + spec.pollMs, ["False", "Suspended"]);
  // 10. Excluded by a filter, the requested reviewer included: the review stops.
  if (entry?.verdict === "excluded") {
    deletes = deleteTask();
    status.task = null;
    return finish("Excluded", listingWait, ["False", "Excluded"]);
  }
  if (!entry || !head) return finish(status.phase, listingWait, ["False", "Waiting"]);

  // 11. A person deleted the Task: this head is cancelled; the next push starts again.
  if (st.task?.uid && t == null) {
    status.cancelled = [st.task.head ?? head, ...status.cancelled].slice(0, MAX_CANCELLED);
    status.task = null;
    return finish("Reviewed", listingWait, ["False", "Cancelled"]);
  }
  // 12. The Task is stuck: a person decides.
  const needs = t?.status?.conditions?.find(
    (c: J) => c.type === "NeedsAttention" && c.status === "True",
  );
  if (t && (t.status?.phase === "Stalled" || needs)) {
    attention = ["TaskNeedsAttention", `${name}: ${needs?.reason ?? "Stalled"}`];
    return finish(status.phase, now + FOLLOW_MS, [dispatched ? "True" : "False", "TaskStuck"]);
  }
  // 13. No Task: brief one for the current head, unless that head is done or cancelled.
  if (!t) {
    if (cancelledHead(head) || reviewedHead(head)) {
      return finish("Reviewed", listingWait, ["False", "Reviewed"]);
    }
    plan.creates = [reviewTask(me, spec, entry, head)];
    status.task = { name, head };
    return finish("Queued", now + FOLLOW_MS, ["False", "Created"]);
  }
  // A Task being deleted (after an exclusion) comes back once it is gone.
  if (deleting(t)) return finish(status.phase, now + FOLLOW_MS, ["False", "Waiting"]);
  status.task.head ??= head;

  // 14. A head the Task was not asked about: amend it, fenced on its generation.
  if (!askedHeads(t, status.task.head).some((h) => sameHead(h, head))) {
    plan.amends = [
      {
        task: name,
        uid: t.metadata.uid,
        text: amendText(head),
        reason: "the change's head moved",
        ifGeneration: t.metadata.generation,
      },
    ];
  }
  // 15, 16. Waiting for dispatch.
  if (!dispatched) {
    if (spec.dispatch.by === "policy") {
      const queue = known(obs.queue);
      if (queue.ok && firstInQueue(queue.value, name, spec.dispatch.maxActive)) {
        plan.patches = [{ kind: "Task", name, uid: t.metadata.uid, spec: { dispatch: true } }];
        status.task = { ...status.task, dispatched: { by: "policy", at: now } };
        return finish("Reviewing", now + FOLLOW_MS, ["True", "Dispatched"]);
      }
      return finish("Queued", now + FOLLOW_MS, ["False", "AtCapacity"]);
    }
    return finish("Queued", listingWait, ["False", "AwaitingPerson"]);
  }
  if (!status.task.dispatched) {
    status.task = { ...status.task, dispatched: { by: "person", at: now } };
  }
  // 17, 18. Reviewed once the current head has a result; else the Task works on it.
  if (!plan.amends && reviewedHead(head)) {
    return finish("Reviewed", listingWait, ["True", "Dispatched"]);
  }
  return finish("Reviewing", now + FOLLOW_MS, ["True", "Dispatched"]);
}

function reviewTask(me: J, spec: ReturnType<typeof sourceSpec>, entry: J, head: string): J {
  const repo = spec.repositories.find((r: J) => r.project === me.spec.project);
  const repoName = String(me.spec.project).split("/").pop();
  const post = spec.review.output === "post";
  const name = me.metadata.name;
  return {
    apiVersion: "fleet/v1alpha1",
    kind: "Task",
    metadata: { name, labels: { [LABEL_SOURCE]: me.spec.source, [LABEL_REVIEW]: name } },
    spec: {
      configRef: { name: spec.review.taskConfig },
      workspace: { repositories: [{ name: repoName, url: repo?.url }] },
      brief: brief(
        spec,
        {
          url: me.spec.url,
          head,
          base: entry.base ?? "",
          title: entry.title ?? "",
          author: entry.author?.login ?? "",
        },
        name,
      ),
      dispatch: false,
      outputs: {
        head: { type: "string", required: true },
        confidence: { type: "integer", required: false },
        findings: { type: "integer", required: false },
        [post ? "summaryUrl" : "report"]: { type: "string", required: false },
      },
    },
  };
}
