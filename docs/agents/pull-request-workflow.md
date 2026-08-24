# Pull-request development workflow

Use this workflow after an eligible ticket is claimed and before repository
publication or merge. The ticket is the work contract, the short-lived branch
is its publication line, and the pull-request head is the exact candidate.
Neither branch state nor CI replaces Runtime Core authority or maintainer
judgment.

## 1. Start one issue branch

Refresh the base without rewriting local work, then create one branch for the
claimed ticket:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c issue-<number>-<slug>
```

Keep one active ticket on the branch. Use lowercase ASCII for the slug and keep
task worktrees outside the normal checkout when concurrent isolation is
needed. Record the base revision in the frozen work contract.

Completion criterion: the branch starts at the recorded `origin/main` revision
and names exactly the claimed open ticket.

## 2. Build signed-off commits

Follow `docs/agents/implementation-loop.md`. Keep commits coherent, write
repository artifacts and commit messages in English, and create every commit
with DCO sign-off:

```bash
git commit --signoff
```

Include `Refs: #<number>` in each commit message. Before publication, inspect
the complete branch diff and run the clean-checkout commands in
`CONTRIBUTING.md`. The public-boundary command scans the exact `HEAD` tree and
reachable history; its success remains subject to human exposure review.

Completion criterion: every branch commit belongs to the ticket, carries a
matching `Signed-off-by` trailer, and the exact branch head passes local gates.

## 3. Publish one pull request

Push and create the pull request only when the maintainer authorizes those
external actions:

```bash
git push --set-upstream origin issue-<number>-<slug>
gh pr create --base main --head issue-<number>-<slug>
```

Use the repository template. Link the work contract with `Closes #<number>`;
state the base and head revisions; disclose material agent or AI assistance;
and record validation, independent review, finding dispositions, and the public
boundary. Use a draft pull request while required evidence is incomplete.

Reconcile an uncertain push or pull-request creation by querying the remote
before retrying. A pull request is the durable publication and review surface,
not authorization to merge.

Completion criterion: exactly one pull request targets `main` from the issue
branch and its description accounts for every template section without private
or operational material.

## 4. Stabilize the reviewed head

The required GitHub check is `Verify`. It validates DCO sign-off for the
introduced commits and runs syntax checks, build, tests, and the automated
public-boundary scan on the candidate.

Have an independent reviewer evaluate the exact pull-request head under the
bounded implementation loop. If a fix changes the head, mark prior evidence as
superseded, let CI run on the new head, and obtain focused re-review. If `main`
advances and GitHub requires an update, rebase the issue branch, push it with
`--force-with-lease`, and treat every rewritten commit as a new candidate.
Force updates never target `main`.

With maintainer authorization, request a supplemental Copilot code review after
the candidate head is stable. Record either `Not requested - <reason>` or
`Completed`; a completed review names the exact head and dispositions every
finding. Copilot review does not replace `Verify`, the independent review, or
maintainer merge authority. A changed head supersedes its Copilot review
evidence; request a new review only when the maintainer authorizes that external
action and the evidence remains useful. Before handoff, record each finding's
disposition in the pull request and resolve its GitHub review thread.

Completion criterion: required CI and independent review both name the current
head, with every finding fixed or explicitly dispositioned. The supplemental
Copilot field either explains why it was not requested or names the current
head and dispositions its findings.

## 5. Hand off the merge decision

Persist the English, non-sensitive evidence summary on the pull request and
request the maintainer's final content and public-exposure review. The solo
maintainer ruleset requires a pull request but zero GitHub approvals; this
avoids inventing an unavailable second human while preserving independent
review evidence.

Only the maintainer decides whether to mark the pull request ready and rebase
merge it. Automated merge, deployment, release, and policy exceptions remain
outside this workflow. When authorized, bind the operation to the exact
reviewed head and reconcile it immediately before merging:

```bash
reviewed_head="<exact-reviewed-head>"
remote_head="$(gh pr view <number> \
  --repo victorchutw/openab-orchestration \
  --json headRefOid --jq .headRefOid)"
test "$remote_head" = "$reviewed_head"
gh pr merge <number> \
  --repo victorchutw/openab-orchestration \
  --rebase --delete-branch \
  --match-head-commit "$reviewed_head"
```

The comparison gives the maintainer an immediate observation; the
`--match-head-commit` precondition also closes a race after that observation.
Reconcile an uncertain merge before retrying. After a confirmed successful
merge and required CI, refresh the issue queue as required by the bounded
implementation loop.

Completion criterion: the maintainer receives the exact green reviewed head,
or a bounded handoff naming the unresolved gate; a confirmed merge leaves a
linear `main` history and closes the linked ticket.

## Repository enforcement

The active `Protect main` repository ruleset requires a pull request, the
`Verify` status check, and linear history, and it blocks deletion and force
updates of `main`. Repository settings allow rebase merge only and delete the
head branch after merge. The ruleset deliberately requires no approving GitHub
review while only one maintainer is available.
