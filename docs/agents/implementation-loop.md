# Bounded implementation loop

Use this loop only after the planning destination is complete and the
maintainer has authorized implementation. GitHub holds the durable work
contract; an agent session, chat transcript, or local plan does not.

The loop is maintainer-triggered. Recurring discovery may propose work but does
not claim tickets, edit code, mutate GitHub, publish artifacts, or start the
next ticket without a new authorized invocation.

## 1. Select and claim one ticket

Before claiming, choose one open leaf ticket that:

- carries `ready-for-agent`;
- has no assignee;
- has no open blocker; and
- belongs to the authorized implementation handoff.

Read `docs/agents/issue-tracker.md`, claim the ticket before editing, and refer
to it by linked title in human-facing text. The claim is the trigger for one
implementation loop; it does not authorize another ticket or a wider product
change.

Completion criterion: the ticket remains open and unblocked, its assignee is
the current implementer, and its parent specification, acceptance criteria, and
relevant repository guidance have been read.

## 2. Freeze the work contract

Before editing, identify:

- the objective and allowed file or behavior scope;
- the acceptance criteria and evidence that can satisfy each one;
- the base revision and ticket inputs being implemented;
- the validation commands and exact review target;
- actions reserved for a responsible natural person; and
- the conditions that stop or escalate the attempt.

Ask the maintainer to resolve missing, contradictory, or materially ambiguous
criteria. A material scope or product-concept change returns to planning; it
does not become an implementation assumption. Read `CONTEXT.md` before changing
product concepts and leave unresolved terminology unchanged.

Completion criterion: every acceptance criterion has an observable evidence
source, and the work can finish without expanding the ticket's authority.

## 3. Implement one coherent increment

Inspect the existing behavior before changing it. Establish a failing or
baseline observation where practical, then make the smallest coherent change
that can satisfy the ticket. Use test, build, type, schema, static-analysis, or
runtime output as feedback; agent confidence is not evidence.

Use one writable workspace per active implementation ticket. When concurrent
work needs isolation, keep task worktrees outside this checkout. Keep agent
sessions, logs, runtime state, private configuration, and evidence bundles out
of the repository.

Preserve every previously passing repository check. Change a verifier only
when the ticket explicitly requires the verifier change; demonstrate the
intended behavior independently of the changed verifier.

Completion criterion: the candidate is limited to the frozen contract and all
ticket-specific checks pass without losing an earlier repository obligation.

## 4. Verify and review the exact candidate

Run ticket-specific checks first, then the clean-checkout entry points in
`CONTRIBUTING.md`. Inspect the complete diff, generated artifacts, and working
tree so the review target is exact.

Have one independent reviewer inspect the same candidate against both the
ticket and repository standards. The reviewer may be a responsible human or a
separate read-only agent/session; the maker does not act as the only checker.
Keep the review target stable while it is being reviewed, preserve findings and
their provenance, and let the maker—not the reviewer—apply fixes.

Completion criterion: validation evidence and an independent review exist for
the same candidate, with every finding either fixed or explicitly unresolved.

## 5. Bound feedback and hand off

One initial implementation pass and at most one in-scope review-fix pass belong
to a ticket invocation. Re-run the affected checks and independent review after
that pass. Stop and return evidence to the maintainer when:

- the ticket becomes blocked, reassigned, closed, or materially changed;
- a fix requires scope, authority, or acceptance-criteria expansion;
- the same failure recurs without new actionable evidence;
- an external mutation has an uncertain result;
- safe verification would require weakening a gate; or
- the review-fix pass leaves unresolved findings.

Do not infer success from timeout, process exit, silence, or an agent's final
message. Preserve the candidate and report the blocker, attempted approaches,
observations, and safest next decision. Another pass or a successor ticket
requires maintainer authorization.

The handoff names the linked ticket and reports:

- changed behavior and files;
- the base revision and exact candidate identity;
- acceptance evidence and exact commands run;
- independent-review findings and dispositions;
- unresolved risks, assumptions, and scope deviations; and
- public-boundary relevance.

Before ending the session, persist that record as an English, non-sensitive
comment on the linked ticket or pull request. Identify the exact candidate with
an immutable commit or pull-request head, a staged-tree ID, or a digest that
covers every changed path and its content. This public evidence summary is not
an Evidence Bundle: exclude credentials, private bindings, runtime data,
sessions, logs, private paths, and operational details. If the write is not
authorized or its result is uncertain, stop and give the complete record to the
maintainer; the ticket is not complete until the maintainer persists it. Query
or reconcile an uncertain write before any retry.

A responsible natural person reviews the final content and owns DCO
certification. Push, pull request, merge, deployment, issue closure, publication
of operational material, and policy exceptions remain human decisions unless
the maintainer explicitly authorizes the exact action.

Completion criterion: the maintainer receives a reviewable candidate, and its
evidence is durably linked from the ticket; or the maintainer receives a bounded
failure report with no uncertain action silently repeated.

## Public exposure gate

Before a public push that adds migrated or operational material, stage the
exact intended tree, run `npm run check:public`, inspect the complete staged
tree and reachable history, and complete the human exposure review required by
`CONTRIBUTING.md`. A passing automated check is evidence, not publication
approval.

## 6. Recommend the next ticket

After the maintainer confirms that the current ticket is merged and every
required CI check has completed successfully, refresh the GitHub queue and
recommend exactly one next ticket. Choose an open `ready-for-agent` leaf ticket
with no assignee and no open blocker. Refer to it by linked title, explain why
it is on the current frontier, and name the work it unlocks.

While merge or required CI is pending or failed, report that status without a
next-ticket recommendation. When no ticket is eligible, say that the queue has
no frontier and name the blockers instead of recommending blocked work.

Completion criterion: the recommendation reflects tracker state read after the
successful merge and CI completion, or the absence of an eligible ticket is
explained.
