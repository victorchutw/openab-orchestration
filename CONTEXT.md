# OpenAB Development Orchestration

This context names the people, work, agents, and evidence involved in one
local-first coding and review loop. The Operator remains the final authority
while deterministic state and replaceable agent runtimes stay separate.

## Language

**Operator**:
The human authority who starts a Run, supplies decisions, and accepts or rejects
its final result.
_Avoid_: User, administrator, automatic approver

**Run**:
One traceable pursuit of an Operator objective through coding, review,
optional bounded remediation, and an Operator Decision.
_Avoid_: Development Work Item, GitHub Issue, conversation

**Execution**:
One bounded invocation of an Agent Role within a Run.
_Avoid_: Work Claim, pod, session, message

**Runtime Core**:
The deterministic authority that records Run state and coordinates Executions
and external effects.
_Avoid_: Orchestrator Agent, GitHub gate, agent memory

**Agent Role Identity**:
A stable logical identity for one responsibility, independent of pod, provider,
model, credential, and session location.
_Avoid_: Discord bot name, deployment name, model name

**Orchestrator Agent**:
The PM role that shapes assignments, prepares context, coordinates Agent Roles,
and synthesizes reports without owning Run state or the final decision.
_Avoid_: Runtime Core, automatic approver

**Coding Agent**:
The role that produces and verifies a candidate change in an isolated target
workspace.
_Avoid_: Reviewer Agent, merge authority

**Reviewer Agent**:
A read-only role that independently evaluates one immutable Review Target and
produces one Review Report.
_Avoid_: Coding Agent, sibling reviewer, approver

**Execution Profile**:
A versioned binding of provider, model, runtime, configuration, and role used
for one Execution.
_Avoid_: Agent Role Identity, authority grant

**Execution Adapter**:
The replaceable connection through which the Runtime Core invokes an Agent Role
in a particular runtime such as OpenAB and ACP.
_Avoid_: Agent Role, Runtime Core

**Target Repository**:
The Git repository whose exact revisions and worktree are examined or changed
by a Run.
_Avoid_: runtime database, product repository

**Review Target**:
An immutable candidate change together with its exact base, head, objective,
review criteria, and verification evidence.
_Avoid_: moving branch, latest worktree, pull request conversation

**Review Report**:
The immutable, attributable findings produced independently by one Reviewer
Agent for one Review Target.
_Avoid_: Review Synthesis, approval

**Review Synthesis**:
The Orchestrator Agent's comparison of all required Review Reports, preserving
their provenance, disagreements, and unresolved findings.
_Avoid_: Review Report, final decision, automatic consensus

**Evidence Bundle**:
An immutable collection of outputs, verification results, bindings, and
digests that supports inspection of a Run without becoming its active state.
_Avoid_: runtime database, agent transcript

**Operator Decision**:
The human choice to accept, continue, revise, cancel, or abandon a Run after
review and synthesis.
_Avoid_: model recommendation, timeout, merge result
