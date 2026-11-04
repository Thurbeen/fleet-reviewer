# Open questions

Each question has a recommendation. The design follows the recommendation until the
operator decides otherwise.

## 1. Post or report by default?

`review.output` defaults to `report`: a new source posts nothing until a person sets
`post`.

**Recommendation:** keep `report` as the default. A wrong source, or a wrong filter, then
costs review sessions but no comment on a colleague's change.

## 2. Dispatch by a person or by policy by default?

`dispatch.by` defaults to `person`.

**Recommendation:** keep `person` as the default, and set `policy` per source once its
filters have proved right. With [a dispatch verb](fleet-core.md#2-a-dispatch-verb) in
Fleet, the person path is one command per review.

## 3. A cap across all sources?

`maxActive` bounds the review Tasks of one source. Nothing bounds the sum over all sources.

**Recommendation:** per source only, for now. One harness account is usually one source.
If a shared cap proves necessary, add a third kind, a single `ReviewPolicy` object that
every source reads, rather than reading the cap from the plugin's arguments: the
controller half must not depend on configuration outside spec.

## 4. One Task per head, or one Task that follows the change?

thurview's `pr-review` skill can follow a change until it merges, in one session.

**Decided:** one Task per change, for the change's life. A push amends it, which reopens a
Concluded Task in the same session, with its worktree and what it already reviewed.
`maxActive` counts Tasks that work, so a Concluded Task between pushes takes no slot. A
Concluded session still waits on its host until the change merges or closes.

## 5. Should a review Task declare the change it reviews?

Declaring would make Fleet mirror the change as a ChangeRequest and relay its notes and
pushes into the review session.

**Recommendation:** no. The relay would send every note on a colleague's change to the
reviewer, and a ready policy could take the colleague's draft out of draft. The plugin
already tells the session about a new push, and thurview reads the threads it needs.

## 6. The Fleet worker mark and the operator's sign-off

Fleet's worker policy ends each post with `<!-- fleet:worker <uid> -->` on its own line.
thurview's `signoff` is one line, and `sync` refuses a line break in it. The operator's
own sign-off line competes for the same place.

**Recommendation:** put the worker mark alone in `signoff`, as the brief says, and ask
thurview for a separate hidden `marker` field in the pass. The operator's sign-off then
goes in `signoff` again.

## 7. Choosing repositories from `runtime.repositories`

Thurbeen/fleet#351 suggested the repositories of `runtime.repositories` as a default
scope. The controller half cannot read the config, and a default of "every mapped
repository" is the unscoped run the requirements exclude.

**Recommendation:** explicit repositories only. A later `fleet-reviewer source` helper
command may print a `ReviewSource` from a list of mapped URLs for a person to edit.

## 8. How the plugin is distributed

**Decided:** no bundle and no package. `src/plugin.ts` uses only TypeScript syntax that
Node.js strips, and it has no runtime dependency. Node.js 22.18 or later runs it as is.
The operator checks out a pinned commit or release tag and registers that path. The
operator installs no new binary.

## 9. The Fleet TypeScript SDK

Fleet's plugin interface describes a TypeScript SDK, `@fleet/plugin`. It is not on npm
today.

**Recommendation:** write the protocol layer in this repository: JSON Lines in, one
answer out, the five calls. Keep it small and separate from the decisions, so it can be
replaced by the SDK when one ships.

## 10. Bot authors on GitLab

GitLab's merge request listing does not say whether the author is a bot.

**Recommendation:** decide from the access-token user name pattern and `excludeAuthors`,
at no extra call. Read each new author's `bot` flag from the users API only if that
proves insufficient, and cache it in the source's status.
