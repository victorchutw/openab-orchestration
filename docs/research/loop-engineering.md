# Loop Engineering for Agentic Software Development

> [!NOTE]
> This is non-normative research for the greenfield OpenAB orchestration
> project. It does not change the repository's domain language, Wayfinder map,
> implementation authority, or accepted product design. Candidate applications
> require maintainer resolution before they become workflow or product rules.

Research checked on August 12, 2026.

## Scope and evidence labels

This report asks what **loop engineering** means in AI-assisted and agentic
software development, whether the phrase has an authoritative definition, what
established engineering mechanisms support it, and which parts are suitable for
this repository.

The report uses four labels deliberately:

- **Source finding** — a statement directly supported by the cited author,
  paper, official documentation, or source repository.
- **Search finding** — a bounded conclusion about the sources located; absence
  from the search is not proof of nonexistence.
- **Research synthesis** — an interpretation formed by comparing sources; it
  is not a definition owned by any source.
- **Repository candidate** — a possible application to OpenAB. It is neither a
  source claim nor an accepted repository decision.

## Executive summary

**Search finding — terminology status.** No standards-body or vendor
specification that owns the term was located. The earliest direct naming source
found in this research is Addy Osmani's personal essay of June 7, 2026. It
describes loop engineering as moving the human from repeated prompting to
designing the system that prompts, checks, and continues agent work. The essay
explicitly presents the practice as early, cites prior remarks by Peter
Steinberger and Boris Cherny, and carries a personal-views disclaimer; it
therefore does not establish coinage or an industry standard
([Osmani](https://addyosmani.com/blog/loop-engineering/)). IBM later published
an organizational definition centered on agentic workflows that act, observe,
adjust, and iterate toward a user-defined goal, but that is an editorial
definition rather than a normative specification
([IBM](https://www.ibm.com/think/topics/loop-engineering)).

Two recent preprints use the phrase differently but compatibly. Macedo proposes
a reusable external "loop specification" containing a trigger, goal,
verification, stopping rule, and memory. LoopsBench uses loop engineering for
sustained long-horizon execution over task structure, state continuity, and
regression obligations. Both are author-proposed research framings, not settled
terminology
([Macedo](https://arxiv.org/abs/2607.00038);
[LoopsBench](https://arxiv.org/abs/2608.00267)).

**Research synthesis — working definition.**

> Loop engineering is the deliberate design of a bounded, repeatable feedback
> control around one or more agent executions. The design defines what starts
> the work, which goal and authority boundary govern it, what observations count
> as evidence, how state survives executions, when another attempt is allowed,
> and which named condition ends or escalates the work.

This definition is narrower than "agentic workflow" and broader than the tool
loop inside a single coding-agent turn. A loop is engineered only when feedback
can affect the next action and when continuation and termination are governed;
an unbounded shell loop around a model command is repetition, not sufficient
control.

**Repository candidate — conclusion.** OpenAB should adopt the engineering
principles without adding **Loop** as a product term. The existing [domain
language](../../CONTEXT.md) is already more precise: a `Run` has one confirmed
`Run Plan`, bounded `Execution`s, validated `Execution Result`s, immutable review
evidence, at most one remediation round, and exactly one `Run Outcome`.
Loop-engineering ideas are useful as a design and audit checklist for that
model, not as a competing lifecycle vocabulary.

For this repository's own development process, the smallest useful adoption is
also procedural rather than autonomous: make each authorized implementation
ticket state its goal, evidence gates, retry/remediation allowance, escalation
conditions, and terminal handoff; run work in an isolated workspace; retain
test and review evidence outside agent conversation state; and keep final DCO,
public-exposure, push, merge, deployment, and policy decisions human-owned.

---

## 1. Provenance and terminology

### 1.1 Is there an official first-party definition?

The answer depends on what "official" means:

| Interpretation | Finding |
| --- | --- |
| A direct practitioner definition | **Yes.** [Osmani's June 7 essay](https://addyosmani.com/blog/loop-engineering/) supplies a first-person working definition and a component list. |
| A company-published definition | **Yes.** [IBM Think](https://www.ibm.com/think/topics/loop-engineering) published its own definition on July 17. |
| A normative industry specification | **No source was found.** No standard, stable conformance criteria, or canonical owner appeared in the focused search. |
| Proven coinage | **No.** Osmani cites earlier practitioner remarks, and earlier agent-loop techniques existed without this label. |

This is a bounded search result, not proof that an earlier use cannot exist.
Searches for the exact phrase in AI coding before June 2026 did not locate a
clear prior definition. The phrase also has unrelated uses in other engineering
domains, so exact-word searches are noisy.

The direct sources show a fast-moving sequence rather than a clean invention:

1. Geoffrey Huntley's July 2025 "Ralph" article describes a coding agent placed
   in a shell loop, working one item per fresh iteration against specifications,
   a plan file, tests, and compiler/static-analysis backpressure. It is a direct
   precursor but does not present a general discipline named loop engineering
   ([Huntley](https://ghuntley.com/ralph/)).
2. OpenAI's January 2026 explanation calls the model/tool interaction inside
   Codex the **agent loop**: the model requests a tool, receives its result in
   context, and repeats until it emits a final response
   ([OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/)).
3. Osmani's June 2026 essay puts a named management layer above a single agent
   harness: automation, isolated worktrees, reusable skills, connectors,
   subagents, and persistent state
   ([Osmani](https://addyosmani.com/blog/loop-engineering/)).
4. The Macedo and LoopsBench preprints then attempt to formalize or evaluate
   parts of the emerging practice
   ([Macedo](https://arxiv.org/abs/2607.00038);
   [LoopsBench](https://arxiv.org/abs/2608.00267)).

### 1.2 Three different things called a loop

**Research synthesis.** Separating three levels prevents the new label from
collapsing distinct responsibilities:

| Level | Repeated unit | Governing state | Typical stop |
| --- | --- | --- | --- |
| Inner agent loop | Model inference and tool use inside one agent execution | Conversation/execution context plus environment observations | Final agent message, tool limit, error, or interruption |
| Execution feedback loop | Attempt, verification, feedback, and another bounded attempt | Task/Run state and versioned evidence outside one conversation | Acceptance gate, attempt budget, blocker, or human escalation |
| Work-supply loop | Discover/select work, provision an environment, execute, record, and poll again | Durable tracker or orchestration state | No eligible work, schedule stop, cancellation, or operator action |

OpenAI's Codex article directly documents the first level. Anthropic describes
agents as models using tools and environmental feedback in a loop, and advises
environmental ground truth, human checkpoints, and maximum-iteration stopping
conditions
([OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/);
[Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).
Osmani and Symphony describe the latter two levels: persistent work selection,
isolated workspaces, retries, reconciliation, and handoff beyond one session
([Osmani](https://addyosmani.com/blog/loop-engineering/);
[Symphony overview](https://openai.com/index/open-source-codex-orchestration-symphony/);
[Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)).

The levels may be nested, but they must not share authority accidentally. An
agent deciding to issue another tool call is not equivalent to a Runtime Core
authorizing another `Execution`, and neither is equivalent to the Operator
accepting a `Review Target`.

### 1.3 Relationship to prompt, context, harness, and graph engineering

**Research synthesis.** These concerns are complementary:

- **Prompt engineering** shapes an individual model input.
- **Context engineering** selects and structures the information available to
  a model call or execution.
- **Harness engineering** supplies tools, permissions, filesystem, runtime,
  observations, and model-computer interfaces for an execution.
- **Loop engineering** governs feedback, continuation, state, and termination
  across one or more executions.
- **Graph engineering** makes dependencies, fan-out/fan-in, joins, and authority
  relationships among multiple loops explicit. See the companion [graph
  engineering research](./graph-engineering.md).

The Macedo preprint explicitly distinguishes its proposed external loop
specification from both a programming loop and the harness's internal
perceive-act-observe cycle. LoopsBench likewise says loop mechanisms add a
higher-level control surface rather than replace the harness
([Macedo](https://arxiv.org/abs/2607.00038);
[LoopsBench](https://arxiv.org/html/2608.00267v2)).

## 2. Source-backed engineering principles

### 2.1 Define the goal, evidence, and stopping rule before execution

**Source finding.** Anthropic recommends agents for open-ended tasks where the
step count cannot be hard-coded, but still calls for environmental feedback,
human checkpoints, and stopping conditions such as a maximum iteration count.
Its evaluator-optimizer pattern is recommended only when evaluation criteria are
clear and iterative refinement can produce measurable improvement
([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).
The Macedo preprint similarly puts the trigger, goal, verification step,
stopping rule, and memory in the loop specification rather than leaving them to
emerge during execution
([Macedo](https://arxiv.org/abs/2607.00038)).

**Research synthesis.** "Done" needs two parts: a predicate that evidence can
satisfy and a named authority allowed to accept that evidence. Attempt, time,
token, cost, and no-progress limits are safety exits, not evidence that the goal
was achieved.

### 2.2 Feed back observations from the environment, not confidence

**Source finding.** Codex repeats after appending tool results to the model
input. Anthropic says agents need ground truth from tool calls or code execution
to assess progress, and identifies coding as a strong fit because tests provide
objective feedback while human review still covers broader system requirements
([OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/);
[Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).

Research on intrinsic self-correction found no general reasoning improvement
when a model was asked to revise without external feedback; the study is about
reasoning tasks rather than software engineering, so it supports a limited
warning, not a universal claim about coding agents
([Huang et al.](https://openreview.net/forum?id=IkmD3fKBPQ)).

**Research synthesis.** Prefer executed tests, builds, schema validation,
static analysis, artifact digests, and immutable review inputs. Model critique
can direct another attempt, but should not alone convert an agent's completion
claim into authoritative lifecycle state.

### 2.3 Make progress incremental and preserve prior obligations

**Source finding.** Anthropic's long-running-agent experiments observed two
recurring failures: agents attempted too much within one context and later
sessions declared completion prematurely. Their harness improved continuity by
working on one feature at a time, keeping a progress file and Git history, and
requiring end-to-end testing before marking features complete
([Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).

LoopsBench retains tests for completed dependency nodes as regression
obligations while later work proceeds. In its initial 112-task evaluation, the
best reported model/loop configuration resolved 25% of tasks; all evaluated
profiles still showed regressions, and recorded plans recovered only part of
the source-recovered prerequisite structure. This is a recent preprint and its
benchmark abstraction is not proof about all real repositories
([LoopsBench abstract](https://arxiv.org/abs/2608.00267);
[full paper](https://arxiv.org/html/2608.00267v2)).

**Research synthesis.** Every accepted increment should remain an obligation
for later iterations. A loop that fixes the newest failure while silently
breaking an earlier accepted behavior is not converging.

### 2.4 Keep durable control state outside an agent session

**Source finding.** Anthropic's long-running harness uses external progress
artifacts and Git history because a new context window does not remember prior
sessions reliably. Osmani similarly calls for state outside a single
conversation. LangGraph distinguishes thread-scoped checkpoints from durable
cross-thread application data and documents persistence for resume, recovery,
and human-in-the-loop workflows
([Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents);
[Osmani](https://addyosmani.com/blog/loop-engineering/);
[LangGraph](https://docs.langchain.com/oss/python/langgraph/persistence)).

**Research synthesis.** Conversation history, compaction, and model memory may
accelerate work but must not own authoritative status, permissions, accepted
evidence, or terminal outcomes.

### 2.5 Isolate mutable work and bound concurrency

**Source finding.** Symphony continuously reads eligible issues, creates a
separate workspace per issue, bounds concurrency, stops runs that become
ineligible, and exposes retries and reconciliation through one orchestrator
state. Its specification also says a successful run may stop at a human-review
handoff rather than at `Done`
([Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)).
OpenAI's harness-engineering report likewise describes per-worktree application
instances with task-local logs and metrics
([OpenAI](https://openai.com/index/harness-engineering/)).

**Research synthesis.** Filesystem isolation prevents mechanical collisions;
it does not make two changes semantically independent. Parallel work still
needs disjoint mutation scope or an explicit integration owner and join.

### 2.6 Separate generation, verification, synthesis, and decision authority

**Source finding.** Anthropic presents an evaluator-optimizer loop in which one
model generates and another evaluates, and a parallelization pattern in which
separate calls examine different concerns. It also says programmatic tests and
human review are complementary for coding
([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).
Osmani recommends separate maker and checker roles, while warning that the
loop's `done` remains a claim and that humans remain responsible for shipped
code
([Osmani](https://addyosmani.com/blog/loop-engineering/)).

**Research synthesis.** A distinct model call is useful but is not automatically
independent evidence. Independence also depends on target immutability, context
separation, reviewer identity, criteria, provenance, and whether the checker can
observe evidence the maker cannot rewrite.

### 2.7 Make resume and retry safe for external effects

**Source finding.** LangGraph's functional API warns that a failed task may run
again on resume and recommends idempotency keys or checking for an existing
result before repeating API calls. Its interrupt documentation also warns that
code before an interrupt can execute again
([functional API](https://docs.langchain.com/oss/python/langgraph/functional-api);
[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)).
Symphony explicitly separates polling, issue eligibility, retries, and
reconciliation in its coordination layer
([Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)).

**Research synthesis.** "Retry the agent" is not a sufficient recovery policy.
Every externally visible mutation needs a stable logical identity, attempt
history, a way to establish whether it already occurred, and an escalation path
when its result is uncertain.

### 2.8 Add complexity only after a simpler loop is measured

**Source finding.** Anthropic recommends starting with the simplest adequate
solution and adding multi-step systems only when evaluation shows that simpler
ones fall short. Symphony's authors likewise report that ambiguous or
judgment-heavy work can remain better suited to interactive engineering, even
when routine implementation is orchestrated continuously
([Anthropic](https://www.anthropic.com/engineering/building-effective-agents);
[OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)).

**Research synthesis.** Scheduling, multiple agents, long-lived memory, and
automatic issue mutation are earned capabilities, not a loop-engineering
maturity score. Each should answer a measured failure of a smaller design.

## 3. A practical loop contract

**Research synthesis.** A reviewable loop can be described with the following
contract. This is a synthesis of the sources, not a standard schema:

| Field | Question it must answer |
| --- | --- |
| Trigger | What authoritative event makes the work eligible? |
| Goal | What outcome is pursued, for whom, and under which confirmed scope? |
| Inputs | Which immutable or versioned artifacts and state are assigned? |
| Authority | Which tools, mutations, resources, and decisions are allowed? |
| Action unit | What is one bounded agent execution or work attempt? |
| Observation | Which environment results are captured after an action? |
| Verifier | Which predicate and actor judge the evidence? |
| Progress state | What survives session loss, and which store owns it? |
| Continuation | On which evidence may another attempt or next item start? |
| Bounds | What limits attempts, elapsed time, tokens, cost, and no progress? |
| Recovery | How are crashes, stale inputs, uncertain effects, and cancellation reconciled? |
| Terminal states | Which distinct success, abandonment, cancellation, and escalation outcomes exist? |
| Handoff | Which human or downstream role receives the result and evidence? |
| Observability | Can an operator reconstruct actions, evidence, attempts, cost, and decisions? |

The minimum feedback cycle is:

```text
 confirmed goal and authority
             |
             v
      bounded execution
             |
             v
 environment observation + attributable evidence
             |
             v
 deterministic validation / independent review
       /             |                 \
  advance       bounded retry       stop or escalate
```

The loop is incomplete if the same agent can silently redefine its goal,
weaken its verifier, overwrite prior evidence, extend its own budget, or convert
its output into authoritative completion.

## 4. Candidate application to OpenAB

Everything in this section is a **repository candidate**.

### 4.1 Use the lens; do not add a competing product term

Do not add **Loop**, **Loop Specification**, or **Loop State** to
[`CONTEXT.md`](../../CONTEXT.md) merely because the practitioner vocabulary is
popular. The resolved OpenAB terms already divide authority more precisely:

| Loop-contract concern | Existing OpenAB language |
| --- | --- |
| Goal and scope | `Run Plan` |
| Durable lifecycle | `Run`, `Run Stage`, and `Run Condition` owned by `Runtime Core` |
| Bounded action unit | `Execution` under an `Execution Profile` |
| Assigned immutable input | `Execution Context` |
| Agent claim | `Execution Result` |
| Validated completion | `Execution Completion` |
| Mutable implementation | `Candidate Change` in an `Execution Workspace` |
| Frozen verification input | `Review Target` |
| Independent checks | two `Reviewer Agent` identities under `Review Decision Isolation` |
| Feedback and correction | `Review Synthesis` and one bounded `Remediating` stage |
| Scope escape | `Successor Run` |
| Human verdict | `Operator Decision` |
| End condition | exactly one `Run Outcome` |
| Replay-safe mutation | `Effect Intent`, `Effect Attempt`, `Effect Contract`, and `Reconciliation` |

This mapping suggests that OpenAB is already loop-engineered in substance. The
remaining value is to make the contract mechanically complete and testable, not
to rename the lifecycle.

### 4.2 Preserve a deterministic outer loop around adaptive executions

The Runtime Core should own eligibility, stage transitions, retry/remediation
bounds, evidence admission, cancellation convergence, and terminal outcomes.
An Agent Runtime may choose its own tool sequence inside an `Execution`, but
neither an assistant message nor an `Execution Result` envelope can establish
completion. Runtime Core validation establishes `Execution Completion`.

The useful containment is:

```text
 Operator-governed Run
 [Run Plan, authority, evidence gates, terminal outcome]
                         |
                         v
 deterministic Runtime Core feedback loop
 [dispatch, validate, review, remediate once, reconcile]
                         |
                         v
 adaptive Execution-local agent loop
 [inspect, reason, use tools, observe, verify, report]
```

This preserves local agent autonomy without transferring lifecycle authority to
the agent's context or stopping judgment.

### 4.3 Treat every repeated effect as a reconciliation problem

The strongest direct fit is the existing distinction between one logical
`Effect Intent` and multiple physical `Effect Attempt`s. A retrying loop must
not turn a timeout into permission for a duplicate pull request, message,
deployment, or provider action. The Runtime Core should admit another attempt
only through the applicable `Effect Contract`, correlation/fencing evidence,
and `Reconciliation` result.

Likewise, cancellation should remain convergence, not a process-kill signal.
The loop stops authoritatively only when continuing work and effects are proven
stopped or isolated according to the current domain model.

### 4.4 Candidate development loop for this repository

The repository is planning-first, the design destination is complete, and
implementation requires a maintainer-authorized handoff. When work is managed
through Wayfinder, GitHub planning uses the frontier and single-ticket session
rules in the [issue-tracker guide](../agents/issue-tracker.md). A conservative
implementation loop can sit inside those boundaries:

1. **Select authorized work.** For Wayfinder work, start only from a claimed
   eligible ticket and retain the linked issue as the durable planning record.
   For other implementation work, require an equivalently explicit maintainer
   handoff rather than assuming authorization from an agent-discovered task.
2. **Freeze the contract.** Before changing code, state the objective, scope,
   acceptance evidence, allowed remediation, stop/escalation rules, and
   Operator-only actions. Material changes return to planning rather than
   silently expanding the task.
3. **Execute one small increment.** Use an isolated worktree outside the public
   checkout and do not place sessions, logs, runtime state, or evidence bundles
   in the Product Repository.
4. **Observe mechanically.** Run the ticket-specific checks and the repository
   entry points: `npm run check`, `npm run build`, and `npm test` as required by
   the [contribution guide](../../CONTRIBUTING.md).
5. **Review the exact target.** Review a stable diff/commit and retain findings
   and verification provenance. Agent self-review is feedback, not the final
   verdict.
6. **Continue only on admissible failure evidence.** Fix within the agreed
   scope and bound; create successor planning work when remediation would cross
   that boundary.
7. **Stop at human gates.** A responsible natural person reviews AI-assisted
   content and owns DCO certification. Push, merge, deployment, exception, and
   final product decisions remain human actions.
8. **Apply the public boundary.** Before a public push that adds migrated or
   operational material, stage the exact tree, run `npm run check:public`, and
   complete the required human review of the staged tree and reachable history
   described in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

This loop should initially remain Operator-triggered. Recurring or unattended
discovery should be considered only after the manual form demonstrates that its
goal, verifier, state, and stop conditions produce better outcomes.

### 4.5 Do not add an unattended scheduler yet

An unattended scheduler is not an appropriate first application in the current
bootstrap:

- [`README.md`](../../README.md) states that Runtime Core and adapters are not
  implemented. The component that would own authoritative eligibility,
  attempts, reconciliation, cancellation convergence, and terminal state
  therefore does not yet exist.
- The candidate loop contract and its evidence gates have not been resolved or
  measured locally. LoopsBench's low task-resolution rate and observed
  regressions are reasons to validate a bounded local loop before adding
  recurrence, not evidence that more continuation is safe
  ([LoopsBench](https://arxiv.org/html/2608.00267v2)).
- A scheduler that writes issues, comments, branches, pull requests, messages,
  or other external state can duplicate or misapply effects after interruption.
  Replay-safe identity and reconciliation must precede unattended retry
  ([LangGraph](https://docs.langchain.com/oss/python/langgraph/functional-api);
  [Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)).
- The current [contribution guide](../../CONTRIBUTING.md) requires a responsible
  natural person to review AI-assisted contributions and make the DCO
  certification. Public-exposure review of the staged tree and reachable
  history is also explicitly human work.
- Automatic work discovery could bypass planning-frontier eligibility or turn
  a suggestion into unauthorized implementation. The present repository rules
  require a maintainer-authorized handoff.

The safe precursor is an Operator-triggered, bounded pilot. A read-only
discovery helper may propose candidate work, but it should not claim tickets,
start implementation, mutate GitHub, or publish artifacts until an explicit
Operator action authorizes the next bounded unit.

### 4.6 Keep memory in the right authority domain

Do not use automatic edits to `AGENTS.md`, `CONTEXT.md`, research notes, or code
comments as an agent's general-purpose learning memory:

- `AGENTS.md` is repository policy and wayfinding, not mutable run state.
- `CONTEXT.md` changes only after terminology is resolved with the maintainer.
- `docs/research/` remains non-normative input.
- Runtime state, agent sessions, worktrees, and Evidence Bundles stay outside
  the checkout.

For repository development, issue and pull-request records can retain public,
non-sensitive planning and review status. For the product, authoritative Run
state belongs to the private Runtime Core store; `Execution Context` carries the
immutable assignment, and role-private session continuity is disposable.

### 4.7 Evaluate a pilot as a Reference Run, not by output volume

Before adding scheduling or automated issue mutation, compare a small set of
fixed, testable tasks under the current workflow and the candidate loop. Reuse
the existing `Reference Run`, `System-Attributable Duration`, and `Operator
Waiting-on-System` concepts. Also record:

- accepted outcomes and escaped regressions;
- invalid or incomplete `Execution Result`s;
- verification and review findings per accepted target;
- retries, no-progress stops, reconciliations, and scope escalations;
- remediation success versus `Successor Run` creation;
- token/financial cost and Operator review effort; and
- public-boundary or authority-policy violations.

A loop is an improvement only if correctness, evidence quality, recoverability,
and Operator attention improve together. More agent turns, commits, issues, or
pull requests are activity measures, not Run Outcomes.

### 4.8 Decisions still requiring maintainer resolution

No decision is made by this report. Before changing the development process,
the maintainer would need to resolve at least:

1. whether a loop-contract checklist belongs in GitHub ticket templates,
   another planning artifact, or only implementation handoff criteria;
2. which failure classes permit an in-scope retry and which require a
   `Successor Run` or a new Wayfinder ticket;
3. which review evidence must be mechanical, agent-produced, and human-owned;
4. which pilot tasks and baseline measures constitute a fair `Reference Run`;
   and
5. whether any recurring discovery loop may write to GitHub, or must remain a
   read-only proposal surface until the Operator acts.

## 5. Limits and failure modes

### 5.1 A new label does not make the mechanisms new

**Source finding.** Tool-feedback agent loops, evaluator-optimizer workflows,
external progress state, isolated workspaces, and automated tests appear in the
cited sources before the June 2026 naming essay
([Huntley](https://ghuntley.com/ralph/);
[OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/);
[Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).

**Research synthesis.** The label is useful mainly because it moves attention
from a single prompt to the control system across time. It is not evidence that
a new framework or product layer is required.

### 5.2 Repetition amplifies both feedback and mistakes

**Research synthesis.**

An incorrect goal, mutable acceptance test, weak proxy, or overly broad tool
grant can be acted on repeatedly. More iterations cannot recover information or
judgment absent from the loop contract. The risk increases when the same model
both changes the artifact and decides that its changed verifier now passes.

### 5.3 A stop condition can be precise and still wrong

**Research synthesis.**

"All current tests pass" is mechanically clear but incomplete if tests do not
represent the confirmed requirements, security boundary, or user-visible
behavior. Anthropic's long-running experiments observed premature completion
without explicit end-to-end checks, and its general guidance retains human
review for broader requirements
([long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents);
[effective agents](https://www.anthropic.com/engineering/building-effective-agents)).

### 5.4 Long-horizon success is not established

**Source finding.**

The LoopsBench results are useful contrary evidence to claims that an outer
continuation loop makes long-horizon coding reliable: the strongest reported
configuration resolved one quarter of its tasks, and regressions remained
visible. The benchmark is new, its tasks are dependency-DAG abstractions, and
the paper is a preprint; local validation remains necessary
([LoopsBench](https://arxiv.org/html/2608.00267v2)).

### 5.5 Durable state creates retention and authority risks

**Research synthesis.**

Progress files and checkpoints improve continuity but can also preserve stale
assumptions, untrusted input, sensitive data, and obsolete authority. LangGraph
documents that checkpoints can grow without bound and require retention policy
([LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)).
OpenAB additionally requires private runtime state and evidence to stay outside
the public checkout.

### 5.6 Human attention remains a real capacity limit

**Source finding and research synthesis.**

Automation can remove repeated prompting while increasing the amount of output
that needs verification. Osmani explicitly warns about verification,
comprehension debt, and loss of human judgment; OpenAI reports that ambiguous
and expertise-heavy tasks remain better candidates for direct interactive work
([Osmani](https://addyosmani.com/blog/loop-engineering/);
[OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)).

## Sources

### Direct terminology and precursor sources

- Addy Osmani, [*Loop Engineering*](https://addyosmani.com/blog/loop-engineering/),
  June 7, 2026. Personal practitioner essay; direct naming and component
  framing, not a standard.
- IBM, [*What Is Loop
  Engineering?*](https://www.ibm.com/think/topics/loop-engineering), July 17,
  2026. Company editorial definition, not a specification.
- Geoffrey Huntley, [*Ralph Wiggum as a "software
  engineer"*](https://ghuntley.com/ralph/), July 14, 2025. First-person
  precursor technique; includes broad autonomy claims and should not be adopted
  as a safety recipe.

### First-party engineering documentation

- OpenAI, [*Unrolling the Codex Agent
  Loop*](https://openai.com/index/unrolling-the-codex-agent-loop/).
- OpenAI, [*An Open-Source Spec for Codex Orchestration:
  Symphony*](https://openai.com/index/open-source-codex-orchestration-symphony/)
  and the [Symphony
  specification](https://github.com/openai/symphony/blob/main/SPEC.md).
- OpenAI, [*Harness Engineering: Leveraging Codex in an Agent-First
  World*](https://openai.com/index/harness-engineering/).
- Anthropic, [*Building Effective
  Agents*](https://www.anthropic.com/engineering/building-effective-agents).
- Anthropic, [*Effective Harnesses for Long-Running
  Agents*](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
- LangChain, [LangGraph
  persistence](https://docs.langchain.com/oss/python/langgraph/persistence),
  [functional API](https://docs.langchain.com/oss/python/langgraph/functional-api),
  and [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

### Primary research

- Sandeco Macedo, [*Stop Hand-Holding Your Coding Agent: Engineering the
  Loops that Replace Step-by-Step
  Prompting*](https://arxiv.org/abs/2607.00038), 2026. Single-author preprint
  proposing a definition and taxonomy.
- Han Li et al., [*LoopsBench: From Harness Engineering to Loop Engineering in
  Coding Agent Evaluation*](https://arxiv.org/abs/2608.00267), version 2,
  August 10, 2026. Recent preprint with an open-source benchmark; peer-review
  status was not established by this research.
- Jie Huang et al., [*Large Language Models Cannot Self-Correct Reasoning
  Yet*](https://openreview.net/forum?id=IkmD3fKBPQ), ICLR 2024. Peer-reviewed
  evidence about intrinsic self-correction on reasoning tasks, not a general
  coding-agent result.

## Source limitations

- The phrase emerged only recently, and sources continue to change quickly.
- X pages linked by the naming essay were not consistently readable through the
  research environment, so the report attributes those remarks through
  Osmani's direct essay and does not use them to prove coinage.
- Company engineering posts report experience from their own tools and
  environments; their operational results do not transfer automatically to
  OpenAB.
- The two 2026 loop-engineering papers are recent preprints. LoopsBench is the
  stronger empirical source, but one benchmark cannot establish a general
  development method.
- The absence of a normative definition is a focused-search finding, not proof
  that no private, unpublished, or poorly indexed definition exists.
