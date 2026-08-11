# OpenAB Development Orchestration

This context names the people, work, agents, and evidence involved in a
single-Operator, local-first coding and review loop. The Operator remains the
final authority while deterministic state and replaceable agent runtimes stay
separate.

## Language

**Operator**:
The human authority who directs a Run, supplies decisions, and alone makes its
Operator Decision.
_Avoid_: User, administrator, automatic approver

**Operator Action**:
An intervention the Operator is authorized to make while a Run is active or
waiting, including control inputs that are not the final Operator Decision.
_Avoid_: chat message, automatic transition, Operator Decision

**Run**:
One traceable pursuit of an Operator objective under one confirmed Run Plan,
from creation to exactly one Run Outcome. A Run may end before coding or review.
_Avoid_: Development Work Item, GitHub Issue, conversation

**Run Plan**:
The Operator-confirmed objective, scope, acceptance boundary, and remediation
allowance governing one Run. Material changes after confirmation require a
Successor Run.
_Avoid_: Review Contract, Execution Assignment, prompt

**Successor Run**:
A new Run created when continued work would cross the confirmed Run Plan or the
current Run's remediation allowance. It remains related to its predecessor
without extending or reopening it.
_Avoid_: reopened Run, extra remediation round

**Run Outcome**:
The single terminal result of a Run: Accepted, Abandoned, or Cancelled. A
cancellation request is not an outcome until ongoing work and effects are
confirmed stopped or isolated.
_Avoid_: Agent result, timeout, cancellation request

**Cancellation**:
The convergence process initiated by an Operator cancellation request. It ends
only when ongoing work and effects are confirmed stopped or isolated.
_Avoid_: process termination, Abandonment, timeout

**Abandonment**:
The Operator's choice to stop pursuing a Run. If work or effects may remain
active, Cancellation converges before the Run Outcome becomes Abandoned.
_Avoid_: rejection, Cancellation, technical failure

**Run Stage**:
The current product phase of a Run: Planning, Coding, Reviewing, Synthesizing,
Remediating, or Final Decision.
_Avoid_: Run Condition, workflow job, Agent status

**Run Condition**:
The cross-stage operating condition of a Run: Active, Waiting for Operator,
Cancelling, or Terminal.
_Avoid_: Run Stage, Run Outcome, health status

**Review Round**:
One review cycle in which both required Reviewer Agent identities evaluate the
same Review Target before Review Synthesis. A round is Initial or Remediated.
_Avoid_: remediation round, Reviewer retry, Execution

**Agent Role**:
A product responsibility performed by an agent within a Run. The MVP roles are
Orchestrator Agent, Coding Agent, and Reviewer Agent.
_Avoid_: Agent Role Identity, Execution Profile, pod

**Execution**:
One bounded invocation of an Agent Role Identity under one Execution Profile
within a Run.
_Avoid_: Work Claim, pod, session, message

**Execution Completion**:
The Runtime Core's validated determination that an Execution produced its
required result and evidence. A transport response, session boundary, or health
observation alone is not completion.
_Avoid_: ACP turn completion, process exit, health check

**Runtime Core**:
The sole deterministic authority that records Run lifecycle and Execution
Completion while coordinating Executions and external effects.
_Avoid_: Orchestrator Agent, GitHub gate, agent memory

**Agent Role Identity**:
An Installation-stable logical seat assigned to an Agent Role, independent of
pod, Serving Provider, model, credential, session, and Execution Profile. The
MVP has one Orchestrator Agent identity, one Coding Agent identity, and two
Reviewer Agent identities across Runs.
_Avoid_: Run identity, Execution identity, deployment name, model name

**Agent Runtime**:
The replaceable, identity-private process or container environment that hosts
Executions for one Agent Role Identity. It may retain disposable role-private
cache but does not own Agent Role Identity or Run state.
_Avoid_: Runtime Core, Agent Role Identity, ACP session

**Orchestrator Agent**:
The PM role that shapes the Run Plan, prepares context, and synthesizes reports.
It proposes work through the Runtime Core without directly dispatching other
Agents, modifying the Target Repository, owning Run state, or making the final
decision.
_Avoid_: Runtime Core, dispatcher, automatic approver

**Coding Agent**:
The role that produces and verifies a Candidate Change in its isolated writable
Execution Workspace without owning Run state or merge authority.
_Avoid_: Reviewer Agent, merge authority

**Reviewer Agent**:
A read-only role that independently evaluates one immutable Review Target and
produces one Review Report without directing another Agent or owning Run state.
_Avoid_: Coding Agent, sibling reviewer, approver

**Review Decision Isolation**:
The information boundary that keeps each required Reviewer Agent from receiving
current or prior sibling Review Reports, Review Synthesis, or their derivatives
during its Execution. That Execution ends when its valid Report is accepted.
_Avoid_: shared session, automatic consensus, security boundary against Operator

**Serving Provider**:
The external inference backend that serves model work for an Execution.
Reviewer diversity compares Serving Providers, not models, accounts,
credentials, or Agent Runtimes.
_Avoid_: model, provider account, credential, Agent Runtime

**Execution Profile**:
A versioned binding of Serving Provider, model, Agent Runtime, and configuration
selected immutably when one Execution is created.
_Avoid_: Agent Role Identity, authority grant

**Execution Context**:
The complete, immutable, authorization-filtered input manifest assigned by the
Runtime Core to one Execution. Session continuity may accelerate an Execution
but cannot replace its Execution Context.
_Avoid_: prompt, transcript, session memory, mutable workspace

**Execution Adapter**:
The replaceable connection through which the Runtime Core invokes an Agent Role
Identity in an Agent Runtime over a protocol or interface such as ACP.
_Avoid_: Agent Role, Runtime Core, protocol

**Execution Workspace**:
The isolated filesystem view of a Target Repository created for one Execution
when repository access is required. Coding Executions may write; each Reviewer
Execution receives a separate read-only view of the same Review Target.
_Avoid_: Target Repository, shared checkout, OpenAB session

**Product Repository**:
The public source repository for the portable OpenAB orchestration product and
its non-sensitive specifications, examples, and contribution materials. It is
not an installation, a store for private bindings, or a source of runtime state.
_Avoid_: Target Repository, deployment repository, runtime store

**Installation**:
One Operator-controlled deployment of the product with its own private
configuration, bindings, secrets, and runtime records.
_Avoid_: Product Repository, Agent Runtime, Target Repository

**Configuration Contract**:
The public, versioned definition of accepted installation settings, their
constraints, safe defaults, and placeholder shapes without instance values.
_Avoid_: Installation Configuration, deployment binding, secret

**Installation Configuration**:
The private, instance-specific settings and deployment bindings for one
Installation that satisfy a Configuration Contract but exclude secret payloads.
_Avoid_: Configuration Contract, Secret Material, runtime state

**Secret Material**:
Private credential payloads used by an Installation and referred to without
being embedded in configuration, evidence, or the Product Repository.
_Avoid_: Installation Configuration, secret reference, Agent Role Identity

**Target Repository**:
The Git repository whose exact revisions and worktree are examined or changed
by a Run.
_Avoid_: runtime database, Product Repository

**Candidate Change**:
The mutable source change produced by Coding or Remediation before it is sealed
for review.
_Avoid_: Review Target, moving branch, accepted change

**Review Target**:
An immutable envelope that binds a Candidate Change's exact base and head to the
confirmed Run Plan, review criteria, and frozen input-evidence manifest.
_Avoid_: moving branch, latest worktree, pull request conversation

**Review Report**:
The immutable findings produced independently by one Reviewer Agent, attributable
to its Agent Role Identity and Execution Profile, for one Review Target.
_Avoid_: Review Synthesis, approval

**Review Synthesis**:
The immutable Orchestrator Agent comparison of all required Review Reports,
preserving their provenance, disagreements, and unresolved findings without
rewriting them.
_Avoid_: Review Report, final decision, automatic consensus

**Verification Evidence**:
Immutable observations and results that support validation of an Execution or
Review Target. Evidence created after a Review Target is sealed does not mutate
that target.
_Avoid_: mutable log, Agent assertion, active Run state

**Evidence Bundle**:
The private, immutable collection of outputs, verification results, bindings,
and digests that supports offline inspection of one terminal Run without
becoming its active state or containing Secret Material.
_Avoid_: runtime database, agent transcript, public example

**Operator Decision**:
The Operator's final judgment to Accept or Abandon the last eligible Review
Target after review and Review Synthesis.
_Avoid_: Operator Action, model recommendation, timeout, merge result

**Reference Run**:
A controlled evaluation Run performed under fixed inputs and conditions so
timing, reliability, and operational-effort measures remain comparable.
_Avoid_: production Run, arbitrary benchmark task

**System-Attributable Duration**:
The elapsed duration of a Run excluding intervals in `Waiting for Operator`.
Queueing, Agent Runtime and provider work, validation, and recovery remain
included.
_Avoid_: wall-clock Run duration, Operator response time

**Operator Waiting-on-System**:
The interval after an Operator Action is accepted until the Runtime Core exposes
the next required Operator Action or commits the Run Outcome.
_Avoid_: Waiting for Operator, Operator decision time
