// The ReviewSource controller: probes and reconcile, pure
// (docs/state-machine.md#a-reviewsource-pass).

import {
  type J,
  type SourceSpec,
  DAY,
  HOUR,
  LABEL_SOURCE,
  MINUTE,
  changeKey,
  condition,
  hostKey,
  known,
  reviewName,
  sourceSpec,
} from "./util.ts";

const LIST_MAX_CALLS = 3;
const MAX_CREATES = 20;
const MAX_ENTRIES = 200;

function others(obs: J, me: string, spec: SourceSpec): J[] {
  const all = known(obs.sources);
  if (!all.ok) return [];
  return (all.value as J[]).filter(
    (s) => s?.metadata?.name !== me && hostKey(sourceSpec(s.spec)) === hostKey(spec),
  );
}

/** The host's throttle: the latest `until` any source on the host wrote. */
function throttleUntil(obs: J, me: J, spec: SourceSpec): number {
  return [me, ...others(obs, me.metadata.name, spec)]
    .map((s) => Number(s?.status?.throttle?.until ?? 0))
    .reduce((a, b) => Math.max(a, b), 0);
}

/** Calls already spent on the host this minute, by every source on it. */
function hostSpent(obs: J, me: J, spec: SourceSpec, minute: number): number {
  return [me, ...others(obs, me.metadata.name, spec)]
    .filter((s) => s?.status?.budget?.minute === minute)
    .reduce((n, s) => n + Number(s.status.budget.calls ?? 0), 0);
}

function hostBudget(obs: J, me: J, spec: SourceSpec): number {
  return [spec, ...others(obs, me.metadata.name, spec).map((s) => sourceSpec(s.spec))]
    .map((s) => s.forge.maxCallsPerMinute)
    .reduce((a, b) => Math.min(a, b), Infinity);
}

/** Calls the forge answers in this pass cost so far. */
function usedThisPass(obs: J): number {
  return Object.entries(obs ?? {})
    .filter(([id]) => id === "whoami" || id.startsWith("list/") || id.startsWith("headAt/"))
    .reduce((n, [, o]) => n + Number((o as J)?.known?.calls ?? 1), 0);
}

function forgeRequest(spec: SourceSpec) {
  const { kind, host, apiUrl, tokenEnv } = spec.forge;
  return { kind, host, apiUrl, tokenEnv };
}

export function probes(req: J): J[] {
  const me = req.object;
  const obs = req.observations ?? {};
  const now = Number(req.now ?? 0);
  const name = me.metadata.name;
  const spec = sourceSpec(me.spec);
  const out: J[] = [];
  if (!("sources" in obs)) out.push({ id: "sources", type: "list", kind: "ReviewSource" });
  if (!("reviews" in obs)) out.push({ id: "reviews", type: "list", kind: "Review" });
  if (out.length) return out;
  if (!known(obs.sources).ok || !known(obs.reviews).ok) return [];
  if (invalid(spec) || spec.suspend || throttleUntil(obs, me, spec) > now) return [];

  const minute = Math.floor(now / MINUTE);
  let remaining = hostBudget(obs, me, spec) - hostSpent(obs, me, spec, minute) - usedThisPass(obs);
  const st = me.status ?? {};
  const forge = forgeRequest(spec);

  const accountFresh = st.account?.login && now - Number(st.account.checkedAt ?? 0) < DAY;
  if (!accountFresh && !("whoami" in obs) && remaining >= 1) {
    out.push({ id: "whoami", type: "plugin", request: { op: "whoami", forge } });
    remaining -= 1;
  }
  const repos = [...spec.repositories].sort(
    (a, b) =>
      Number(st.repositories?.[a.project]?.listedAt ?? 0) -
      Number(st.repositories?.[b.project]?.listedAt ?? 0),
  );
  for (const r of repos as J[]) {
    const id = `list/${r.project}`;
    if (id in obs || remaining < 1) continue;
    const maxCalls = Math.min(LIST_MAX_CALLS, remaining);
    out.push({
      id,
      type: "plugin",
      request: { op: "listChanges", forge, project: r.project, maxCalls, name },
    });
    remaining -= maxCalls;
  }
  // GitLab lists no commit dates: read each new head's date once.
  if (spec.forge.kind === "gitlab") {
    for (const r of spec.repositories as J[]) {
      const listed = known(obs[`list/${r.project}`]);
      if (!listed.ok) continue;
      for (const c of listed.value.changes ?? []) {
        const key = changeKey(r.project, c.number);
        const prev = st.changes?.[key];
        const id = `headAt/${key}`;
        if (c.headAt || (prev?.head === c.head && prev?.headAt) || id in obs || remaining < 1) {
          continue;
        }
        out.push({
          id,
          type: "plugin",
          request: { op: "readHeadDate", forge, project: r.project, head: c.head },
        });
        remaining -= 1;
      }
    }
  }
  return out;
}

function invalid(spec: SourceSpec): string | null {
  if (spec.review.page === "snapshot" && spec.review.output !== "post") {
    return "review.page snapshot requires review.output post";
  }
  if (spec.review.page === "snapshot" && spec.review.template !== "thurview") {
    return "review.page snapshot requires review.template thurview";
  }
  return null;
}

/** The first filter that excludes the entry, or null when every filter admits it. */
export function verdict(
  spec: SourceSpec,
  e: J,
  login: string | undefined,
  hasReview: boolean,
  now: number,
): string | null {
  const f = spec.filters;
  const author = String(e.author?.login ?? "");
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const repo = spec.repositories.find((r) => r.project === e.project);
  if (e.draft && !f.drafts) return "drafts";
  if (e.author?.kind === "bot" && !f.bots) return "bots";
  if (e.author?.kind === "deleted" && !f.deletedAuthors) return "deletedAuthors";
  if (!f.ownChanges) {
    if (!login) return "accountUnknown";
    if (eq(author, login)) return "ownChanges";
  }
  if (!e.headAt) return "headAtUnknown";
  if (now - Number(e.headAt) > f.staleAfterDays * DAY) return "staleAfterDays";
  if (f.excludeAuthors.some((a) => eq(a, author))) return "excludeAuthors";
  if (f.onlyAuthors && !f.onlyAuthors.some((a) => eq(a, author))) return "onlyAuthors";
  const labels: string[] = e.labels ?? [];
  if (f.requireLabels.some((l) => !labels.includes(l))) return "requireLabels";
  if (f.excludeLabels.some((l) => labels.includes(l))) return "excludeLabels";
  if (repo?.targetBranches && !repo.targetBranches.includes(e.base)) return "targetBranches";
  if (f.requestedReviewer) {
    const who = f.requestedReviewer;
    const requested = (e.requested ?? []).some((r: string) => eq(r, who));
    // GitHub drops a reviewer from the request once they review: a change
    // already followed stays followed while the reviewer has reviewed it.
    const reviewed = hasReview && (e.reviewedBy ?? []).some((r: string) => eq(r, who));
    if (!requested && !reviewed) return "requestedReviewer";
  }
  return null;
}

export function reconcile(req: J): J {
  const me = req.object;
  const obs = req.observations ?? {};
  const now = Number(req.now ?? 0);
  const name = me.metadata.name;
  const spec = sourceSpec(me.spec);
  const old = me.status ?? {};
  const oldConds: J[] = old.conditions ?? [];
  const base = {
    phase: "Listing",
    observedGeneration: me.metadata.generation,
    account: old.account ?? null,
    repositories: old.repositories ?? {},
    changes: old.changes ?? {},
    budget: old.budget ?? null,
    throttle: old.throttle ?? null,
  };
  const attention = (reason: string, message: string) =>
    condition(oldConds, "NeedsAttention", "True", reason, message, now);
  const quiet = () => condition(oldConds, "NeedsAttention", "False", "None", "", now);

  const bad = invalid(spec);
  if (bad) {
    return {
      status: { ...base, conditions: [attention("InvalidSpec", bad)] },
      notBefore: now + spec.pollMs,
    };
  }
  const sources = known(obs.sources);
  const reviews = known(obs.reviews);
  if (!sources.ok || !reviews.ok) {
    const why = !sources.ok ? sources.why : !reviews.ok ? reviews.why : "";
    return {
      status: { ...base, conditions: [attention("StoreUnknown", why)] },
      notBefore: now + spec.pollMs,
    };
  }
  if (spec.suspend) {
    return {
      status: { ...base, phase: "Suspended", conditions: oldConds },
      notBefore: now + spec.pollMs,
    };
  }
  const until = throttleUntil(obs, me, spec);
  if (until > now) {
    return {
      status: {
        ...base,
        phase: "Throttled",
        conditions: [
          condition(oldConds, "Throttled", "True", "RateLimited", `until ${until}`, now),
        ],
      },
      notBefore: until,
    };
  }

  // Budget and throttle from this pass's answers.
  const minute = Math.floor(now / MINUTE);
  const used = usedThisPass(obs);
  const budget = {
    minute,
    calls: (old.budget?.minute === minute ? Number(old.budget.calls ?? 0) : 0) + used,
  };
  let throttle = old.throttle ?? null;
  let anyKnown = false;
  let throttled: J = null;
  for (const [id, o] of Object.entries(obs)) {
    if (!(id === "whoami" || id.startsWith("list/") || id.startsWith("headAt/"))) continue;
    const ans = o as J;
    if (ans && "known" in ans) anyKnown = true;
    else if (ans?.unknown?.why === "Throttled") throttled = ans.unknown;
  }
  if (throttled) {
    const streak = Number(old.throttle?.streak ?? 0);
    const wait = Math.min(HOUR, Number(throttled.retryAfterMs ?? 60_000) * 2 ** streak);
    throttle = { until: now + wait, streak: streak + 1, why: "Throttled" };
  } else if (anyKnown) {
    throttle = null;
  }

  const who = known(obs.whoami);
  const account = who.ok ? { login: who.value.login, checkedAt: now } : (old.account ?? null);

  // Entries: replace what each Known listing answered; keep the rest.
  const projects = new Set(spec.repositories.map((r) => r.project));
  const repositories: J = {};
  const changes: J = {};
  for (const [key, e] of Object.entries(old.changes ?? {})) {
    if (projects.has((e as J).project)) changes[key] = e;
  }
  let complete = true;
  for (const r of spec.repositories as J[]) {
    const prev = old.repositories?.[r.project] ?? {};
    const ans = obs[`list/${r.project}`];
    const listed = known(ans);
    if (listed.ok) {
      repositories[r.project] = { listedAt: now };
      for (const key of Object.keys(changes)) {
        if (changes[key].project === r.project) delete changes[key];
      }
      for (const c of listed.value.changes ?? []) {
        const key = changeKey(r.project, c.number);
        const prevEntry = old.changes?.[key];
        const dated = known(obs[`headAt/${key}`]);
        const headAt =
          c.headAt ??
          (dated.ok ? dated.value.headAt : null) ??
          (prevEntry?.head === c.head ? prevEntry?.headAt : null) ??
          null;
        changes[key] = { ...c, project: r.project, headAt };
      }
    } else {
      repositories[r.project] = ans
        ? { ...prev, unknown: { why: String(ans?.unknown?.why ?? "Unknown"), at: now } }
        : prev;
      if (!prev.listedAt || ans) complete = false;
    }
  }

  // Filters and Reviews.
  const all: J[] = reviews.value ?? [];
  const byName = new Map(all.map((r) => [r.metadata?.name, r]));
  const creates: J[] = [];
  const overlap: string[] = [];
  let pending = 0;
  const keys = Object.keys(changes).sort();
  for (const key of keys) {
    const e = changes[key];
    const rname = reviewName(spec.forge.host, e.project, Number(e.number));
    const existing = byName.get(rname);
    const v = verdict(spec, e, account?.login, !!existing, now);
    e.verdict = v ? "excluded" : "included";
    if (v) e.reason = v;
    else delete e.reason;
    e.review = existing || !v ? rname : null;
    if (v) continue;
    const repo = repositories[e.project];
    const stale = repo?.unknown && Number(repo.unknown.at) >= Number(repo.listedAt ?? 0);
    if (existing && existing.spec?.source !== name) {
      overlap.push(key);
    } else if (!existing && !stale) {
      // An Unknown listing creates nothing: its entries are the last ones read.
      if (creates.length >= MAX_CREATES) {
        pending += 1;
        continue;
      }
      creates.push({
        apiVersion: "fleet/v1alpha1",
        kind: "Review",
        metadata: { name: rname, labels: { [LABEL_SOURCE]: name } },
        spec: {
          source: name,
          forge: { kind: spec.forge.kind, host: spec.forge.host },
          project: e.project,
          number: Number(e.number),
          url: e.url,
        },
      });
    }
  }
  const tooMany = keys.length > MAX_ENTRIES;
  const kept: J = {};
  for (const key of keys.slice(0, MAX_ENTRIES)) kept[key] = changes[key];

  const included = keys.filter((k) => changes[k].verdict === "included").length;
  const conditions = [
    condition(
      oldConds,
      "Listed",
      complete ? "True" : "False",
      complete ? "Complete" : "Incomplete",
      `${included} included, ${keys.length - included} excluded`,
      now,
    ),
    condition(
      oldConds,
      "Throttled",
      throttle && throttle.until > now ? "True" : "False",
      throttle ? "RateLimited" : "None",
      "",
      now,
    ),
    condition(
      oldConds,
      "Overlap",
      overlap.length ? "True" : "False",
      overlap.length ? "OtherSource" : "None",
      overlap.join(", "),
      now,
    ),
    tooMany ? attention("TooMany", `${keys.length} changes, more than ${MAX_ENTRIES}`) : quiet(),
  ];
  const plan: J = {
    status: {
      ...base,
      phase: throttle && throttle.until > now ? "Throttled" : "Listing",
      account,
      repositories,
      changes: kept,
      budget,
      throttle,
      conditions,
    },
    notBefore: pending ? now + 5000 : throttle?.until > now ? throttle.until : now + spec.pollMs,
  };
  if (creates.length) plan.creates = creates;
  return plan;
}
