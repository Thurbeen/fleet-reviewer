// The Review controller: probes and reconcile, pure. The transition rules
// are docs/state-machine.md#transitions, checked in order.

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
  taskName,
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

function tasks(status: J): { name: string; uid?: string; after?: number }[] {
  const out = [...(status?.retiring ?? [])];
  if (status?.task?.name) out.push({ name: status.task.name, uid: status.task.uid });
  return out;
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

export function probes(req: J): J[] {
  const me = req.object;
  const obs = req.observations ?? {};
  const st = me.status ?? {};
  const out: J[] = [];
  const ask = (p: J) => {
    if (!(p.id in obs)) out.push(p);
  };
  ask({ id: "source", type: "object", kind: "ReviewSource", name: me.spec.source });
  if (st.task?.name) ask({ id: "task", type: "object", kind: "Task", name: st.task.name });
  for (const r of st.retiring ?? []) {
    ask({ id: `retiring/${r.name}`, type: "object", kind: "Task", name: r.name });
  }
  if (out.length) return out;

  const source = known(obs.source);
  if (!source.ok || !source.value || deleting(me)) return [];
  const spec = sourceSpec(source.value.spec);
  const { entry, missing } = listing(source.value, me.spec);
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
  const waiting =
    task.ok && task.value && !task.value.spec?.dispatch && sameHead(st.task?.head, entry?.head);
  if (spec.dispatch.by === "policy" && waiting) {
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

  // Every Task this Review holds, as the store answered.
  const held = tasks(st);
  const answer = (n: string) => known(obs[n === st.task?.name ? "task" : `retiring/${n}`]);
  const allGone = held.every((t) => {
    const a = answer(t.name);
    return a.ok && a.value == null;
  });
  const deleteAll = () =>
    held.flatMap((t) => {
      const a = answer(t.name);
      return a.ok && a.value && !deleting(a.value)
        ? [{ kind: "Task", name: a.value.metadata.name, uid: a.value.metadata.uid }]
        : [];
    });

  let status: J = {
    phase: st.phase ?? "Queued",
    observedGeneration: me.metadata.generation,
    head: st.head ?? null,
    task: st.task ?? null,
    reviews: st.reviews ?? [],
    cancelled: st.cancelled ?? [],
    retiring: st.retiring ?? [],
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
  const retire = (why: string): J => {
    const all = held.map((t) => ({ name: t.name, uid: t.uid }));
    status = { ...status, phase: "Retiring", task: null, retiring: all };
    status.conditions = conds(false, ["False", "Retiring"]);
    status.conditions.push(condition(oldConds, "Retiring", "True", why, "", now));
    const plan: J = { status, notBefore: now + RETIRE_MS };
    const deletes = deleteAll();
    if (deletes.length) plan.deletes = deletes;
    return plan;
  };

  // 1. Deleting: delete every Task, then let go.
  if (deleting(me)) {
    if (allGone) return { removeFinalizer: true };
    const deletes = deleteAll();
    return { ...(deletes.length ? { deletes } : {}), notBefore: now + RETIRE_MS };
  }

  // 2. Unknown source or task: no transition.
  const source = known(obs.source);
  const task = st.task?.name ? known(obs.task) : { ok: true as const, value: null };
  if (!source.ok || !task.ok) {
    return { notBefore: now + 300_000 };
  }

  // 3, 4. The source is gone, or no longer covers the project.
  if (source.value == null || deleting(source.value)) {
    if (st.phase === "Retiring" && allGone) return { delete: true };
    return retire("SourceGone");
  }
  const spec = sourceSpec(source.value.spec);
  if (!spec.repositories.some((r: J) => r.project === me.spec.project)) {
    if (st.phase === "Retiring" && allGone) return { delete: true };
    return retire("OutOfScope");
  }
  // 5. Retiring: wait until every Task is gone.
  if (st.phase === "Retiring") {
    return allGone
      ? { delete: true }
      : retire(String(oldConds.find((c) => c.type === "Retiring")?.reason ?? "Retiring"));
  }
  // 6. Settled past its retention.
  if (st.phase === "Settled" && now >= Number(st.settledAt ?? now) + spec.retention.reviewMs) {
    return retire("Settled");
  }

  const plan: J = {};
  const deletes: J[] = [];
  const t = task.value;
  if (t) status.task = { ...status.task, uid: t.metadata?.uid };

  // Concluded Tasks past their retention leave; gone ones drop off the list.
  status.retiring = (status.retiring as J[]).filter((r) => {
    const a = known(obs[`retiring/${r.name}`]);
    if (a.ok && a.value == null) return false;
    if (a.ok && a.value && !deleting(a.value) && now >= Number(r.after ?? 0)) {
      deletes.push({ kind: "Task", name: r.name, uid: a.value.metadata.uid });
    }
    return true;
  });

  // Record a concluded Task's result (rule 12), whatever the phase.
  let attention: [string, string] | undefined;
  const result = t?.status?.result;
  if (t && t.status?.phase === "Concluded" && result) {
    const head = result.outputs?.head;
    const briefed = [status.task.head, ...(status.task.told ?? [])];
    const expected = briefed.some((h: string) => sameHead(h, head));
    const report =
      typeof result.outputs?.report === "string"
        ? result.outputs.report.slice(0, REPORT_BYTES)
        : undefined;
    const entry: J = {
      head: expected ? head : status.task.head,
      task: t.metadata.name,
      outcome: result.outcome,
      at: now,
    };
    for (const k of ["confidence", "findings", "summaryUrl"]) {
      if (result.outputs?.[k] !== undefined) entry[k] = result.outputs[k];
    }
    if (report !== undefined) entry.report = report;
    if (!expected) attention = ["UnexpectedHead", `the result names head ${head}`];
    status.reviews = [entry, ...status.reviews].slice(0, MAX_REVIEWS);
    status.retiring = [
      ...status.retiring,
      { name: t.metadata.name, uid: t.metadata.uid, after: now + spec.retention.taskMs },
    ];
    status.task = null;
  }

  const { entry, missing } = listing(source.value, me.spec);
  const head: string | undefined = entry?.head ?? status.head?.sha;
  if (entry && !sameHead(status.head?.sha, entry.head)) {
    status.head = { sha: entry.head, seenAt: now };
  }
  const reviewedHead = (h: string | undefined) =>
    !!h && (status.reviews as J[]).some((r) => r.outcome === "shipped" && sameHead(r.head, h));
  const cancelledHead = (h: string | undefined) =>
    !!h && (status.cancelled as string[]).some((c) => sameHead(c, h));
  const cur = status.task;
  const curTask = cur ? t : null;
  const dispatched = !!curTask?.spec?.dispatch;

  const finish = (phase: string, notBefore: number, dispatchedCond: [string, string]) => {
    status.phase = phase;
    status.conditions = conds(reviewedHead(head), dispatchedCond, attention);
    plan.status = status;
    plan.notBefore = notBefore;
    if (deletes.length) plan.deletes = deletes;
    return plan;
  };
  const listingWait = Number(source.value.status?.notBefore ?? now + spec.pollMs) + 5000;
  const dropUndispatched = () => {
    if (curTask && !dispatched) {
      deletes.push({ kind: "Task", name: curTask.metadata.name, uid: curTask.metadata.uid });
      status.retiring = [...status.retiring, { name: cur.name, uid: curTask.metadata.uid }];
      status.task = null;
    }
  };

  // 7. Merged or closed.
  const change = known(obs.change);
  const state = change.ok ? change.value?.state : undefined;
  if (state === "merged" || state === "closed" || st.phase === "Settled") {
    if (!st.settledAt) status.settledAt = now;
    if (state) status.change = { state, checkedAt: now };
    dropUndispatched();
    return finish(
      "Settled",
      Math.min(Number(status.settledAt) + spec.retention.reviewMs, now + FOLLOW_MS * 10),
      ["False", "Settled"],
    );
  }
  // 8. Missing from the listing, and the forge says open or nothing.
  if (missing) {
    if (state) status.change = { state, checkedAt: now };
    return finish(status.phase, listingWait, ["False", "Waiting"]);
  }
  // 9. Suspended source: nothing is created or dispatched.
  if (spec.suspend) {
    return finish(status.phase, now + spec.pollMs, ["False", "Suspended"]);
  }
  // 10. Excluded by a filter.
  if (entry?.verdict === "excluded") {
    dropUndispatched();
    return finish("Excluded", listingWait, ["False", "Excluded"]);
  }
  if (!entry || !head) {
    return finish(status.phase, listingWait, ["False", "Waiting"]);
  }
  // 11. A person deleted the Task before it concluded.
  if (cur && t == null) {
    status.cancelled = [cur.head, ...status.cancelled].slice(0, MAX_CANCELLED);
    status.task = null;
    const other = (status.reviews as J[]).length > 0;
    return finish(other ? "Reviewed" : "Queued", listingWait, ["False", "Cancelled"]);
  }
  // 13. The Task is stuck: a person decides.
  const needs = curTask?.status?.conditions?.find(
    (c: J) => c.type === "NeedsAttention" && c.status === "True",
  );
  if (curTask && (curTask.status?.phase === "Stalled" || needs)) {
    attention = ["TaskNeedsAttention", `${cur.name}: ${needs?.reason ?? "Stalled"}`];
    return finish(status.phase, now + FOLLOW_MS, [dispatched ? "True" : "False", "TaskStuck"]);
  }
  // 14. The current head is reviewed or cancelled.
  if (!status.task && (reviewedHead(head) || cancelledHead(head))) {
    return finish("Reviewed", listingWait, ["False", "Reviewed"]);
  }
  // 15. No Task, or an undispatched Task for an older head: brief the current head.
  if (!status.task || (!sameHead(cur.head, head) && !dispatched)) {
    dropUndispatched();
    const tname = taskName(name, head);
    plan.creates = [reviewTask(me, spec, entry, head, tname)];
    status.task = { name: tname, head, told: [] };
    return finish("Queued", now + FOLLOW_MS, ["False", "Created"]);
  }
  // 16. A dispatched Task for an older head: tell it, once per head.
  if (!sameHead(cur.head, head)) {
    const told: string[] = cur.told ?? [];
    if (!told.some((h) => sameHead(h, head)) && cur.uid) {
      plan.appends = [
        {
          task: cur.name,
          uid: cur.uid,
          key: `head/${head}`,
          text:
            `The change's head moved to ${head} while you worked. Review what the new push added, ` +
            "and report that head as the `head` output.",
        },
      ];
      status.task = { ...cur, told: [...told, head] };
    }
    return finish("Reviewing", now + FOLLOW_MS, ["True", "Dispatched"]);
  }
  // 17, 18. The current head's Task waits for dispatch.
  if (!dispatched) {
    if (spec.dispatch.by === "policy") {
      const queue = known(obs.queue);
      if (queue.ok && cur.uid && firstInQueue(queue.value, cur.name, spec.dispatch.maxActive)) {
        plan.patches = [{ kind: "Task", name: cur.name, uid: cur.uid, spec: { dispatch: true } }];
        status.task = { ...cur, dispatched: { by: "policy", at: now } };
        return finish("Reviewing", now + FOLLOW_MS, ["True", "Dispatched"]);
      }
      return finish("Queued", now + FOLLOW_MS, ["False", "AtCapacity"]);
    }
    return finish("Queued", listingWait, ["False", "AwaitingPerson"]);
  }
  // 19. Dispatched, no result yet.
  if (!cur.dispatched) status.task = { ...cur, dispatched: { by: "person", at: now } };
  return finish("Reviewing", now + FOLLOW_MS, ["True", "Dispatched"]);
}

function reviewTask(
  me: J,
  spec: ReturnType<typeof sourceSpec>,
  entry: J,
  head: string,
  tname: string,
): J {
  const repo = spec.repositories.find((r: J) => r.project === me.spec.project);
  const repoName = String(me.spec.project).split("/").pop();
  const post = spec.review.output === "post";
  return {
    apiVersion: "fleet/v1alpha1",
    kind: "Task",
    metadata: {
      name: tname,
      labels: { [LABEL_SOURCE]: me.spec.source, [LABEL_REVIEW]: me.metadata.name },
    },
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
        tname,
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
