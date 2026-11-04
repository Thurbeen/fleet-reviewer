import { describe, expect, it } from "vitest";
import { brief } from "../src/brief.ts";
import * as review from "../src/review.ts";
import * as source from "../src/source.ts";
import { reviewName, sourceSpec, taskName } from "../src/util.ts";

const NOW = 1_800_000_000_000;
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const P = "OWNER/app";

function src(spec: any = {}, status: any = {}): any {
  return {
    kind: "ReviewSource",
    metadata: { name: "app", generation: 1 },
    spec: {
      forge: { kind: "github", host: "github.com", tokenEnv: "REVIEWER_TOKEN_A" },
      repositories: [{ project: P }],
      review: { taskConfig: "review" },
      filters: { requestedReviewer: "alice" },
      ...spec,
    },
    status,
  };
}

function pr(n: number, extra: any = {}): any {
  return {
    number: n,
    url: `https://github.com/${P}/pull/${n}`,
    title: "Add a cache",
    author: { login: "colleague", kind: "user" },
    draft: false,
    head: H1,
    headAt: NOW - 1000,
    base: "main",
    labels: [],
    requested: ["alice"],
    reviewedBy: [],
    ...extra,
  };
}

function sourcePass(obj: any, changes: any[] | { unknown: any }, reviews: any[] = []) {
  return source.reconcile({
    object: obj,
    now: NOW,
    observations: {
      sources: { known: [obj] },
      reviews: { known: reviews },
      whoami: { known: { login: "reviewer-bot", calls: 1 } },
      [`list/${P}`]: Array.isArray(changes) ? { known: { changes, calls: 1 } } : changes,
    },
  });
}

describe("ReviewSource", () => {
  it("creates one Review per change that requests the reviewer", () => {
    const plan = sourcePass(src(), [pr(1), pr(2, { requested: ["bob"] })]);
    expect(plan.creates.map((c: any) => c.metadata.name)).toEqual([reviewName("github.com", P, 1)]);
    expect(plan.status.changes[`${P}!2`]).toMatchObject({
      verdict: "excluded",
      reason: "requestedReviewer",
    });
    expect(plan.status.budget.calls).toBe(2);
  });

  it("keeps following a change the reviewer already reviewed (GitHub drops the request)", () => {
    const name = reviewName("github.com", P, 1);
    const change = pr(1, { requested: [], reviewedBy: ["alice"] });
    expect(sourcePass(src(), [change]).creates).toBeUndefined();
    const plan = sourcePass(src(), [change], [{ metadata: { name }, spec: { source: "app" } }]);
    expect(plan.status.changes[`${P}!1`].verdict).toBe("included");
  });

  it("applies the filters in order", () => {
    const spec = sourceSpec(src().spec);
    const v = (e: any) =>
      source.verdict(spec, { project: P, ...pr(1), ...e }, "reviewer-bot", false, NOW);
    expect(v({ draft: true })).toBe("drafts");
    expect(v({ author: { login: "x", kind: "bot" } })).toBe("bots");
    expect(v({ author: { login: "reviewer-bot", kind: "user" } })).toBe("ownChanges");
    expect(v({ headAt: NOW - 30 * 86_400_000 })).toBe("staleAfterDays");
    expect(v({ labels: ["review:stop"] })).toBe("excludeLabels");
    expect(v({})).toBeNull();
  });

  it("keeps the last entries and backs off on a throttled listing", () => {
    const first = sourcePass(src(), [pr(1)]);
    const obj = src({}, first.status);
    const plan = sourcePass(obj, { unknown: { why: "Throttled", retryAfterMs: 120_000 } });
    expect(plan.creates).toBeUndefined();
    expect(plan.status.changes[`${P}!1`].verdict).toBe("included");
    expect(plan.status.throttle).toMatchObject({ until: NOW + 120_000, streak: 1 });
    expect(plan.notBefore).toBe(NOW + 120_000);
  });

  it("asks nothing past the host's budget", () => {
    const obj = src(
      { forge: { kind: "github", host: "github.com", tokenEnv: "T", maxCallsPerMinute: 2 } },
      {
        account: { login: "x", checkedAt: NOW },
        budget: { minute: Math.floor(NOW / 60_000), calls: 2 },
      },
    );
    const p = source.probes({
      object: obj,
      now: NOW,
      observations: { sources: { known: [obj] }, reviews: { known: [] } },
    });
    expect(p).toEqual([]);
  });
});

function rv(status: any = {}): any {
  return {
    kind: "Review",
    metadata: { name: "rv-app-1-abcdef", generation: 1, uid: "r1" },
    spec: {
      source: "app",
      forge: { kind: "github", host: "github.com" },
      project: P,
      number: 1,
      url: `https://github.com/${P}/pull/1`,
    },
    status,
  };
}

function listed(head = H1, extra: any = {}) {
  return src(
    {},
    {
      repositories: { [P]: { listedAt: NOW - 1000 } },
      changes: { [`${P}!1`]: { ...pr(1, { head }), project: P, verdict: "included", ...extra } },
      notBefore: NOW + 300_000,
    },
  );
}

function task(name: string, extra: any = {}): any {
  return {
    metadata: { name, uid: `u-${name}`, creationTimestamp: 1 },
    spec: { dispatch: false },
    status: { phase: "Pending" },
    ...extra,
  };
}

function reviewPass(obj: any, observations: any) {
  return review.reconcile({ object: obj, now: NOW, observations });
}

describe("Review", () => {
  const t1 = taskName("rv-app-1-abcdef", H1);

  it("creates an undispatched Task for the head, then dispatches it under the policy", () => {
    const plan = reviewPass(rv(), { source: { known: listed() } });
    expect(plan.creates[0].metadata.name).toBe(t1);
    expect(plan.creates[0].spec.dispatch).toBe(false);
    expect(plan.status.phase).toBe("Queued");

    const obj = rv(plan.status);
    const next = reviewPass(obj, {
      source: { known: listed() },
      task: { known: task(t1) },
      queue: { known: [task(t1)] },
    });
    expect(next.patches).toEqual([
      { kind: "Task", name: t1, uid: `u-${t1}`, spec: { dispatch: true } },
    ]);
    expect(next.status.phase).toBe("Reviewing");
  });

  it("waits at capacity", () => {
    const busy = task("other", { spec: { dispatch: true }, status: { phase: "Briefed" } });
    const obj = rv({ phase: "Queued", head: { sha: H1 }, task: { name: t1, head: H1, told: [] } });
    const plan = reviewPass(obj, {
      source: { known: listed() },
      task: { known: task(t1) },
      queue: { known: [busy, busy, task(t1)] },
    });
    expect(plan.patches).toBeUndefined();
    expect(plan.status.conditions.find((c: any) => c.type === "Dispatched").reason).toBe(
      "AtCapacity",
    );
  });

  it("tells a dispatched Task about a push once", () => {
    const obj = rv({
      phase: "Reviewing",
      head: { sha: H1 },
      task: { name: t1, uid: `u-${t1}`, head: H1, told: [] },
    });
    const running = task(t1, { spec: { dispatch: true }, status: { phase: "Briefed" } });
    const plan = reviewPass(obj, { source: { known: listed(H2) }, task: { known: running } });
    expect(plan.appends[0].key).toBe(`head/${H2}`);
    expect(plan.creates).toBeUndefined();
    const again = reviewPass(rv(plan.status), {
      source: { known: listed(H2) },
      task: { known: running },
    });
    expect(again.appends).toBeUndefined();
  });

  it("replaces an undispatched Task for an older head", () => {
    const obj = rv({
      phase: "Queued",
      head: { sha: H1 },
      task: { name: t1, uid: `u-${t1}`, head: H1, told: [] },
    });
    const plan = reviewPass(obj, { source: { known: listed(H2) }, task: { known: task(t1) } });
    expect(plan.deletes).toEqual([{ kind: "Task", name: t1, uid: `u-${t1}` }]);
    expect(plan.creates[0].metadata.name).toBe(taskName("rv-app-1-abcdef", H2));
  });

  it("records a result and marks the head reviewed", () => {
    const obj = rv({
      phase: "Reviewing",
      head: { sha: H1 },
      task: { name: t1, uid: `u-${t1}`, head: H1, told: [] },
    });
    const done = task(t1, {
      spec: { dispatch: true },
      status: {
        phase: "Concluded",
        result: { outcome: "shipped", outputs: { head: H1, confidence: 4, findings: 0 } },
      },
    });
    const plan = reviewPass(obj, { source: { known: listed() }, task: { known: done } });
    expect(plan.status.phase).toBe("Reviewed");
    expect(plan.status.reviews[0]).toMatchObject({ head: H1, confidence: 4 });
    expect(plan.status.retiring[0]).toMatchObject({ name: t1, after: NOW + 3_600_000 });
  });

  it("does nothing on an Unknown source or task", () => {
    const obj = rv({ phase: "Reviewing", task: { name: t1, head: H1 } });
    expect(reviewPass(obj, { source: { unknown: { why: "x" } } })).toEqual({
      notBefore: NOW + 300_000,
    });
    expect(
      reviewPass(obj, { source: { known: listed() }, task: { unknown: { why: "x" } } }).creates,
    ).toBeUndefined();
  });

  it("settles a merged change and keeps a dispatched Task", () => {
    const obj = rv({
      phase: "Reviewing",
      head: { sha: H1 },
      task: { name: t1, uid: `u-${t1}`, head: H1, told: [] },
    });
    const gone = src({}, { repositories: { [P]: { listedAt: NOW - 1000 } }, changes: {} });
    const running = task(t1, { spec: { dispatch: true }, status: { phase: "Briefed" } });
    const plan = reviewPass(obj, {
      source: { known: gone },
      task: { known: running },
      change: { known: { state: "merged" } },
    });
    expect(plan.status.phase).toBe("Settled");
    expect(plan.deletes).toBeUndefined();
  });

  it("retires when the source no longer covers the project, then lets go", () => {
    const obj = rv({ phase: "Reviewing", task: { name: t1, uid: `u-${t1}`, head: H1 } });
    const narrowed = src({ repositories: [{ project: "OWNER/other" }] });
    const running = task(t1, { spec: { dispatch: true }, status: { phase: "Briefed" } });
    const plan = reviewPass(obj, { source: { known: narrowed }, task: { known: running } });
    expect(plan.status.phase).toBe("Retiring");
    expect(plan.deletes).toEqual([{ kind: "Task", name: t1, uid: `u-${t1}` }]);
    const last = reviewPass(rv(plan.status), {
      source: { known: narrowed },
      [`retiring/${t1}`]: { known: null },
    });
    expect(last).toEqual({ delete: true });
  });

  it("does not recreate a head whose Task a person deleted", () => {
    const obj = rv({
      phase: "Reviewing",
      head: { sha: H1 },
      task: { name: t1, uid: `u-${t1}`, head: H1, told: [] },
    });
    const plan = reviewPass(obj, { source: { known: listed() }, task: { known: null } });
    expect(plan.status.cancelled).toEqual([H1]);
    const next = reviewPass(rv(plan.status), { source: { known: listed() } });
    expect(next.creates).toBeUndefined();
    expect(next.status.phase).toBe("Reviewed");
  });
});

describe("brief", () => {
  const change = {
    url: "https://github.com/OWNER/app/pull/1",
    head: H1,
    base: "main",
    title: 'Say "hi"',
    author: "colleague",
  };
  it("is generic by default and asks for one summary and inline threads", () => {
    const text = brief(sourceSpec(src().spec), change, "t");
    expect(text).toContain("one inline thread per finding");
    expect(text).not.toContain("thurview");
    expect(text).toContain("Never approve");
    expect(text).toContain(JSON.stringify('Say "hi"'));
  });
  it("names the approve threshold when set", () => {
    const text = brief(
      sourceSpec(src({ review: { taskConfig: "r", approveAt: 4 } }).spec),
      change,
      "t",
    );
    expect(text).toContain("confidence is 4 or more");
  });
  it("renders the optional thurview template", () => {
    const text = brief(
      sourceSpec(src({ review: { taskConfig: "r", template: "thurview" } }).spec),
      change,
      "t",
    );
    expect(text).toContain("thurview-pr-review");
  });
});
