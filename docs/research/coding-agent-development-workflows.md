# Coding-Agent Development Workflows in Public Repositories

> [!NOTE]
> This is non-normative research for the greenfield OpenAB orchestration
> project. It does not change the repository's implementation authority,
> Wayfinder map, domain language, or accepted workflow. Repository candidates
> require maintainer resolution before they become rules.

Research checked on August 14, 2026.

## Scope and evidence labels

This report asks how public software projects that visibly use coding agents
handle implementation, review, repair, and handoff. It focuses on five
questions:

1. Does an implementation loop continue through more than one actionable
   review/fix cycle?
2. What bounds the loop?
3. Which changes require human authorization?
4. How is the exact review target and its provenance preserved?
5. How do projects prevent infinite churn and scope drift?

Only primary sources are used: repository instructions and workflow files,
official product documentation, and public PR/review histories. The report uses
three labels:

- **Source finding** — directly supported by a cited first-party source.
- **Research synthesis** — an interpretation across sources, not a rule owned
  by any one project.
- **Repository candidate** — a possible change for this repository, not an
  accepted decision.

## Executive summary

**Research synthesis.** The strongest public examples do not support either of
these extremes:

- stop after one review-fix pass even though the remaining findings are
  concrete, in scope, and mechanically resolvable; or
- keep asking a nondeterministic reviewer for unrestricted fresh opinions until
  it happens to return no suggestions.

The recurring pattern is a **scope-bounded convergence loop**:

```text
freeze the acceptance boundary and exact candidate
                    |
                    v
              full review once
                    |
                    v
       fix valid in-scope blockers as a batch
                    |
                    v
 focused re-review: unresolved + delta + regressions + acceptance criteria
                    |
          +---------+---------+
          |                   |
   valid blocker remains   exact gates green,
          |                no valid blocker
          +---- repeat          |
                               v
                         human handoff
```

Continuation is normally automatic while the frozen contract is unchanged,
the finding has actionable evidence, and the loop is making progress. Human
authority is reserved for changing that contract, accepting material residual
risk, choosing among materially different product or architecture directions,
overriding a safety circuit breaker, or resolving non-convergence.

This suggests that the current
[bounded implementation loop](../agents/implementation-loop.md), which allows
at most one review-fix pass, is too mechanical. A better bound is a combination
of immutable review targets, incremental-review rules, explicit finding
lineage, no-progress detection, resource circuit breakers, and named human
decision gates.

## 1. Identifying the maintainer's `openabdev` reference

**Source finding.** `openabdev` is a GitHub organization, not one repository.
Its public repositories include `openab`, `octobroker`, `studio`, and `wizard`
([organization](https://github.com/openabdev)). The most relevant reference for
this question is [`openabdev/openab`](https://github.com/openabdev/openab/tree/448b05fbcc17d1ebe52fdc8f78344018bd50b080):
it contains coding-agent instructions, a formal Review Contract, an automated
agent review workflow, and public agent-authored or agent-reviewed PR histories.

This identification is based on those repository artifacts, not merely the
organization name.

## 2. `openabdev/openab`: freeze the contract, then review incrementally

### 2.1 Written process

**Source finding.** OpenAB's Review Contract makes the PR description the
canonical contract and assigns different authority to author, reviewer, and
maintainer. The maintainer freezes the contract and is the authority that may
accept correctness, security, operational, or data-loss residual risk
([Review Contract, responsibilities](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/docs/review-contract.md#L37-L47)).

The freeze record includes a contract revision, the exact reviewed head commit,
and either the contract text or its SHA-256. After that freeze, review is limited
to unresolved findings, changes since the last reviewed commit, regressions,
and the frozen Acceptance Criteria
([freeze and incremental review](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/docs/review-contract.md#L49-L79)).

Post-freeze blockers must carry one of four lineages: `ORIGINAL`, `REGRESSION`,
`NEW EVIDENCE`, or `SCOPE EXPANSION`. Scope expansion is non-blocking by
default. A late blocker must cite a frozen-contract violation or a reproducible
correctness, security, data-loss, or regression defect, and must provide
evidence, impact, and a testable requested change
([finding lineage and Late Blocker Gate](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/docs/review-contract.md#L81-L109)).

The default sequence is three stages: full review and freeze, fix verification,
then a final regression check. If the contract still cannot be met, the
maintainer chooses another focused round, a contract revision or split, or
closure. The cap does not suppress a genuine blocker
([stopping rule](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/docs/review-contract.md#L111-L140)).

OpenAB's older PR-review ADR expresses the repair loop directly: after a human
enables auto-fix, the agent fixes, commits, pushes, and is reviewed again until
LGTM or a limit. It documents a three-cycle soft cap per request, a 30-cycle
hard cap over the PR lifetime, and human handling for ambiguous or critical
decisions
([auto-fix cycle and safeguards](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/docs/adr/pr-review-loop.md#L161-L210)).

The current workflow preserves candidate identity more mechanically. It reads
review status for the exact head SHA, skips an already reviewed success or
failure on that SHA, permits a maintainer `/review` command to force another
review, and sends the selected SHA in the agent request
([exact-head gating](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/.github/workflows/pr-bot-review.yml#L89-L127),
[review trigger](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/.github/workflows/pr-bot-review.yml#L165-L188)).
It stops automated review at 30 pending review statuses and applies
`review-limit-reached`
([circuit breaker](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/.github/workflows/pr-bot-review.yml#L142-L163)).

### 2.2 What actual PRs show

**Source finding — useful convergence.** In
[`feat(openab-agent): xAI subscription login`](https://github.com/openabdev/openab/pull/1424),
the agent-authored branch received repeated exact-candidate reviews and repair
commits. In Round 4 the author fixed a retry-budget defect but rejected a proxy
routing demand under the Late Blocker Gate: it lacked new evidence for a frozen
contract violation and proposed a different vendor protocol. The author also
said additional rounds required maintainer authority; the PR later received a
human approval and merged
([Round 4 disposition](https://github.com/openabdev/openab/pull/1424#issuecomment-5012961184),
[final human approval](https://github.com/openabdev/openab/pull/1424#pullrequestreview-4731289711)).
This is evidence that a finding is not an instruction merely because an agent
raised it: evidence and frozen scope decide its disposition.

**Source finding — focused final verification.** The final review record for
[`feat(acp): browser control via MCP-over-ACP`](https://github.com/openabdev/openab/pull/1447)
states that it reviewed only the prior four findings, commits the previous
review had not seen, and regressions. It records the exact reviewed head,
incremental range, tests and CI, and uses mutation checks to show that three
regression tests actually fail when their fixes are removed
([Round 6 record](https://github.com/openabdev/openab/pull/1447#issuecomment-5169733360)).

**Source finding — a useful failure boundary.** In
[`feat(media): give audio and Slack video a URL`](https://github.com/openabdev/openab/pull/1460),
the author reached the 30-cycle breaker after closing everything that did not
need a maintainer decision. The remaining questions were explicitly about
accepting a behavior-changing memory cap as residual risk, revising or splitting
the frozen scope, recording risk acceptance, and resetting the circuit breaker
([maintainer-decision handoff](https://github.com/openabdev/openab/pull/1460#issuecomment-5261906514)).
That is a stronger stopping reason than the mere existence of another finding.

**Source finding — process drift is real.** In
[`feat(oabctl): programmatic delete API`](https://github.com/openabdev/openab/pull/1415),
one review froze `RC-1` at an exact commit and contract hash
([freeze record](https://github.com/openabdev/openab/pull/1415#pullrequestreview-4728927971)).
Later records reported LGTM, but a fresh agent review subsequently opened new
findings; after code findings were addressed, an exact-head operator validation
still failed, and the PR was ultimately auto-closed as stale
([failed-gate review](https://github.com/openabdev/openab/pull/1415#issuecomment-5052215772),
[auto-close](https://github.com/openabdev/openab/pull/1415#issuecomment-5081506888)).
The contract alone did not prevent churn; reviewers also had to obey its
incremental boundary.

**Evidence limitation.** The Review Contract itself was introduced by one
agent-authored commit and merged after one public approval within minutes; the
PR shows no extended public design discussion
([policy PR](https://github.com/openabdev/openab/pull/1422)). OpenAB is therefore
a valuable operational case, not a settled industry standard whose numeric
caps should be copied unchanged.

## 3. OpenAI Symphony: continue until the bounded completion bar is met

**Source finding.** Symphony's repository-owned workflow invokes Codex in an
isolated per-ticket workspace, sets a maximum of 20 agent turns per worker, and
requires a continuation attempt to resume rather than repeat finished work
([workflow configuration and continuation](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/WORKFLOW.md#L1-L51)).
That turn cap is a resource/scheduling bound; it is not a declaration that an
unfinished ticket has succeeded.

The workflow keeps a single durable workpad comment with acceptance criteria,
validation, progress, and an environment stamp containing the workspace and
commit. It sends meaningful out-of-scope work to a linked Backlog issue instead
of expanding the active ticket
([default posture and status model](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/WORKFLOW.md#L79-L138),
[workpad identity](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/WORKFLOW.md#L140-L169)).

Most directly, the attached-PR protocol gathers top-level comments, inline
comments, and review summaries; treats every actionable human or bot comment as
blocking until it is fixed or receives justified pushback; reruns validation;
and repeats the sweep until no actionable comment remains
([PR feedback sweep](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/WORKFLOW.md#L171-L185)).
Before handoff it repeats check-address-verify until feedback is exhausted and
checks are green
([completion loop](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/WORKFLOW.md#L199-L242)).

Human review is a state boundary. While the ticket is in `Human Review`, the
agent does not modify code. A human moves an approved ticket to `Merging`.
Requested rework moves to a distinct `Rework` state whose policy is a full
approach reset: close the prior PR, create a fresh branch from `origin/main`,
and rebuild the plan and evidence
([human review and rework](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/WORKFLOW.md#L244-L273)).

**Research synthesis.** Symphony is the clearest evidence for continuing an
inner implementation loop through multiple actionable repair cycles without
asking a human after each ordinary finding. It is not unbounded: ticket state,
the acceptance checklist, green checks, external-blocker rules, out-of-scope
follow-ups, per-worker turn limits, and a separate rework lifecycle bound it.

## 4. GitHub Copilot and Microsoft TypeSpec: humans request another agent pass

**Source finding.** GitHub's official Copilot guidance says a human can request
changes by mentioning `@copilot` on the PR. Copilot-created PRs require human
review and merge; Copilot cannot approve or merge them. Only users with write
access can trigger the agent, and the agent may push only to its assigned PR
branch
([reviewing Copilot output](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output),
[risk controls](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)).
Agent commits are signed, name the requesting developer as co-author, and link
to the agent session log, preserving authorship and invocation provenance.

**Source finding — observed history.** Microsoft TypeSpec PR
[`Add "Fix all: X" code action`](https://github.com/microsoft/typespec/pull/11468)
was opened by `copilot-swe-agent`. A maintainer asked `@copilot` to cover the
playground, the agent pushed a new commit and explained it, the maintainer then
reported a build/type failure, and the agent pushed another repair
([first request](https://github.com/microsoft/typespec/pull/11468#issuecomment-5130230253),
[first repair](https://github.com/microsoft/typespec/pull/11468#issuecomment-5130312830),
[second request](https://github.com/microsoft/typespec/pull/11468#issuecomment-5130436095),
[second repair](https://github.com/microsoft/typespec/pull/11468#issuecomment-5130465358)).
A human later edited the branch, another human approved, and the PR merged
([approval](https://github.com/microsoft/typespec/pull/11468#pullrequestreview-4820586050)).

This public history demonstrates at least two explicitly requested agent
repair cycles inside one PR. It does not establish a universal TypeSpec pass
limit; it shows the ordinary GitHub control model: the PR and its commits are
the durable target, a scoped human comment authorizes the next mutation, CI and
review evaluate the resulting head, and a human owns approval and merge.

## 5. GitHub Agentic Workflows: make provenance and output budgets mechanical

**Source finding.** GitHub's `gh-aw` reviewer guidance recommends read-only
repository access and constrained safe outputs, including conservative maximum
counts for review comments and at most one submitted review. With the default
GitHub token, the automated reviewer may comment or request changes but cannot
approve
([reviewer workflow pattern](https://github.com/github/gh-aw/blob/397159a5afad43b36dd58cc8de11cff943feb1ea/.github/aw/pr-reviewer.md)).

Its accepted review-attribution ADR addresses a race in which a new commit lands
while an agent reviews an older one. The compiler injects the trigger-time head
SHA and the review runtime submits that SHA as GitHub's `commit_id`; GitHub can
then mark the review outdated if the head moves
([ADR-48738](https://github.com/github/gh-aw/blob/397159a5afad43b36dd58cc8de11cff943feb1ea/docs/adr/48738-pin-review-attribution-to-reviewed-commit.md)).

**Research synthesis.** Exact-candidate identity should be enforced by the
review transport or evidence schema, not left as a prose convention. Output
budgets constrain one run's blast radius; they complement, but do not replace,
semantic stopping rules for the implementation loop.

## 6. Cross-source synthesis

| Concern | Strongest observed mechanism | Failure it prevents |
| --- | --- | --- |
| More than one fix cycle | Repeat focused repair/review while a valid blocker remains | Premature handoff of mechanically fixable defects |
| Stable scope | Frozen Goal, Non-goals, residual risks, Acceptance Criteria, and Follow-ups | Moving acceptance bar and architecture rediscovery |
| Late findings | Lineage plus a direct-evidence gate | Reviewer novelty becoming mandatory work |
| Exact target | Commit SHA on review, incremental base/head range, green checks on that head | Review attached to code the reviewer did not inspect |
| Durable progress | Tracker state plus one canonical workpad/evidence record | Session loss, duplicate work, conflicting summaries |
| Resource bounds | Per-run turn/output caps, concurrency limits, retry backoff | Runaway cost or unbounded mutation surface |
| Non-convergence | Same-failure/no-progress detection and a hard circuit breaker | Infinite agent/reviewer oscillation |
| Scope drift | Separate linked follow-up instead of expanding the ticket | An implementation ticket turning into open-ended redesign |
| Human authority | Explicit states for risk acceptance, contract revision, rework, approval, and merge | Agent silently making product or governance decisions |

**Research synthesis.** A numeric pass cap is useful as a circuit breaker, not
as the definition of completeness. Conversely, “review clean” is trustworthy
only if later reviews are incremental. An unrestricted fresh review samples a
new set of model preferences and can manufacture churn indefinitely.

The convergence predicate should therefore be evidence-based:

```text
frozen Acceptance Criteria satisfied
AND every valid in-scope blocker is fixed or justified with evidence
AND required checks are green on the exact candidate
AND no decision reserved for a human remains
```

Reviewer silence, timeout, pass-count exhaustion, and the maker's completion
claim are not substitutes for that predicate.

## 7. Repository candidates

These candidates refine the current
[implementation loop](../agents/implementation-loop.md); they do not authorize a
change by themselves.

### 7.1 Replace the one-fix-pass rule with a scoped convergence loop

After the first independent full review, let the maker continue automatically
through focused fix/re-review cycles when every remaining blocker is:

- inside the frozen ticket and Acceptance Criteria;
- concrete and supported by reproducible evidence;
- mechanically resolvable without accepting material risk or choosing a new
  product/architecture direction; and
- producing observable progress in code, tests, or evidence.

The next reviewer receives the frozen contract, prior findings and
dispositions, the last reviewed candidate, the new exact candidate, and only
the incremental diff needed to evaluate unresolved findings, regressions, and
Acceptance Criteria.

### 7.2 Make finding disposition explicit

Use four dispositions similar to OpenAB's lineage vocabulary:

- `UNRESOLVED` — previously accepted blocker still open;
- `REGRESSION` — caused by a repair in this loop;
- `NEW EVIDENCE` — a newly demonstrated violation of the frozen contract; and
- `FOLLOW-UP` — useful work outside the frozen contract.

A late blocker should name its affected acceptance criterion or invariant,
reproduction evidence, impact, and requested observable result. A style
preference or broader hardening idea becomes a follow-up, not an implementation
blocker.

### 7.3 Use layered bounds instead of one pass count

- **Semantic bound:** do not expand the frozen contract.
- **Progress bound:** stop when the same finding recurs without materially new
  evidence or the repair/review pair oscillates between alternatives.
- **Per-execution bound:** cap turns, time, tokens, and reviewer output.
- **Lifetime circuit breaker:** cap total review cycles for one ticket and
  require a maintainer decision when reached. The exact number should be chosen
  from this repository's observed review cost; OpenAB's 30-cycle example is a
  warning, not a recommended default.
- **State bound:** after exact-candidate gates are green and no valid blocker
  remains, stop mutating and hand the candidate to the human.

A soft checkpoint after several cycles may summarize convergence and change
review strategy without requiring permission to fix another ordinary in-scope
defect. The hard circuit breaker exists for non-convergence, not routine work.

### 7.4 Ask the maintainer only at a real decision boundary

Escalate when a repair would:

- change an ADR, domain contract, frozen Goal, Non-goal, residual-risk statement,
  or Acceptance Criterion;
- accept or materially alter correctness, security, data-loss, operational, or
  public-exposure risk;
- choose among materially different product or architecture directions;
- turn a scope expansion into a blocker or split the ticket;
- weaken or bypass a required verification gate;
- repeat the same failure without new evidence or hit the lifetime circuit
  breaker; or
- depend on an external mutation whose result cannot be reconciled safely.

Do not escalate merely because a first repair pass has already occurred.

A human-decision handoff should be actionable rather than a blocker dump. It
should always include:

- the exact decision and why the frozen contract cannot resolve it;
- one recommended option with its rationale;
- viable alternatives and their material trade-offs;
- the exact approval, review, or external action requested from the human; and
- the preserved candidate and the point from which the agent will resume.

If the agent has enough evidence to recommend a direction, it should do so
even though the human retains decision authority.

### 7.5 Preserve exact review provenance as data

Each review record should include:

- frozen contract revision or digest;
- base revision;
- exact reviewed candidate commit/tree digest;
- previous reviewed candidate for incremental review;
- validation commands and results for that exact candidate;
- findings with lineage and disposition; and
- reviewer identity/session provenance sufficient to distinguish maker and
  checker.

If the candidate changes while review is running, the result remains attached
to the old candidate and is marked superseded; it must not silently approve the
new head.

### 7.6 Provisional application to issue #17

The unresolved findings recorded on
[`Durably create and replay an Operator objective`](https://github.com/victorchutw/openab-orchestration/issues/17#issuecomment-5275184173)
illustrate why every finding needs a disposition but not necessarily a code
change. The following classification is a research application, not a reopened
review or an accepted ticket decision:

| Finding | Provisional disposition | Reason |
| --- | --- | --- |
| `current_projection.revision` is not explicitly compared with the capsule revision | **Fix in the same loop.** | This is a concrete integrity check within the accepted recovery/SQLite verification boundary. It does not require a new product or architecture decision. |
| First creation of `commits/` and `receipts/` does not fsync `recoveryRoot` | **Fix in the same loop.** | This directly concerns the ticket's claimed durable recovery boundary. The implementation and regression evidence should account for the repository's supported platform semantics. |
| A different request encountering a prepared commit fails closed instead of completing it and returning a normal durable disposition | **Trace to the frozen contract before changing behavior.** | The ticket explicitly covers restart, exact replay, one authoritative transition, and prevention of a second prepared revision. It does not plainly specify the observable concurrency/liveness result for a different request. If existing criteria imply recovery-before-disposition, fix it; otherwise this is a contract choice or follow-up rather than an automatic repair. **Recommended decision:** treat the prepared capsule as recoverable internal state: complete and verify it under the existing serialized write boundary, reload authoritative state, then disposition the incoming request normally. The alternative is to preserve fail-closed behavior and explicitly make caller retry part of the contract. |
| Durable-rejection orchestration is duplicated | **Non-blocking refactor unless evidence shows divergence.** | Duplication is a maintainability signal, but the recorded review did not demonstrate a standards violation or incorrect behavior. A small local cleanup may be worthwhile, but reviewer preference alone should not hold the ticket open. |

Under the proposed convergence loop, the first two findings would not justify a
maintainer handoff merely because one repair pass had already occurred. The
third would be escalated only if the frozen contract cannot decide it, and the
fourth would be fixed opportunistically or recorded as a follow-up rather than
silently treated as a blocker.

## Conclusion

The maintainer's proposed direction is substantially supported by real public
practice: an ordinary in-scope finding should usually stay inside the same
implementation loop through repair and focused re-review. The important
qualification is that the reviewer cannot receive an unrestricted new mandate
on every round. Scope freezes once, evidence and exact candidate identity are
durable, later review is incremental, and human authorization is requested for
decisions and non-convergence rather than for each additional code fix.
