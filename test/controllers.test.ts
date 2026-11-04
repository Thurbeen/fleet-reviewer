import { describe, expect, it } from 'vitest';
import { brief } from '../src/brief.ts';
import * as review from '../src/review.ts';
import * as source from '../src/source.ts';
import { reviewName, sourceSpec } from '../src/util.ts';

const NOW = 1_800_000_000_000;
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const P = 'OWNER/app';

function src(spec: any = {}, status: any = {}): any {
  return {
    kind: 'ReviewSource',
    metadata: { name: 'app', generation: 1 },
    spec: {
      forge: { kind: 'github', host: 'github.com', tokenEnv: 'REVIEWER_TOKEN_A' },
      repositories: [{ project: P }],
      review: { taskConfig: 'review' },
      filters: { requestedReviewer: 'alice' },
      ...spec,
    },
    status,
  };
}

function pr(n: number, extra: any = {}): any {
  return {
    number: n,
    url: `https://github.com/${P}/pull/${n}`,
    title: 'Add a cache',
    author: { login: 'colleague', kind: 'user' },
    draft: false,
    head: H1,
    headAt: NOW - 1000,
    base: 'main',
    labels: [],
    requested: ['alice'],
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
      whoami: { known: { login: 'reviewer-bot', calls: 1 } },
      [`list/${P}`]: Array.isArray(changes) ? { known: { changes, calls: 1 } } : changes,
    },
  });
}

describe('ReviewSource', () => {
  it('creates one Review per change that requests the reviewer', () => {
    const plan = sourcePass(src(), [pr(1), pr(2, { requested: ['bob'] })]);
    expect(plan.creates.map((c: any) => c.metadata.name)).toEqual([reviewName('github.com', P, 1)]);
    expect(plan.status.changes[`${P}!2`]).toMatchObject({
      verdict: 'excluded',
      reason: 'requestedReviewer',
    });
    expect(plan.status.budget.calls).toBe(2);
  });

  it('keeps following a change the reviewer already reviewed (GitHub drops the request)', () => {
    const name = reviewName('github.com', P, 1);
    const change = pr(1, { requested: [], reviewedBy: ['alice'] });
    expect(sourcePass(src(), [change]).creates).toBeUndefined();
    const plan = sourcePass(src(), [change], [{ metadata: { name }, spec: { source: 'app' } }]);
    expect(plan.status.changes[`${P}!1`].verdict).toBe('included');
  });

  it('applies the filters in order', () => {
    const spec = sourceSpec(src().spec);
    const v = (e: any) =>
      source.verdict(spec, { project: P, ...pr(1), ...e }, 'reviewer-bot', false, NOW);
    expect(v({ draft: true })).toBe('drafts');
    expect(v({ author: { login: 'x', kind: 'bot' } })).toBe('bots');
    expect(v({ author: { login: 'reviewer-bot', kind: 'user' } })).toBe('ownChanges');
    expect(v({ headAt: NOW - 30 * 86_400_000 })).toBe('staleAfterDays');
    expect(v({ labels: ['review:stop'] })).toBe('excludeLabels');
    expect(v({})).toBeNull();
  });

  it('keeps the last entries and backs off on a throttled listing', () => {
    const first = sourcePass(src(), [pr(1)]);
    const obj = src({}, first.status);
    const plan = sourcePass(obj, { unknown: { why: 'Throttled', retryAfterMs: 120_000 } });
    expect(plan.creates).toBeUndefined();
    expect(plan.status.changes[`${P}!1`].verdict).toBe('included');
    expect(plan.status.throttle).toMatchObject({ until: NOW + 120_000, streak: 1 });
    expect(plan.notBefore).toBe(NOW + 120_000);
  });

  it("asks nothing past the host's budget", () => {
    const obj = src(
      { forge: { kind: 'github', host: 'github.com', tokenEnv: 'T', maxCallsPerMinute: 2 } },
      {
        account: { login: 'x', checkedAt: NOW },
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
    kind: 'Review',
    metadata: { name: 'rv-app-1-abcdef', generation: 1, uid: 'r1' },
    spec: {
      source: 'app',
      forge: { kind: 'github', host: 'github.com' },
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
      changes: { [`${P}!1`]: { ...pr(1, { head }), project: P, verdict: 'included', ...extra } },
      notBefore: NOW + 300_000,
    },
  );
}

const NAME = 'rv-app-1-abcdef';

function task(extra: any = {}): any {
  return {
    metadata: { name: NAME, uid: 'u1', generation: 1, creationTimestamp: 1 },
    spec: { dispatch: false },
    status: { phase: 'Pending' },
    ...extra,
  };
}

const running = () => task({ spec: { dispatch: true }, status: { phase: 'Briefed' } });
const following = (extra: any = {}) =>
  rv({
    phase: 'Reviewing',
    head: { sha: H1 },
    task: { name: NAME, uid: 'u1', head: H1 },
    ...extra,
  });

function reviewPass(obj: any, observations: any) {
  return review.reconcile({ object: obj, now: NOW, observations });
}

describe('Review', () => {
  it('creates one undispatched Task named after the Review, then dispatches it', () => {
    const plan = reviewPass(rv(), { source: { known: listed() }, task: { known: null } });
    expect(plan.creates[0].metadata.name).toBe(NAME);
    expect(plan.creates[0].spec.dispatch).toBe(false);
    expect(plan.status.phase).toBe('Queued');

    const next = reviewPass(rv(plan.status), {
      source: { known: listed() },
      task: { known: task() },
      queue: { known: [task()] },
    });
    expect(next.patches).toEqual([
      { kind: 'Task', name: NAME, uid: 'u1', spec: { dispatch: true } },
    ]);
    expect(next.status.phase).toBe('Reviewing');
  });

  it('waits at capacity', () => {
    const busy = { ...running(), metadata: { name: 'other', uid: 'o' } };
    const plan = reviewPass(rv({ phase: 'Queued', task: { name: NAME, head: H1 } }), {
      source: { known: listed() },
      task: { known: task() },
      queue: { known: [busy, busy, task()] },
    });
    expect(plan.patches).toBeUndefined();
    expect(plan.status.conditions.find((c: any) => c.type === 'Dispatched').reason).toBe(
      'AtCapacity',
    );
  });

  it('amends the same Task once per push, fenced on its generation', () => {
    const plan = reviewPass(following(), {
      source: { known: listed(H2) },
      task: { known: running() },
    });
    expect(plan.creates).toBeUndefined();
    expect(plan.amends).toEqual([
      {
        task: NAME,
        uid: 'u1',
        text: review.amendText(H2),
        reason: "the change's head moved",
        ifGeneration: 1,
      },
    ]);
    // The amendment landed: the store holds it, so a later pass, even with a lost status, sends nothing.
    const amended = running();
    amended.metadata.generation = 2;
    amended.spec.amendments = [{ text: review.amendText(H2), generation: 2 }];
    for (const obj of [following(), rv()]) {
      const again = reviewPass(obj, { source: { known: listed(H2) }, task: { known: amended } });
      expect(again.amends).toBeUndefined();
      expect(again.creates).toBeUndefined();
    }
  });

  it('amends a concluded Task, which reopens it', () => {
    const done = running();
    done.status = {
      phase: 'Concluded',
      result: { outcome: 'shipped', generation: 1, outputs: { head: H1, confidence: 4 } },
    };
    const plan = reviewPass(following(), { source: { known: listed(H2) }, task: { known: done } });
    expect(plan.amends[0].text).toContain(H2);
    expect(plan.status.reviews[0]).toMatchObject({ head: H1, generation: 1, confidence: 4 });
  });

  it('records each result once, per generation', () => {
    const done = running();
    done.status = {
      phase: 'Concluded',
      result: { outcome: 'shipped', generation: 1, outputs: { head: H1, confidence: 4 } },
    };
    const plan = reviewPass(following(), { source: { known: listed() }, task: { known: done } });
    expect(plan.status.phase).toBe('Reviewed');
    const again = reviewPass(following({ reviews: plan.status.reviews }), {
      source: { known: listed() },
      task: { known: done },
    });
    expect(again.status.reviews).toHaveLength(1);
  });

  it('flags a result for a head the Task was never asked about', () => {
    const done = running();
    done.status = {
      phase: 'Concluded',
      result: { outcome: 'shipped', generation: 1, outputs: { head: H2 } },
    };
    const plan = reviewPass(following(), { source: { known: listed() }, task: { known: done } });
    expect(plan.status.conditions.find((c: any) => c.type === 'NeedsAttention').reason).toBe(
      'UnexpectedHead',
    );
    expect(plan.status.phase).toBe('Reviewing');
  });

  it('does nothing on an Unknown source or task', () => {
    expect(
      reviewPass(following(), { source: { unknown: { why: 'x' } }, task: { known: null } }),
    ).toEqual({
      notBefore: NOW + 300_000,
    });
    expect(
      reviewPass(following(), { source: { known: listed() }, task: { unknown: { why: 'x' } } }),
    ).toEqual({
      notBefore: NOW + 300_000,
    });
  });

  it('deletes the Task when the change merges or the user is unrequested', () => {
    const gone = src({}, { repositories: { [P]: { listedAt: NOW - 1000 } }, changes: {} });
    const merged = reviewPass(following(), {
      source: { known: gone },
      task: { known: running() },
      change: { known: { state: 'merged' } },
    });
    expect(merged.status.phase).toBe('Settled');
    expect(merged.deletes).toEqual([{ kind: 'Task', name: NAME, uid: 'u1' }]);

    const excluded = reviewPass(following(), {
      source: { known: listed(H1, { verdict: 'excluded', reason: 'requestedReviewer' }) },
      task: { known: running() },
    });
    expect(excluded.status.phase).toBe('Excluded');
    expect(excluded.deletes).toEqual([{ kind: 'Task', name: NAME, uid: 'u1' }]);
  });

  it('retires when the source no longer covers the project, then lets go', () => {
    const narrowed = src({ repositories: [{ project: 'OWNER/other' }] });
    const plan = reviewPass(following(), {
      source: { known: narrowed },
      task: { known: running() },
    });
    expect(plan.status.phase).toBe('Retiring');
    expect(plan.deletes).toEqual([{ kind: 'Task', name: NAME, uid: 'u1' }]);
    expect(
      reviewPass(rv(plan.status), { source: { known: narrowed }, task: { known: null } }),
    ).toEqual({
      delete: true,
    });
  });

  it('does not recreate a head whose Task a person deleted, but starts again on a push', () => {
    const plan = reviewPass(following(), { source: { known: listed() }, task: { known: null } });
    expect(plan.status.cancelled).toEqual([H1]);
    expect(plan.creates).toBeUndefined();
    const same = reviewPass(rv(plan.status), {
      source: { known: listed() },
      task: { known: null },
    });
    expect(same.creates).toBeUndefined();
    const pushed = reviewPass(rv(plan.status), {
      source: { known: listed(H2) },
      task: { known: null },
    });
    expect(pushed.creates[0].metadata.name).toBe(NAME);
  });
});

describe('brief', () => {
  const change = {
    url: 'https://github.com/OWNER/app/pull/1',
    head: H1,
    base: 'main',
    title: 'Say "hi"',
    author: 'colleague',
  };
  it('is generic by default and asks for one summary and inline threads', () => {
    const text = brief(sourceSpec(src().spec), change, 't');
    expect(text).toContain('one inline thread per finding');
    expect(text).not.toContain('thurview');
    expect(text).toContain('Never approve');
    expect(text).toContain(JSON.stringify('Say "hi"'));
  });
  it('names the approve threshold when set', () => {
    const text = brief(
      sourceSpec(src({ review: { taskConfig: 'r', approveAt: 4 } }).spec),
      change,
      't',
    );
    expect(text).toContain('confidence is 4 or more');
  });
  it('renders the optional thurview template', () => {
    const text = brief(
      sourceSpec(src({ review: { taskConfig: 'r', template: 'thurview' } }).spec),
      change,
      't',
    );
    expect(text).toContain('thurview-pr-review');
  });
});
