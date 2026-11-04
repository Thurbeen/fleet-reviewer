import { afterEach, describe, expect, it, vi } from "vitest";
import { observe, retryAfter } from "../src/observe.ts";
import { answer } from "../src/plugin.ts";

const gh = {
  kind: "github",
  host: "github.com",
  apiUrl: "https://api.github.com",
  tokenEnv: "TEST_TOKEN",
};
const gl = {
  kind: "gitlab",
  host: "gitlab.example.com",
  apiUrl: "https://gitlab.example.com/api/v4",
  tokenEnv: "TEST_TOKEN",
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TEST_TOKEN;
});

describe("observe", () => {
  it("is Unknown without a token", async () => {
    expect(await observe({ op: "whoami", forge: gh })).toEqual({ unknown: { why: "NoToken" } });
  });

  it("maps a rate limit to Throttled with the forge's advice", async () => {
    process.env.TEST_TOKEN = "t";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(429, "slow down", { "retry-after": "30" })),
    );
    expect(await observe({ op: "whoami", forge: gh })).toEqual({
      unknown: { why: "Throttled", retryAfterMs: 30_000 },
    });
  });

  it("lists GitHub pull requests with reviewers, authors and head dates", async () => {
    process.env.TEST_TOKEN = "t";
    const node = {
      number: 7,
      url: "https://github.com/OWNER/app/pull/7",
      title: "T",
      isDraft: false,
      baseRefName: "main",
      headRefOid: "abc",
      author: { __typename: "Bot", login: "deps" },
      labels: { nodes: [{ name: "x" }] },
      commits: { nodes: [{ commit: { committedDate: "2026-01-01T00:00:00Z" } }] },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "alice" } }] },
      latestReviews: { nodes: [] },
    };
    const fetch = vi.fn(async (_url: string, init: any) => {
      expect(init.headers.authorization).toBe("Bearer t");
      return reply(200, {
        data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node] } } },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const a: any = await observe({
      op: "listChanges",
      forge: gh,
      project: "OWNER/app",
      maxCalls: 2,
    });
    expect(a.known.calls).toBe(1);
    expect(a.known.changes[0]).toMatchObject({
      number: 7,
      author: { kind: "bot" },
      requested: ["alice"],
      labels: ["x"],
      headAt: Date.parse("2026-01-01T00:00:00Z"),
    });
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/graphql");
  });

  it("refuses a partial listing", async () => {
    process.env.TEST_TOKEN = "t";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, [], { "x-next-page": "2" })),
    );
    expect(await observe({ op: "listChanges", forge: gl, project: "g/app", maxCalls: 1 })).toEqual({
      unknown: { why: "TooManyPages" },
    });
  });

  it("lists GitLab merge requests with reviewers and encodes the project", async () => {
    process.env.TEST_TOKEN = "t";
    const fetch = vi.fn(async (url: string, init: any) => {
      expect(init.headers["private-token"]).toBe("t");
      expect(url).toContain("/projects/group%2Fsub%2Fapp/merge_requests");
      return reply(200, [
        {
          iid: 3,
          web_url: "u",
          title: "T",
          draft: false,
          sha: "s",
          target_branch: "main",
          author: { username: "project_12_bot_x" },
          labels: [],
          reviewers: [{ username: "alice" }],
        },
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const a: any = await observe({
      op: "listChanges",
      forge: gl,
      project: "group/sub/app",
      maxCalls: 1,
    });
    expect(a.known.changes[0]).toMatchObject({
      number: 3,
      author: { kind: "bot" },
      requested: ["alice"],
      headAt: null,
    });
  });

  it("reads a merged change", async () => {
    process.env.TEST_TOKEN = "t";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { state: "merged", sha: "s" })),
    );
    expect(await observe({ op: "readChange", forge: gl, project: "g/app", number: 3 })).toEqual({
      known: { state: "merged", head: "s", calls: 1 },
    });
  });

  it("reads a reset header when there is no Retry-After", () => {
    const h = new Headers({ "x-ratelimit-reset": String(1_000 + 90) });
    expect(retryAfter(h, 1_000_000)).toBe(90_000);
  });
});

describe("protocol", () => {
  it("answers with the request id and plans no effects", async () => {
    expect(await answer("perform", { id: "e1" })).toEqual({
      id: "e1",
      ok: true,
      outcome: { failed: { why: "NoEffects" } },
    });
    expect((await answer("nope", { id: "x" })).ok).toBe(false);
  });
});
