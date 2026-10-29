# Agent rules

fleet-reviewer is a Fleet plugin, written in TypeScript, that finds open pull and merge
requests and starts review Tasks. Today the repository holds its design only. Read
[the design](docs/README.md) before a change in its area, and Fleet's
[plugin contract](https://github.com/Thurbeen/fleet/tree/main/docs/controllers/plugin)
before a change to a call, a probe or a plan. Keep the design simple and explicit.

- For an issue, first write an end-to-end regression and observe it fail for the
  intended reason. New functionality starts with executable acceptance.
- Never give estimates of time, effort, or completion.
- Prefer a clear diagram to a long explanation when one fits.
- Check versions in registries, release metadata and lockfiles; never guess. Take the
  latest stable release.
- Publishing uses the installed `publish` skill, normal commit hooks and the full
  repository gate. A local-only contribution must not push, merge, tag, release, or
  deploy.
- Work in an isolated worktree. Never change a running Fleet manager, its store, config,
  credentials or sessions as a side effect.
- Split work to fit the available context.
- Never put client names, private paths, host names, addresses, account identities or
  live records in code, fixtures, docs, commit messages or forge comments. Examples use
  `OWNER`, `example.com` and `REVIEWER_TOKEN_A`.

## Boundaries

The plugin has two halves in one program, selected by the call Fleet makes.

- The controller half (`manifest`, `probes`, `reconcile`) is pure. It reads no file,
  variable, clock, process or network. Everything it decides arrives in the request.
- The observer half (`observe`, `perform`) reads the forge, bounded by Fleet's call
  timeout, and answers Known or Unknown. It writes nothing on a forge.
- Every forge write is the review Task's, through thurview. The plugin plans no effects.
- Unknown never means absent, closed, empty or excluded.
- The plugin persists nothing outside the status of its own objects.

A change to the contract the plugin needs from Fleet is a proposal in
[docs/fleet-core.md](docs/fleet-core.md) and an issue on Thurbeen/fleet. Never work around
a missing Fleet verb by reaching past the protocol.

## Repository tooling

`prek run --all-files` is the gate, shared by the hooks, the publish skill and CI. It
lints Markdown with rumdl, shell scripts with ShellCheck, and scans for secrets with
gitleaks. Install the hooks once with `prek install`.

The implementation will use Node.js, pnpm, TypeScript and Vitest, as thurview does. Add
`package.json`, the lockfile and their gate steps with the first code, at the latest
stable versions checked then. Do not add a toolchain before code needs it.

Read `~/.agent-rules/OPINIONS.md` before picking tools, adding dependencies or changing CI.
Read `~/.agent-rules/VOICE.md` before publishing prose on behalf of the operator. Do not
invent these files if they are absent.

## Writing specs

A design document describes the flows, the APIs and the behaviour that a user, an
operator or Fleet can observe. It states each guarantee as a rule. It does not describe
the algorithm that keeps the guarantee; the code and its tests own that.

Write design and interface documents in the style of ASD-STE100 Simplified Technical
English. Follow its writing rules, not its controlled vocabulary:

- Write one fact per sentence, in about 25 words or fewer.
- Give each paragraph one topic.
- Use the active voice and name the subject. Do not let "it" or "that" point across
  sentences.
- Use one term for one concept, and define a term before you use it.
- Write steps and conditions as lists, not as chains of clauses.
- Keep the reason for a rule in a sentence apart from the rule.

When you rewrite existing text, change its form only. Keep every heading's text, so its
anchor still resolves.

Diagrams are hand-written SVG that read on light and dark backgrounds, in the style of
Fleet's controller diagrams, or Mermaid in Markdown.
