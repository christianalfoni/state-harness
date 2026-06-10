# Pitch: Running the agent headlessly on GitHub

> A goal becomes a GitHub issue. The agent works in a sandbox, opens a PR, and
> when it's stuck it asks a question on the PR and **pauses** — durably, with no
> compute running — until a human replies. The reply wakes it back up. The whole
> thing needs **no servers** to start.

This works because of three properties the harness already has:

1. **Communication is structured, not prose.** The agent only ever emits a goal
   status, structured mental notes, a `blockedBy` reason, and a `verification`.
   A headless runner can react to these *deterministically* — no output parsing.
2. **Blocking is a durable pause.** `setBlockedBy` ends the run cleanly. There's
   nothing to keep alive; the process can exit and resume later.
3. **State can live in the branch.** A serialized session (`.state-harness/runs/<pr>.json`)
   travels with the code it's producing, so any fresh sandbox can rehydrate it.

Together these turn the problem into **event → ephemeral job**, which is exactly
what GitHub Actions is — so Actions can *be* the service.

---

## The core loop

```
trigger (issue labeled / assigned / slash-command)
        │
        ▼
  sandbox: agent.run(goal)
        │
        ├── completed → push branch, PR "ready for review"  (+ summary, verification, cost)
        │
        └── blocked   → push branch, open DRAFT PR,
                        comment(blockedBy + relevant notes),
                        snapshot session → branch, EXIT
                                   │
                                   ▼
        human replies on the PR ──► webhook/event ──► sandbox: resume(snapshot), unblock(comment)
                                                              └── loop ──┘
```

The cognition signals map 1:1 onto GitHub artifacts:

| Cognition signal | GitHub action |
| --- | --- |
| `stoppedBy: "blocked"` + `blockedBy` | draft PR + a question comment; stop the sandbox |
| human PR comment | resume the session, `unblock(comment)`, continue |
| `stoppedBy: "completed"` + `verification` | mark PR ready for review; post summary + verification |
| `notes` (decision + rejected alternatives, findings…) | the **PR body** — structured rationale, not prose |
| `verification` | the **merge gate** — "how I proved it works" |
| `skillGap` / `skillSuggestions` | file an issue, or a PR that *adds* the skill |
| `reference` → distilled docs | commit `.state-harness/docs/**` — versioned project memory |
| `estimatedCost`, `usage` | post on the PR / Project; enforce a budget ceiling |

---

## The block / unblock flow in detail

This is the mechanism the whole thing hinges on. A run has exactly three exits —
`completed`, `blocked`, or `error` — and **`blocked` is the interesting one**
because it spans an arbitrary, human-paced gap with **no compute running** in
between.

### Lifecycle

```
                ┌──────────────── human comment ────────────────┐
                ▼                                                │
(trigger) → [running] ──blocked──► [awaiting input] ──resume──► [running] ──┐
                │                   (draft PR, sandbox gone)                │
                │                                                           │
                └────────────── completed ──────────────────────────◄──────┘
                                     │
                                     ▼
                            [ready for review] → (human merges) → [done]
```

Crucially, `[awaiting input]` is **not a process**. It's a state recorded in the
PR + branch. Zero compute is consumed while waiting hours or days for a reply.

### 1. The run job (on trigger)

```ts
const goal = goalFromIssue(issue);              // issue title/body → the goal
const session = agent.createSession(goal);
const result = await session.run();
await handleOutcome(session, result);           // see below
```

### 2. `handleOutcome` — what a block produces

```ts
async function handleOutcome(session, result) {
  const branch = `agent/${issueNumber}`;
  await git.pushWorkTo(branch);                 // the code so far

  if (result.stoppedBy === "blocked") {
    const reason = session.getState().blockedBy;            // the question
    await writeSnapshotToBranch(session.snapshot(), branch); // .state-harness/runs/<id>.json (committed)
    await ensureDraftPR(branch, { body: prBodyFrom(session.getState()) });  // notes = rationale
    await comment(pr, blockComment(reason, session.getState()));            // the question + context
    await setLabels(pr, ["agent", "agent:blocked"]);        // and Project Status = Blocked
    return;                                                  // ← sandbox EXITS. Nothing runs.
  }

  if (result.stoppedBy === "completed") {
    const { summary, verification } = session.getState().goal;
    await markReadyForReview(pr);
    await comment(pr, doneComment(summary, verification, session.estimatedCost()));
    await setLabels(pr, ["agent"], remove: ["agent:blocked"]); // Project Status = In review
    return;
  }

  // "max-turns" / thrown error → leave draft, label agent:error, post the failure.
  await comment(pr, errorComment(result));
  await setLabels(pr, ["agent", "agent:error"]);
}
```

The **block comment** is what the human acts on. It contains:
- the `blockedBy` reason verbatim (the precise question/need), and
- the relevant notes for *why* — the `decision` (+ rejected alternatives), the
  `skillGap`, what's done so far. The human shouldn't have to read the diff to
  understand the question.

The **PR body** is built from the structured notes — it's the rationale, kept in
sync on each block.

### 3. The wait

Nothing. The draft PR sits there with the `agent:blocked` label and a pending
question. The branch holds both the work-in-progress **and** the serialized
session (`.state-harness/runs/<id>.json`). The human is notified (PR comment /
assignee / a *Blocked* column on the board) and replies whenever they can.

### 4. The resume job (on `issue_comment`)

```ts
// ── guards first — most events are not a resume signal ──
if (!isAgentPR(pr)) return;                      // branch prefix / label marker
if (comment.author is a bot) return;             // loop prevention (skip our own comments)
const snapshot = await readSnapshotFromBranch(pr.headRef);
if (!snapshot || snapshot.blockedBy === null) return;  // not actually awaiting input → ignore
if (!isAddressedToAgent(comment)) return;        // see "what counts as a reply" below

// ── resume ──
const session = agent.resume(snapshot);
const result  = await session.unblock(comment.body);   // the reply IS the unblock message
await handleOutcome(session, result);            // → ready-for-review, or block again
```

Add `concurrency: { group: "agent-${pr}", cancel-in-progress: false }` to the
workflow so two near-simultaneous comments can't run two resume jobs on the same
PR — they queue and run in order.

### 5. Multiple rounds

Every block is just another question comment; every human reply is another resume.
The PR conversation threads the back-and-forth naturally, and the transcript
(plus compaction over long gaps) keeps the agent coherent across days. The snapshot
on the branch is **overwritten on each block** with the latest session state, so a
resume always rehydrates from the most recent point.

### What counts as a "reply"?

Two options, pick per taste:
- **Addressed only (recommended):** only a comment that replies to the bot's
  question or starts with `@agent` becomes the `unblock` message. Unrelated PR
  chatter is ignored. Robust against humans discussing the PR without meaning to
  steer the agent.
- **Any human comment:** simplest, but it treats *all* conversation as input —
  fine for a solo workflow, noisy with multiple reviewers.

### Edge cases & guards

| Situation | Handling |
| --- | --- |
| Comment while not blocked (PR done, or mid-nothing) | snapshot's `blockedBy === null` → ignore |
| The bot's own comment | skip by author; default `GITHUB_TOKEN` also won't trigger workflows |
| Two reviewers comment at once | `concurrency` group serializes; resume reads the triggering comment |
| Human pushes their own commits while blocked | fine — the agent re-reads files on resume (snapshot is *reasoning* state, not a file cache) |
| PR closed / `agent` label removed | abandon; optionally delete the run file |
| Budget ceiling hit mid-run | surface as a block ("approve more spend?") → same flow |
| Provider error / max-turns | `agent:error` label + a failure comment; PR stays draft, human can re-trigger |

The thing that makes all of this safe and cheap: **the only durable state is the
branch** (work + snapshot) and **the PR is the conversation**. Sandboxes are
disposable; they boot, advance the session by one `run()`/`unblock()`, persist, and
die.

---

## Infrastructure approaches, compared

| | **A. Actions-only** | **B. Actions + managed sandbox** | **C. GitHub App + service** |
| --- | --- | --- | --- |
| Servers to run | **none** | none (sandbox is a vendor API) | a webhook service + dispatcher |
| Sandbox | the Actions runner VM | E2B / Fly Machines / Modal / Daytona / CF Containers | yours, via the managed sandbox or your own |
| Trigger | issue/PR/comment events, cron | same | App webhooks (incl. `projects_v2_item`) |
| Auth | built-in `GITHUB_TOKEN` | `GITHUB_TOKEN` / App token | GitHub App installation token |
| Latency to start | ~10–30s cold | fast boot (sub-second on some) | fast, warm pools possible |
| Custom image / network policy | limited | **yes** | yes |
| Multi-repo / scale / dashboard | clunky | OK | **yes** |
| Effort | **lowest** | low–medium | high |

### A. GitHub Actions only — *start here*
Two workflow files + our headless runner (a Node script in the repo). One workflow
triggers on `issues: [labeled "agent"]` / `workflow_dispatch`; another on
`issue_comment` (which also fires for PR conversation comments) to resume. The job
checks out the repo, runs the agent loop, and pushes / opens the PR / comments via
`GITHUB_TOKEN`. State persists in the branch, so the resume job just reads the
snapshot. **Zero hosting, zero DB, native auth, isolated ephemeral sandbox — all
built in.**

> Useful quirk: actions taken with the default `GITHUB_TOKEN` **don't trigger
> further workflows**. That's loop-prevention we *want* — the bot's own comment
> shouldn't wake itself; only a human reply should. (If you ever need the bot to
> chain off its own actions, switch to a GitHub App token, which does trigger.)

### B. Actions + managed sandbox
Keep Actions for triggers/auth, but offload the *execution* to a fast-booting
ephemeral-compute API (E2B, Fly Machines, Modal, Daytona, Cloudflare Containers).
Reach for this when you need a **custom sandbox image** (pre-installed toolchains,
a browser for UI validation), tighter **network policy**, or lower start latency.

### C. GitHub App + custom service
A real service: a GitHub App (bot identity, per-repo scoped tokens, higher rate
limits, and — crucially — the only way to receive `projects_v2_item` webhooks)
plus a dispatcher that spins sandboxes per event. This is the **product** path:
multi-repo, instant board-driven dispatch, a dashboard, warm pools. Don't build it
until a concrete limit in A/B actually bites.

---

## GitHub Projects as mission control

Projects is the best *dashboard* for this — each goal is a Project item, and the
structured output maps onto **custom fields**:

| Project field | Fed from |
| --- | --- |
| **Status** | `stoppedBy` → `Working` / `Blocked` / `In review` / `Done` |
| **Blocked on** (text) | `blockedBy` |
| **Cost** (number) | `session.estimatedCost()` |
| **Verified** (text) | `verification` |
| **Tokens / tool calls** (number) | `usage` |

A board row per goal: who's working, who's *Blocked* and on what, cost so far,
whether it was actually verified before review. The agent writes these via the
**GraphQL Projects API** from inside the same job. Built-in Project automations
handle the free transitions (auto-add labeled issues, set `Done` on PR merge).

**Constraint to know:** Actions has **no trigger for Project item moves** —
`projects_v2_item` is an App/webhook event only ([not planned for
Actions](https://github.com/orgs/community/discussions/40848)). So:

- **Dashboard (any approach):** the agent *writes* fields; trigger off the issue.
- **Board-as-queue, Actions-only:** a **scheduled poll** (cron workflow) queries
  the project for items in `Ready for agent`, claims each by setting `Working`,
  and runs it. Board-driven dispatch with no servers — just a few minutes' lag.
- **Board-as-queue, instant:** a GitHub App webhook on `projects_v2_item`
  (approach C).

---

## The one primitive everything depends on: snapshot / resume

Resuming in a *fresh* sandbox means serializing the whole session, not just
`AgentState`. Today `createSession({ state })` rehydrates goal + notes + blocked,
but the **message transcript and action ledger** aren't serialized yet. We need:

```ts
const snapshot = session.snapshot();      // → JSON: goal, notes, blockedBy, transcript, ledger
const session  = agent.resume(snapshot);  // continue in a new process/sandbox
```

Persist that snapshot **in the branch** (`.state-harness/runs/<pr>.json`,
committed). Then sandboxes are fully stateless and state travels with the code in
git — no external store. This primitive is required for *every* infra approach, so
it's the first thing to build.

---

## Secrets

The security stance is **least privilege + keep secrets out of the agent's reach**.
Two distinct credential needs, with different exposure:

| Secret | Who needs it | Where it lives | Exposure rule |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | the **runner** (to call the model) | Actions/org secret | needed by the orchestrator, **not** by the agent's tools |
| GitHub write access | the runner (push, PR, comment) | `GITHUB_TOKEN`, or a GitHub App installation token | scope to the repo/branch only |
| Validation/test creds (optional) | a **validation skill** | injected per-run, scoped, non-prod | never prod; never broad |

The sharp edge: **a coding agent runs `bash`, so anything in its process env it can
`echo`.** If the runner and the agent's `bash` share an environment, the agent can
read `ANTHROPIC_API_KEY` and the GitHub token. Mitigations, in order of strength:

1. **Scrub the tool env.** The `bash`/exec tools spawn child processes with a
   *filtered* environment that excludes the runner's secrets. The harness calls the
   model; the agent's shell never sees the key. (Cheapest, do this regardless.)
2. **Separate the credential boundary.** Run the agent's tools in a nested sandbox
   (or the managed-sandbox of approach B) that simply never receives the secrets —
   the runner mediates GitHub writes on the agent's behalf rather than handing it a
   token.
3. **GitHub App over PAT.** App installation tokens are short-lived, per-repo, and
   least-privilege — far better than a personal token if one leaks.

**Fork / untrusted PRs:** `pull_request` runs from forks **don't get secrets** (by
design). Gate the agent on trusted actors / your own repos; never run it with
secrets on untrusted fork input. This is the main thing that separates "your repos"
(simple, safe) from "public/forks" (needs `pull_request_target` discipline).

**Never** put secrets in the goal text, mental notes, the transcript, or the
branch snapshot — those are persisted and surfaced. Secrets are injected at runtime
into the environment that needs them, and only that one.

---

## Deployments & validation

The harness is **validation-first**: a goal isn't done until proven from the user's
perspective. That intersects deployments, so be explicit:

- **The agent doesn't deploy to production.** It produces a PR. Your existing CI/CD
  deploys on merge. Merge stays human-gated (and can be gated on `verification` +
  CI re-running the validation skill). The agent never holds prod credentials.
- **Validation happens against a sandbox or preview, not prod.** Two patterns:
  - *In-sandbox:* the agent runs the app in its sandbox (`npm run dev`, a local
    server, a headless browser) and validates against `localhost`. Self-contained.
  - *Preview deploy:* if the deliverable needs a real environment, lean on
    **per-PR preview deploys** (Vercel/Netlify previews, a preview environment) and
    have the agent validate against the preview URL.
- **When validation needs a capability it lacks** (a browser to drive a UI, a test
  credential to hit a real service), that's a **missing skill** — the agent builds
  the skill if it can, or **blocks** and asks. The human can then provide a *scoped,
  non-prod* test credential (injected into that validation skill's env), or approve
  adding the skill. This keeps "what can touch real services" an explicit,
  human-approved decision rather than something the agent improvises.
- **CI as the second check.** Because `verification` is structured, CI can require
  it to be present and can re-run the validation skill independently before the PR
  is mergeable — so "the agent says it verified" is backed by a reproducible check.

---

## Recommended rollout

1. **Build `snapshot()` / `resume()` + state-in-branch.** Required by everything.
2. **Approach A (Actions-only):** the two workflows + headless runner; secrets via
   Actions secrets; env-scrubbed `bash`. Proves the entire loop on your own repos
   with zero hosting.
3. **Projects dashboard:** write Status / Blocked-on / Cost / Verified via GraphQL
   from the job. Optionally add the **scheduled-poll queue**.
4. **Graduate only on a real limit:** managed sandbox (B) for custom images / UI
   validation / latency; GitHub App + service (C) for multi-repo, instant
   board-driven dispatch, or a hosted product.

## Open questions

- Own/private repos only, or public + forks? (Determines the secrets/trigger story.)
- Acceptable resume latency? (Actions cold-start vs. managed sandbox.)
- Is UI validation a day-one need? (If yes, you need a browser in the sandbox →
  pushes toward approach B sooner, or a provided validation skill.)
- One board across repos, or per-repo? (Per-repo is Actions-friendly; cross-repo
  leans toward the App.)
