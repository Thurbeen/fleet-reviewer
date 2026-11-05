// End to end: the real `fleet` binary, its fake runtime, and this plugin run
// by Node under `[plugins.fleet-reviewer]`, against a fake forge kept in
// Fleet's own fake-forge file. FLEET_BIN names the binary; CI downloads the
// pinned release. Each test has its own store, forge directory and HOME.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FLEET = process.env.FLEET_BIN;
const PLUGIN = resolve(import.meta.dirname, '../src/plugin.ts');
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const PROJECT = 'example/project';
const LABEL_SOURCE = 'fleet-reviewer/source';

if (!FLEET && process.env.FLEET_E2E_REQUIRED) {
  throw new Error('FLEET_E2E_REQUIRED is set but FLEET_BIN is not');
}

class Env {
  root = mkdtempSync(join(tmpdir(), 'fleet-reviewer-e2e-'));
  config = join(this.root, 'fleet.toml');
  forge = join(this.root, 'forge');

  constructor() {
    mkdirSync(this.forge);
    writeFileSync(
      this.config,
      [
        'version = 1',
        '[data]',
        'dir = "data"',
        '[runtime]',
        'kind = "fake"',
        'dir = "fake"',
        '[plugins.fleet-reviewer]',
        `program = '${process.execPath}'`,
        `args = ['${PLUGIN}']`,
        `cwd = '${this.root}'`,
        'callTimeoutMs = 10000',
        'tasks = "own"',
        "passEnv = ['FLEET_REVIEWER_FAKE_DIR']",
        '',
      ].join('\n'),
    );
    this.forgeFile('reviewers.json', { requested: {} });
  }

  fleet(...args: string[]): { code: number; out: string; err: string } {
    const r = spawnSync(FLEET!, ['--config', this.config, ...args], {
      cwd: this.root,
      env: { PATH: process.env.PATH ?? '', HOME: this.root, FLEET_REVIEWER_FAKE_DIR: this.forge },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  }

  ok(...args: string[]): string {
    const r = this.fleet(...args);
    if (r.code !== 0) throw new Error(`fleet ${args.join(' ')}: ${r.code}\n${r.out}\n${r.err}`);
    return r.out;
  }

  apply(obj: object) {
    const path = join(this.root, 'apply.json');
    writeFileSync(path, JSON.stringify(obj));
    this.ok('apply', '-f', path);
  }

  get(kind: string, name: string): any {
    return JSON.parse(this.ok('get', kind, name));
  }

  list(kind: string): any[] {
    const v = JSON.parse(this.ok('list', kind, '--json'));
    return (Array.isArray(v) ? v : v.items).filter((o: any) => !o.metadata.deletionTimestamp);
  }

  /** One manager pass after every plugin object's wait has expired. */
  sweep() {
    this.expire('ReviewSource', 'Review');
    this.ok('reconcile');
  }

  /** Make every object of these kinds due now. */
  expire(...kinds: string[]) {
    for (const kind of kinds) {
      const dir = join(this.root, 'data/objects', kind);
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(dir, f);
        const obj = JSON.parse(readFileSync(path, 'utf8'));
        if (obj.status) obj.status.notBefore = 0;
        writeFileSync(path, JSON.stringify(obj));
      }
    }
  }

  /** Mark every fake session at rest, as Fleet's own tests do with `set_at_rest`. */
  restSessions() {
    const visit = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) visit(path);
        else if (e.name === 'state.json') {
          const state = JSON.parse(readFileSync(path, 'utf8'));
          for (const session of Object.values(state.sessions ?? {})) {
            (session as { atRest: boolean }).atRest = true;
          }
          writeFileSync(path, JSON.stringify(state));
        }
      }
    };
    visit(join(this.root, 'fake'));
  }

  forgeFile(name: string, v: object) {
    writeFileSync(join(this.forge, name), JSON.stringify(v, null, 2));
  }

  readForge(name: string): any {
    try {
      return JSON.parse(readFileSync(join(this.forge, name), 'utf8'));
    } catch {
      return {};
    }
  }

  /** A change in Fleet's fake-forge format. */
  setChange(id: number, state: string, head: string) {
    const s = this.readForge('state.json');
    s.changes ??= {};
    s.changes[`${PROJECT}/${id}`] = {
      state,
      head: { id: head, checks: 'none' },
      reviewDecision: 'none',
      mergeable: { value: null, reason: null },
      threads: { unresolved: 0 },
    };
    this.forgeFile('state.json', s);
  }

  request(id: number, users: string[]) {
    const r = this.readForge('reviewers.json');
    r.requested[`${PROJECT}/${id}`] = users;
    this.forgeFile('reviewers.json', r);
  }

  reviewTasks(): any[] {
    return this.list('task').filter((t) => t.metadata.labels?.[LABEL_SOURCE] === 'app');
  }
}

function setup(review: object = {}): Env {
  const env = new Env();
  env.setChange(1, 'open', HEAD1);
  env.setChange(2, 'open', HEAD1);
  env.request(1, ['alice']);
  env.request(2, ['bob']);
  env.apply({
    apiVersion: 'fleet/v1alpha1',
    kind: 'TaskConfig',
    metadata: { name: 'review' },
    spec: { harness: 'claude-code' },
  });
  env.apply({
    apiVersion: 'fleet/v1alpha1',
    kind: 'ReviewSource',
    metadata: { name: 'app' },
    spec: {
      forge: { kind: 'fake', host: 'forge.test', tokenEnv: 'REVIEWER_TOKEN_A' },
      repositories: [{ project: PROJECT, url: 'https://forge.test/example/project' }],
      filters: { requestedReviewer: 'alice' },
      review: { taskConfig: 'review', ...review },
    },
  });
  // Source lists and creates the Review; the Review creates its Task; the
  // next pass reads the Task's uid and dispatches it.
  env.ok('reconcile');
  env.sweep();
  return env;
}

describe.skipIf(!FLEET)('fleet-reviewer against a real fleet', () => {
  it('starts one dispatched review Task for an assigned change and never duplicates it', () => {
    const env = setup();
    const tasks = env.reviewTasks();
    expect(tasks.map((t) => t.metadata.name)).toHaveLength(1);
    const task = tasks[0];
    const [review] = env.list('review');
    expect(task.metadata.name).toBe(review.metadata.name);
    expect(task.metadata.labels['fleet.dev/plugin']).toBe('fleet-reviewer');
    expect(task.spec.dispatch).toBe(true);
    expect(task.spec.brief).toContain('https://forge.test/example/project/pull/1');
    // The worktree starts from the target branch, and the reviewer reads the change's own head.
    expect(task.spec.workspace.repositories[0].ref).toBe('origin/main');
    expect(task.spec.brief).toContain('git fetch origin refs/pull/1/head');
    expect(task.spec.brief).toContain(`git checkout --detach ${HEAD1}`);
    const source = env.get('reviewsource', 'app');
    expect(source.status.changes[`${PROJECT}!2`].reason).toBe('requestedReviewer');

    env.sweep();
    env.sweep();
    const again = env.reviewTasks();
    expect(again).toHaveLength(1);
    expect(again[0].metadata.uid).toBe(task.metadata.uid);
    expect(again[0].metadata.generation).toBe(task.metadata.generation);
    expect(env.list('review')).toHaveLength(1);
  });

  it('runs up to five review Tasks at once when the source sets no maxActive', () => {
    const env = setup();
    for (const id of [2, 3, 4, 5, 6]) {
      env.setChange(id, 'open', HEAD1);
      env.request(id, ['alice']);
    }
    env.sweep();
    env.sweep();
    env.sweep();
    const tasks = env.reviewTasks();
    expect(tasks).toHaveLength(6);
    expect(tasks.filter((t) => t.spec.dispatch)).toHaveLength(5);
  });

  it('amends the same Task once per push, and deletes it when the change merges', () => {
    const env = setup();
    const [before] = env.reviewTasks();
    env.setChange(1, 'open', HEAD2);
    env.sweep();
    env.sweep();
    const [task] = env.reviewTasks();
    expect(task.metadata.uid).toBe(before.metadata.uid);
    expect(task.metadata.generation).toBe(before.metadata.generation + 1);
    expect(task.spec.amendments).toHaveLength(1);
    expect(task.spec.amendments[0].text).toContain(HEAD2);
    expect(task.spec.amendments[0].text).toContain(`git checkout --detach ${HEAD2}`);
    expect(task.spec.amendments[0].from).toBe('plugin/fleet-reviewer');

    env.setChange(1, 'merged', HEAD2);
    env.sweep();
    env.sweep();
    const [review] = env.list('review');
    expect(review.status.phase).toBe('Settled');
    expect(review.status.change.state).toBe('merged');
    expect(env.reviewTasks()).toHaveLength(0);
  });

  it('recreates a deleted Review soon after it is gone', () => {
    const env = setup();
    const [before] = env.list('review');
    const [oldTask] = env.reviewTasks();
    // Fleet releases a session only at rest.
    env.restSessions();
    env.ok('delete', 'review', before.metadata.name);

    // A pass while the Review is still deleting: it releases its Task first.
    env.expire('ReviewSource', 'Review');
    env.ok('reconcile');
    const source = env.get('reviewsource', 'app');
    expect(source.status.changes[`${PROJECT}!1`].reviewState).toBe('deleting');
    expect(source.status.notBefore - Date.now()).toBeLessThan(60_000);

    // The Review lets go once its Task is gone; the source's next pass recreates it.
    for (let i = 0; i < 3 && env.fleet('get', 'review', before.metadata.name).code === 0; i++) {
      env.expire('Review');
      env.ok('reconcile');
    }
    expect(env.fleet('get', 'review', before.metadata.name).code).toBe(3);
    env.expire('ReviewSource');
    env.ok('reconcile');
    env.sweep();
    const [after] = env.list('review');
    expect(after.metadata.name).toBe(before.metadata.name);
    expect(after.metadata.uid).not.toBe(before.metadata.uid);
    const tasks = env.reviewTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].metadata.uid).not.toBe(oldTask.metadata.uid);
    expect(tasks[0].spec.dispatch).toBe(true);
    expect(env.get('reviewsource', 'app').status.changes[`${PROJECT}!1`].reviewState).toBe(
      'present',
    );
  });

  it('stops the review once the user is no longer a requested reviewer', () => {
    const env = setup();
    env.request(1, ['bob']);
    env.sweep();
    env.sweep();
    expect(env.list('review')[0].status.phase).toBe('Excluded');
    expect(env.reviewTasks()).toHaveLength(0);
  });

  it('holds everything while the forge throttles', () => {
    const env = setup();
    const r = env.readForge('reviewers.json');
    r.faults = ['Throttled'];
    r.requested[`${PROJECT}/1`] = [];
    env.forgeFile('reviewers.json', r);
    env.sweep();
    const source = env.get('reviewsource', 'app');
    expect(source.status.phase).toBe('Throttled');
    expect(source.status.throttle.until).toBeGreaterThan(Date.now() + 60_000);
    expect(source.status.changes[`${PROJECT}!1`].verdict).toBe('included');
    expect(env.reviewTasks()).toHaveLength(1);
  });

  it('records each result, and reopens the concluded Task for a later push', () => {
    const env = setup({ approveAt: 4 });
    const [task] = env.reviewTasks();
    const name = task.metadata.name;
    expect(task.spec.brief).toContain('confidence is 4 or more');
    const result = (generation: string, head: string, confidence: string) =>
      env.ok(
        'result',
        name,
        '--generation',
        generation,
        '--outcome',
        'shipped',
        '--summary',
        'ok',
        '--output',
        `head="${head}"`,
        '--output',
        `confidence=${confidence}`,
      );
    const first = env.get('task', name).status.brief.generation;
    result(String(first), HEAD1, '4');
    env.ok('reconcile');
    env.sweep();
    let [review] = env.list('review');
    expect(review.status.phase).toBe('Reviewed');
    expect(review.status.reviews[0]).toMatchObject({
      head: HEAD1,
      confidence: 4,
      generation: first,
    });

    env.setChange(1, 'open', HEAD2);
    env.sweep();
    env.sweep();
    const reopened = env.get('task', name);
    expect(reopened.metadata.uid).toBe(task.metadata.uid);
    expect(reopened.status.phase).not.toBe('Concluded');
    result(String(reopened.status.brief.generation), HEAD2, '5');
    env.ok('reconcile');
    env.sweep();
    [review] = env.list('review');
    expect(review.status.phase).toBe('Reviewed');
    expect(review.status.reviews.map((r: any) => r.head)).toEqual([HEAD2, HEAD1]);
    expect(env.reviewTasks()).toHaveLength(1);
  });

  it('asks a person when the Task records a stuck result for the current head', () => {
    const env = setup();
    const [task] = env.reviewTasks();
    const name = task.metadata.name;
    env.ok(
      'result',
      name,
      '--generation',
      String(env.get('task', name).status.brief.generation),
      '--outcome',
      'stuck',
      '--summary',
      'the publishing check was refused',
      '--output',
      `head="${HEAD1}"`,
    );
    env.ok('reconcile');
    env.sweep();
    const [review] = env.list('review');
    expect(review.status.reviews[0]).toMatchObject({ head: HEAD1, outcome: 'stuck' });
    expect(review.status.phase).not.toBe('Reviewed');
    const cond = (type: string) => review.status.conditions.find((c: any) => c.type === type);
    expect(cond('Reviewed')).toMatchObject({ status: 'False' });
    expect(cond('NeedsAttention')).toMatchObject({ status: 'True', reason: 'ResultNotShipped' });
    expect(cond('NeedsAttention').message).toContain(name);
    expect(cond('NeedsAttention').message).toContain('stuck');
  });
});

// Keep the binary's version in the test log.
if (FLEET) console.log(execFileSync(FLEET, ['version'], { encoding: 'utf8' }).split('\n')[0]);
