// Shared, pure helpers: names, conditions, defaults. No I/O.

import { createHash } from 'node:crypto';

// Fleet's objects and requests are JSON whose shape the schemas own.
export type J = any;

export const PLUGIN = 'fleet-reviewer';
export const LABEL_SOURCE = 'fleet-reviewer/source';
export const LABEL_REVIEW = 'fleet-reviewer/review';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** `rv-<repo>-<number>-<hash>`, from facts, so a repeated pass creates nothing twice. */
export function reviewName(host: string, project: string, number: number): string {
  const last = project.split('/').pop() ?? 'repo';
  const repo = last
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(`${host}/${project}!${number}`).digest('hex');
  return `rv-${repo || 'repo'}-${number}-${hash.slice(0, 6)}`;
}

export function changeKey(project: string, number: number): string {
  return `${project}!${number}`;
}

/** Heads match when one is a prefix of the other (a short SHA against a full one). */
export function sameHead(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 ? a.slice(0, n) === b.slice(0, n) : a === b;
}

/** The spec of a ReviewSource with its defaults applied. */
export function sourceSpec(spec: J) {
  const forge = spec?.forge ?? {};
  const filters = spec?.filters ?? {};
  const review = spec?.review ?? {};
  const dispatch = spec?.dispatch ?? {};
  const retention = spec?.retention ?? {};
  return {
    forge: {
      kind: String(forge.kind ?? ''),
      host: String(forge.host ?? '').toLowerCase(),
      apiUrl: forge.apiUrl ?? defaultApiUrl(forge.kind, forge.host),
      tokenEnv: String(forge.tokenEnv ?? ''),
      maxCallsPerMinute: forge.maxCallsPerMinute ?? 30,
    },
    repositories: ((spec?.repositories ?? []) as J[]).map((r: J) => ({
      project: String(r.project),
      url: r.url ?? `https://${forge.host}/${r.project}`,
      targetBranches: r.targetBranches as string[] | undefined,
    })),
    filters: {
      requestedReviewer: filters.requestedReviewer as string | undefined,
      drafts: filters.drafts ?? false,
      bots: filters.bots ?? false,
      deletedAuthors: filters.deletedAuthors ?? false,
      ownChanges: filters.ownChanges ?? false,
      staleAfterDays: filters.staleAfterDays ?? 14,
      excludeAuthors: (filters.excludeAuthors ?? []) as string[],
      onlyAuthors: filters.onlyAuthors as string[] | undefined,
      requireLabels: (filters.requireLabels ?? []) as string[],
      excludeLabels: (filters.excludeLabels ?? ['review:stop']) as string[],
    },
    review: {
      taskConfig: String(review.taskConfig ?? ''),
      template: (review.template ?? 'generic') as 'generic' | 'thurview',
      output: (review.output ?? 'post') as 'post' | 'report',
      page: (review.page ?? 'none') as 'none' | 'snapshot',
      approveAt: review.approveAt as number | undefined,
      guidance: review.guidance as string | undefined,
    },
    dispatch: {
      by: (dispatch.by ?? 'policy') as 'policy' | 'person',
      maxActive: dispatch.maxActive ?? 2,
    },
    suspend: spec?.suspend ?? false,
    pollMs: Math.max(spec?.pollMs ?? 300_000, MINUTE),
    retention: {
      reviewMs: retention.reviewMs ?? 7 * DAY,
    },
  };
}
export type SourceSpec = ReturnType<typeof sourceSpec>;

export function defaultApiUrl(kind: string, host: string): string {
  if (kind === 'github')
    return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
  return `https://${host}/api/v4`;
}

/** The host a budget and a throttle are shared on. */
export function hostKey(spec: SourceSpec): string {
  return `${spec.forge.kind}/${spec.forge.host}`;
}

/** Fleet's condition shape; `lastTransitionTime` moves only when `status` does. */
export function condition(
  old: J[] | undefined,
  type: string,
  status: 'True' | 'False' | 'Unknown',
  reason: string,
  message: string,
  now: number,
): J {
  const prev = (old ?? []).find((c) => c?.type === type);
  const lastTransitionTime = prev && prev.status === status ? prev.lastTransitionTime : now;
  return { type, status, reason, message, lastTransitionTime };
}

export function known(obs: J): { ok: true; value: J } | { ok: false; why: string } {
  if (obs && typeof obs === 'object' && 'known' in obs) return { ok: true, value: obs.known };
  return { ok: false, why: String(obs?.unknown?.why ?? 'not asked') };
}
