// The observer half: one bounded forge read per request, Known or Unknown
// (docs/interface.md#observe). It reads the token variable the request
// names and the forge, and nothing else. It never writes on a forge.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { J } from './util.ts';

export type Answer = { known: J } | { unknown: { why: string; retryAfterMs?: number } };

class Unknown extends Error {
  retryAfterMs?: number;
  constructor(why: string, retryAfterMs?: number) {
    super(why);
    this.retryAfterMs = retryAfterMs;
  }
}

const BOT_USERNAME = /^(project|group)_\d+_bot/;

function timeoutMs(): number {
  const n = Number(process.env.FLEET_REVIEWER_CALL_MS);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/** `Retry-After`, else the reset header, else one minute. */
export function retryAfter(h: Headers, nowMs = Date.now()): number {
  const after = Number(h.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return after * 1000;
  for (const name of ['x-ratelimit-reset', 'ratelimit-reset']) {
    const reset = Number(h.get(name));
    if (Number.isFinite(reset) && reset > 0) {
      // GitHub sends an epoch second; GitLab's RateLimit-Reset is too.
      const ms = reset * 1000 - nowMs;
      if (ms > 0) return Math.min(ms, 3_600_000);
    }
  }
  return 60_000;
}

function throttled(res: Response, body: string): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return (
    res.headers.has('retry-after') ||
    res.headers.get('x-ratelimit-remaining') === '0' ||
    /rate limit/i.test(body)
  );
}

export class Http {
  calls = 0;
  private headers: Record<string, string>;
  constructor(headers: Record<string, string>) {
    this.headers = headers;
  }

  async json(
    url: string,
    init: { method?: string; body?: string } = {},
  ): Promise<{ body: J; headers: Headers }> {
    this.calls += 1;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? 'GET',
        body: init.body,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...this.headers,
        },
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (e) {
      throw new Unknown((e as Error)?.name === 'TimeoutError' ? 'Timeout' : 'NetworkError');
    }
    const text = await res.text();
    if (throttled(res, text)) throw new Unknown('Throttled', retryAfter(res.headers));
    if (res.status === 401) throw new Unknown('Unauthorized');
    if (res.status === 404) throw new Unknown('NotFound');
    if (res.status < 200 || res.status >= 300) throw new Unknown(`HTTP ${res.status}`);
    try {
      return { body: JSON.parse(text), headers: res.headers };
    } catch {
      throw new Unknown('Unreadable');
    }
  }
}

function token(forge: J): string {
  const value = process.env[String(forge.tokenEnv ?? '')];
  if (!value) throw new Unknown('NoToken');
  return value;
}

// ---- GitHub ---------------------------------------------------------------

function graphqlUrl(apiUrl: string): string {
  return apiUrl.endsWith('/api/v3') ? apiUrl.replace(/\/v3$/, '/graphql') : `${apiUrl}/graphql`;
}

const LIST_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url title isDraft baseRefName headRefOid
        author { __typename login }
        labels(first: 50) { nodes { name } }
        commits(last: 1) { nodes { commit { committedDate } } }
        reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } } } }
        latestReviews(first: 50) { nodes { author { login } } }
      }
    }
  }
}`;

async function github(req: J, http: Http): Promise<J> {
  const api = String(req.forge.apiUrl);
  if (req.op === 'whoami') {
    const { body } = await http.json(`${api}/user`);
    return { login: body.login };
  }
  if (req.op === 'readChange') {
    const { body } = await http.json(`${api}/repos/${req.project}/pulls/${req.number}`);
    return {
      state: body.merged ? 'merged' : body.state === 'closed' ? 'closed' : 'open',
      head: body.head?.sha,
    };
  }
  if (req.op === 'listChanges') {
    const [owner, ...rest] = String(req.project).split('/');
    const changes: J[] = [];
    let after: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= Number(req.maxCalls ?? 1)) throw new Unknown('TooManyPages');
      const { body } = await http.json(graphqlUrl(api), {
        method: 'POST',
        body: JSON.stringify({
          query: LIST_QUERY,
          variables: { owner, name: rest.join('/'), after },
        }),
      });
      if (body.errors?.length) {
        const rate = body.errors.some((e: J) => /rate limit/i.test(String(e.message ?? e.type)));
        throw new Unknown(rate ? 'Throttled' : 'GraphQLError', rate ? 60_000 : undefined);
      }
      const prs = body.data?.repository?.pullRequests;
      if (!prs) throw new Unknown('NotFound');
      for (const p of prs.nodes) {
        changes.push({
          number: p.number,
          url: p.url,
          title: p.title,
          author: p.author
            ? { login: p.author.login, kind: p.author.__typename === 'Bot' ? 'bot' : 'user' }
            : { login: '', kind: 'deleted' },
          draft: p.isDraft,
          head: p.headRefOid,
          headAt: Date.parse(p.commits?.nodes?.[0]?.commit?.committedDate) || null,
          base: p.baseRefName,
          labels: (p.labels?.nodes ?? []).map((l: J) => l.name),
          requested: (p.reviewRequests?.nodes ?? [])
            .map((r: J) => r.requestedReviewer?.login)
            .filter(Boolean),
          reviewedBy: (p.latestReviews?.nodes ?? []).map((r: J) => r.author?.login).filter(Boolean),
        });
      }
      if (!prs.pageInfo.hasNextPage) return { changes };
      after = prs.pageInfo.endCursor;
    }
  }
  throw new Unknown(`UnknownOp ${req.op}`);
}

// ---- GitLab ---------------------------------------------------------------

async function gitlab(req: J, http: Http): Promise<J> {
  const api = String(req.forge.apiUrl);
  const project = encodeURIComponent(String(req.project));
  if (req.op === 'whoami') {
    const { body } = await http.json(`${api}/user`);
    return { login: body.username };
  }
  if (req.op === 'readChange') {
    const { body } = await http.json(`${api}/projects/${project}/merge_requests/${req.number}`);
    const state = body.state === 'merged' ? 'merged' : body.state === 'opened' ? 'open' : 'closed';
    return { state, head: body.sha };
  }
  if (req.op === 'readHeadDate') {
    const { body } = await http.json(`${api}/projects/${project}/repository/commits/${req.head}`);
    const headAt = Date.parse(body.committed_date);
    if (!headAt) throw new Unknown('Unreadable');
    return { headAt };
  }
  if (req.op === 'listChanges') {
    const changes: J[] = [];
    for (let page = 1; ; page++) {
      if (page > Number(req.maxCalls ?? 1)) throw new Unknown('TooManyPages');
      const { body, headers } = await http.json(
        `${api}/projects/${project}/merge_requests?state=opened&per_page=100&page=${page}`,
      );
      if (!Array.isArray(body)) throw new Unknown('Unreadable');
      for (const m of body) {
        const login = String(m.author?.username ?? '');
        changes.push({
          number: m.iid,
          url: m.web_url,
          title: m.title,
          author: {
            login,
            kind: login === 'ghost' ? 'deleted' : BOT_USERNAME.test(login) ? 'bot' : 'user',
          },
          draft: Boolean(m.draft ?? m.work_in_progress),
          head: m.sha,
          headAt: null,
          base: m.target_branch,
          labels: m.labels ?? [],
          requested: (m.reviewers ?? []).map((r: J) => r.username),
          reviewedBy: [],
        });
      }
      if (!headers.get('x-next-page')) return { changes };
    }
  }
  throw new Unknown(`UnknownOp ${req.op}`);
}

// ---- fake -----------------------------------------------------------------
// Fleet's fake forge keeps changes in `state.json` (`changes` keyed
// `<project>/<id>`, each with `state` and `head.id`). It has no reviewers,
// authors or dates; those live beside it in `reviewers.json`, under the
// same key: `requested`, `titles`, `authors`, `labels`, `headAt`, and
// `faults`, a list of `why` values that each fail one forge read.

function fake(req: J): J {
  const dir = process.env.FLEET_REVIEWER_FAKE_DIR;
  if (!dir) throw new Unknown('FLEET_REVIEWER_FAKE_DIR is not set');
  const read = (f: string) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      return {};
    }
  };
  const extra = read('reviewers.json');
  const fault = (extra.faults ?? [])[0];
  if (fault) {
    const rest = { ...extra, faults: extra.faults.slice(1) };
    writeJson(join(dir, 'reviewers.json'), rest);
    throw new Unknown(fault, fault === 'Throttled' ? 120_000 : undefined);
  }
  const state = read('state.json').changes ?? {};
  if (req.op === 'whoami') return { login: extra.login ?? 'fleet-reviewer-bot' };
  if (req.op === 'readChange') {
    const c = state[`${req.project}/${req.number}`];
    if (!c) throw new Unknown('NotFound');
    return { state: c.state === 'draft' ? 'open' : c.state, head: c.head?.id };
  }
  if (req.op === 'listChanges') {
    const changes: J[] = [];
    for (const [key, c] of Object.entries(state) as [string, J][]) {
      const id = key.slice(String(req.project).length + 1);
      if (!key.startsWith(`${req.project}/`) || id.includes('/')) continue;
      if (c.state !== 'open' && c.state !== 'draft') continue;
      changes.push({
        number: Number(id),
        url: `https://${req.forge.host}/${req.project}/pull/${id}`,
        title: extra.titles?.[key] ?? '',
        author: { login: extra.authors?.[key] ?? 'author', kind: 'user' },
        draft: c.state === 'draft',
        head: c.head?.id,
        headAt: extra.headAt?.[key] ?? Date.now(),
        base: 'main',
        labels: extra.labels?.[key] ?? [],
        requested: extra.requested?.[key] ?? [],
        reviewedBy: extra.reviewedBy?.[key] ?? [],
      });
    }
    return { changes };
  }
  throw new Unknown(`UnknownOp ${req.op}`);
}

function writeJson(path: string, v: J) {
  writeFileSync(path, JSON.stringify(v, null, 2));
}

export async function observe(req: J): Promise<Answer> {
  try {
    let value: J;
    if (req?.forge?.kind === 'fake') {
      value = { ...fake(req), calls: 1 };
    } else if (req?.forge?.kind === 'github') {
      const h = new Http({ authorization: `Bearer ${token(req.forge)}` });
      value = { ...(await github(req, h)), calls: h.calls };
    } else if (req?.forge?.kind === 'gitlab') {
      const h = new Http({ 'private-token': token(req.forge) });
      value = { ...(await gitlab(req, h)), calls: h.calls };
    } else {
      throw new Unknown(`UnknownForge ${req?.forge?.kind}`);
    }
    return { known: value };
  } catch (e) {
    if (e instanceof Unknown) {
      return {
        unknown: e.retryAfterMs
          ? { why: e.message, retryAfterMs: e.retryAfterMs }
          : { why: e.message },
      };
    }
    return { unknown: { why: `Error: ${(e as Error)?.message ?? e}` } };
  }
}
