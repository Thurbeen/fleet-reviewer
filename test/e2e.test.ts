// End to end: the real `fleet` binary, its fake runtime, and this plugin run
// by Node under `[plugins.fleet-reviewer]`, against a fake forge kept in
// Fleet's own fake-forge file. FLEET_BIN names the binary; CI downloads the
// pinned release. Each test has its own store, forge directory and HOME.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FLEET = process.env.FLEET_BIN;
const PLUGIN = resolve(import.meta.dirname, "../src/plugin.ts");
const HEAD1 = "1".repeat(40);
const HEAD2 = "2".repeat(40);
const PROJECT = "example/project";
const LABEL_SOURCE = "fleet-reviewer/source";

if (!FLEET && process.env.FLEET_E2E_REQUIRED) {
  throw new Error("FLEET_E2E_REQUIRED is set but FLEET_BIN is not");
}

class Env {
  root = mkdtempSync(join(tmpdir(), "fleet-reviewer-e2e-"));
  config = join(this.root, "fleet.toml");
  forge = join(this.root, "forge");

  constructor() {
    mkdirSync(this.forge);
    writeFileSync(
      this.config,
      [
        "version = 1",
        "[data]",
        'dir = "data"',
        "[runtime]",
        'kind = "fake"',
        'dir = "fake"',
        "[plugins.fleet-reviewer]",
        `program = '${process.execPath}'`,
        `args = ['${PLUGIN}']`,
        `cwd = '${this.root}'`,
        "callTimeoutMs = 10000",
        'tasks = "own"',
        "passEnv = ['FLEET_REVIEWER_FAKE_DIR']",
        "",
      ].join("\n"),
    );
    this.forgeFile("reviewers.json", { requested: {} });
  }

  fleet(...args: string[]): { code: number; out: string; err: string } {
    const r = spawnSync(FLEET!, ["--config", this.config, ...args], {
      cwd: this.root,
      env: { PATH: process.env.PATH ?? "", HOME: this.root, FLEET_REVIEWER_FAKE_DIR: this.forge },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  }

  ok(...args: string[]): string {
    const r = this.fleet(...args);
    if (r.code !== 0) throw new Error(`fleet ${args.join(" ")}: ${r.code}\n${r.out}\n${r.err}`);
    return r.out;
  }

  apply(obj: object) {
    const path = join(this.root, "apply.json");
    writeFileSync(path, JSON.stringify(obj));
    this.ok("apply", "-f", path);
  }

  get(kind: string, name: string): any {
    return JSON.parse(this.ok("get", kind, name));
  }

  list(kind: string): any[] {
    const v = JSON.parse(this.ok("list", kind, "--json"));
    return (Array.isArray(v) ? v : v.items).filter((o: any) => !o.metadata.deletionTimestamp);
  }

  /** One manager pass after every plugin object's wait has expired. */
  sweep() {
    for (const kind of ["ReviewSource", "Review"]) {
      const dir = join(this.root, "data/objects", kind);
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(dir, f);
        const obj = JSON.parse(readFileSync(path, "utf8"));
        if (obj.status) obj.status.notBefore = 0;
        writeFileSync(path, JSON.stringify(obj));
      }
    }
    this.ok("reconcile");
  }

  forgeFile(name: string, v: object) {
    writeFileSync(join(this.forge, name), JSON.stringify(v, null, 2));
  }

  readForge(name: string): any {
    try {
      return JSON.parse(readFileSync(join(this.forge, name), "utf8"));
    } catch {
      return {};
    }
  }

  /** A change in Fleet's fake-forge format. */
  setChange(id: number, state: string, head: string) {
    const s = this.readForge("state.json");
    s.changes ??= {};
    s.changes[`${PROJECT}/${id}`] = {
      state,
      head: { id: head, checks: "none" },
      reviewDecision: "none",
      mergeable: { value: null, reason: null },
      threads: { unresolved: 0 },
    };
    this.forgeFile("state.json", s);
  }

  request(id: number, users: string[]) {
    const r = this.readForge("reviewers.json");
    r.requested[`${PROJECT}/${id}`] = users;
    this.forgeFile("reviewers.json", r);
  }

  reviewTasks(): any[] {
    return this.list("task").filter((t) => t.metadata.labels?.[LABEL_SOURCE] === "app");
  }
}

function setup(review: object = {}): Env {
  const env = new Env();
  env.setChange(1, "open", HEAD1);
  env.setChange(2, "open", HEAD1);
  env.request(1, ["alice"]);
  env.request(2, ["bob"]);
  env.apply({
    apiVersion: "fleet/v1alpha1",
    kind: "TaskConfig",
    metadata: { name: "review" },
    spec: { harness: "claude-code" },
  });
  env.apply({
    apiVersion: "fleet/v1alpha1",
    kind: "ReviewSource",
    metadata: { name: "app" },
    spec: {
      forge: { kind: "fake", host: "forge.test", tokenEnv: "REVIEWER_TOKEN_A" },
      repositories: [{ project: PROJECT, url: "https://forge.test/example/project" }],
      filters: { requestedReviewer: "alice" },
      review: { taskConfig: "review", ...review },
    },
  });
  // Source lists and creates the Review; the Review creates its Task; the
  // next pass reads the Task's uid and dispatches it.
  env.ok("reconcile");
  env.sweep();
  return env;
}

describe.skipIf(!FLEET)("fleet-reviewer against a real fleet", () => {
  it("starts one dispatched review Task for an assigned change and never duplicates it", () => {
    const env = setup();
    const tasks = env.reviewTasks();
    expect(tasks.map((t) => t.metadata.name)).toHaveLength(1);
    const task = tasks[0];
    expect(task.metadata.labels["fleet.dev/plugin"]).toBe("fleet-reviewer");
    expect(task.spec.dispatch).toBe(true);
    expect(task.spec.brief).toContain("https://forge.test/example/project/pull/1");
    expect(task.metadata.name.endsWith(HEAD1.slice(0, 12))).toBe(true);

    const reviews = env.list("review");
    expect(reviews).toHaveLength(1);
    const source = env.get("reviewsource", "app");
    expect(source.status.changes[`${PROJECT}!2`].reason).toBe("requestedReviewer");

    env.sweep();
    env.sweep();
    const again = env.reviewTasks();
    expect(again).toHaveLength(1);
    expect(again[0].metadata.uid).toBe(task.metadata.uid);
    expect(env.list("review")).toHaveLength(1);
  });

  it("tells the running Task about a push, and settles when the change merges", () => {
    const env = setup();
    env.setChange(1, "open", HEAD2);
    env.sweep();
    const [task] = env.reviewTasks();
    expect(JSON.stringify(task.status)).toContain(`head/${HEAD2}`);
    expect(env.reviewTasks()).toHaveLength(1);

    env.setChange(1, "merged", HEAD2);
    env.sweep();
    env.sweep();
    const [review] = env.list("review");
    expect(review.status.phase).toBe("Settled");
    expect(review.status.change.state).toBe("merged");
  });

  it("excludes a change once the user is no longer a requested reviewer", () => {
    const env = setup();
    env.request(1, ["bob"]);
    env.sweep();
    env.sweep();
    expect(env.list("review")[0].status.phase).toBe("Excluded");
  });

  it("holds everything while the forge throttles", () => {
    const env = setup();
    const r = env.readForge("reviewers.json");
    r.faults = ["Throttled"];
    r.requested[`${PROJECT}/1`] = [];
    env.forgeFile("reviewers.json", r);
    env.sweep();
    const source = env.get("reviewsource", "app");
    expect(source.status.phase).toBe("Throttled");
    expect(source.status.throttle.until).toBeGreaterThan(Date.now() + 60_000);
    expect(source.status.changes[`${PROJECT}!1`].verdict).toBe("included");
    expect(env.reviewTasks()).toHaveLength(1);
  });

  it("records a result, briefs the approve threshold, and reviews a later push anew", () => {
    const env = setup({ approveAt: 4 });
    const [task] = env.reviewTasks();
    expect(task.spec.brief).toContain("confidence is 4 or more");
    const generation = String(env.get("task", task.metadata.name).status.brief.generation);
    env.ok(
      "result",
      task.metadata.name,
      "--generation",
      generation,
      "--outcome",
      "shipped",
      "--summary",
      "looks right",
      "--output",
      `head="${HEAD1}"`,
      "--output",
      "confidence=4",
    );
    env.ok("reconcile");
    env.sweep();
    const [review] = env.list("review");
    expect(review.status.phase).toBe("Reviewed");
    expect(review.status.reviews[0]).toMatchObject({
      head: HEAD1,
      confidence: 4,
      outcome: "shipped",
    });

    env.setChange(1, "open", HEAD2);
    env.sweep();
    env.sweep();
    const names = env.reviewTasks().map((t) => t.metadata.name);
    expect(names.some((n) => n.endsWith(HEAD2.slice(0, 12)))).toBe(true);
  });
});

// Keep the binary's version in the test log.
if (FLEET) console.log(execFileSync(FLEET, ["version"], { encoding: "utf8" }).split("\n")[0]);
