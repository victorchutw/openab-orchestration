# Graph Engineering for Agentic Software Development

> [!IMPORTANT]
> This historical report was migrated as non-normative research. References to
> `openab-vault`, its glossary, or its accepted ADRs describe the legacy system
> and do not constrain this greenfield repository. See
> [legacy provenance](../legacy/provenance.md).

Research notes on the emerging idea of engineering agentic development as a graph of
work, execution, evidence, and improvement.

## Scope and evidence status

This report uses **graph engineering** in the context of AI-assisted software development,
not in the older and broader senses of designing knowledge graphs, graph databases, or
graph algorithms. It asks:

- what the new label appears to mean;
- which established mechanisms sit behind it;
- how it relates to inner- and outer-loop engineering;
- where graph-shaped development helps or fails; and
- what the idea implies for `openab-vault`.

The term is too new to have a standards body, canonical paper, stable vocabulary, or
accepted benchmark. As of July 27, 2026, the available evidence supports treating it as
**emerging practitioner vocabulary**, not as a mature engineering discipline. That is a
search finding, not proof that no earlier use exists.

This report distinguishes three kinds of statements:

- **Source finding** — a claim made or directly supported by a cited primary or first-party
  source.
- **Research synthesis** — a working definition or model inferred by comparing sources.
- **Repository recommendation** — a proposed application to this repository; it is not a
  claim that the sources prescribe that design.

## Executive summary

The July 2026 phrase appears to have gone viral through a short exchange: Peter
Steinberger asked whether the conversation had moved from loops to graphs, and Hamel
Husain published an X article titled *Loop Engineering Is Dead. Enter Graph
Engineering.* Neither source provides a normative specification. Carlos E. Perez then
offered one substantive interpretation: a **graph of improvement loops** in which loops
measure, constrain, audit, and correct one another. The edges — who supplies evidence,
who watches whom, and who can veto or escalate — matter more than merely drawing boxes
([Steinberger](https://x.com/steipete/status/2078277297791189132);
[Husain](https://x.com/HamelHusain/article/2078346425621237935);
[Perez](https://medium.com/intuitionmachine/from-loop-engineering-to-graph-engineering-d3ebeb08511c)).
These posts are best treated as a viral catalyst, not evidence of coinage or consensus.

The underlying engineering is much less novel than the label. Anthropic documents
prompt chains, routing, parallelization, orchestrator-worker systems, and
evaluator-optimizer loops as composable workflow patterns. LangGraph, Google ADK, and
Microsoft AutoGen expose explicit nodes, edges, shared state, conditional routing,
fan-out/fan-in, cycles, persistence, and human checkpoints. OpenAI's Symphony applies
similar ideas to software delivery: a tracker is the control plane, work is dispatched
into isolated workspaces, dependencies release tasks, and attempts are reconciled and
retried
([Anthropic](https://www.anthropic.com/engineering/building-effective-agents);
[LangGraph](https://docs.langchain.com/oss/python/langgraph/graph-api);
[Google ADK](https://adk.dev/graphs/);
[AutoGen](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html);
[OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)).

**Research synthesis — working definition:**

> Graph engineering is the deliberate design and operation of AI-assisted software
> delivery as an explicit, durable, and governed graph of bounded work units. Nodes may
> be agents, deterministic programs or tools, or human decisions. Edges carry control,
> dependencies, artifacts, evidence, and authority. The graph makes concurrency, joins,
> retries, escalation, and termination observable and enforceable.

This is not a claim that every agent action should become a node. The practical design is
a **stable macro-graph containing adaptive micro-loops**. An agent can dynamically
gather, reason, act, observe, and verify inside a bounded Work Attempt; the graph governs
how independently produced artifacts and decisions become eligible inputs to later
stages. Inner-loop engineering makes one attempt effective. Outer-loop engineering
keeps work supplied, isolated, bounded, and verified over time. Graph engineering makes
the relationships among several loops explicit.

`openab-vault` already embodies most of this design. Its accepted ADRs define an explicit
Work Dependency DAG, staged research/implementation/integration/review work, isolated
parallel reviewers, immutable review targets, evidence-based transitions, and bounded
remediation. The useful next step is therefore not to adopt a graph framework for its own
sake. It is to make edge contracts, joins, evidence anchors, retry bounds, and graph
observability precise in the existing GitHub-backed control model.

---

## 1. Provenance and terminology

### 1.1 The July 2026 naming event

The direct contemporary sources establish a sequence, but not a canonical definition:

1. On July 18, 2026, Peter Steinberger asked whether the discussion had shifted from
   loops to graphs
   ([primary post](https://x.com/steipete/status/2078277297791189132)).
2. The same day, Hamel Husain published *Loop Engineering Is Dead. Enter Graph
   Engineering*
   ([primary article page](https://x.com/HamelHusain/article/2078346425621237935)).
3. On July 19, Carlos E. Perez published a longer interpretation, *From Loop Engineering
   to Graph Engineering*. He argues that isolated optimization loops can game metrics,
   pursue conflicting targets, and validate one another's mistakes. His proposed graph
   connects optimization, counter-metric, audit, arbitration, and hierarchy loops, while
   anchoring them to observations the optimizers cannot rewrite
   ([author's essay](https://medium.com/intuitionmachine/from-loop-engineering-to-graph-engineering-d3ebeb08511c)).

The first two sources are evidence that the label circulated; they are not a method
specification. Perez supplies one coherent meaning, but it remains an individual author's
model. It would be premature to present any of the three as the inventor or official
definition of graph engineering.

### 1.2 Terminology collision

“Graphs” already appear in agent engineering in several distinct ways. Conflating them
would make the new label less useful:

| Graph | Nodes and edges represent | Primary engineering question |
| --- | --- | --- |
| **Work/dependency graph** | Issues, stages, artifacts, prerequisites | What may start, and when? |
| **Execution/control graph** | Agent/tool/code steps and routes | What runs next, with what state? |
| **Assurance/improvement graph** | Metrics, evaluators, audits, vetoes | Who detects or corrects failure? |
| **Knowledge/context graph** | Entities, facts, memories, relations | What information is retrievable? |

The first three are the relevant meanings for software-delivery orchestration. Knowledge
graphs can support an agent's context, but they are a separate design dimension. A survey
of “graphs meeting AI agents” uses graphs for planning, memory, tools, and multi-agent
coordination, illustrating this wider terminology rather than defining the 2026
practitioner label
([Graphs Meet AI Agents](https://arxiv.org/abs/2506.18019)).

### 1.3 Earlier technical foundation

The mechanisms predate the phrase. A particularly close pre-label proposal is Hu Wei's
April 2026 *From Agent Loops to Structured Graphs: A Scheduler-Theoretic Framework for
LLM Agent Execution*. Its Structured Graph Harness proposes an immutable plan version,
an explicit static DAG, output contracts, separated planning/execution/recovery, and
bounded escalation. The paper is a design proposal, not an empirical demonstration, and
explicitly acknowledges that static DAGs fit poorly when goals or viable actions must
change during execution
([paper](https://arxiv.org/abs/2604.11378)).

This supports a conservative interpretation: **graph engineering names a synthesis of
existing workflow, durable-execution, dependency-management, and assurance techniques**.
The name may be new; the constituent ideas are not.

## 2. The graph-of-bounded-loops model

### 2.1 Three layers

The most useful relationship among the three engineering modes is containment:

```text
 Graph engineering
 [dependencies, fan-out/fan-in, evidence, authority, synthesis]
                              |
                              v
 Outer loop for each Work Item
 [select task, provision workspace, run attempt, verify, retry/escalate]
                              |
                              v
 Inner loop inside an agent attempt
 [gather -> reason -> act -> observe -> verify -> repeat/stop]
```

- **Inner-loop engineering** controls one agent's context, tools, observations,
  verification, permissions, budgets, and stopping condition.
- **Outer-loop engineering** repeatedly supplies work and a clean environment, preserves
  state across sessions, monitors progress, and decides whether to retry, escalate, or
  accept.
- **Graph engineering** coordinates several such loops through explicit dependency,
  artifact, evidence, and authority relationships.

Graph engineering therefore does not make loops obsolete. A graph without bounded node
loops is a rigid workflow; loops without a graph become implicit coordination through
prompts, chats, and mutable shared context.

### 2.2 Reference development graph

```text
 Operator goal + acceptance criteria
                 |
                 v
       Definition Revision
  [work DAG + evidence contracts]
                 |
                 v
          Optional research
                 |
          +------+------+
          |             |
          v             v
   Implementation A  Implementation B
   [bounded loop]    [bounded loop]
          |             |
          +------+------+
                 |
          join / integrate?
                 |
                 v
       Immutable Review Target
                 |
          +------+------+
          |             |
          v             v
       Review A      Review B
   [independent]   [independent]
          |             |
          +------+------+
                 |
                 v
     Synthesis + Transition Gate
          /                 \
      accepted         changes required
          |                    |
          v                    v
      complete       new bounded remediation
                           + new target/revision

 A failed gate creates new work or a new Definition Revision.
 It does not add a backward edge that would cycle the dependency DAG.
```

This drawing separates a DAG of authoritative eligibility from iterative behavior.
Feedback exists, but it is represented as a new versioned work unit. This retains a
complete history and prevents a required cycle from leaving every node permanently
blocked.

## 3. Core mechanisms

### 3.1 Node contracts

A useful node is a bounded unit with:

- a named owner or eligible role;
- immutable or versioned inputs;
- allowed tools and mutation scope;
- a state schema;
- an expected output artifact;
- an evidence contract and acceptance predicate;
- a time, turn, token, cost, or retry budget; and
- explicit failure and escalation outcomes.

Nodes need not all be agents. Google ADK explicitly allows agent, tool, and ordinary-code
nodes; Anthropic recommends deterministic code wherever the path is known and agents only
where model judgment adds value
([Google ADK](https://adk.dev/graphs/);
[Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).
Human input is another node class when the system needs clarification, permission, or a
judgment that should not be delegated
([Google ADK human input](https://adk.dev/graphs/human-input/)).

### 3.2 Typed edges

An arrow should mean more than “then.” At minimum, an edge should declare:

- **dependency** — which prerequisite must be satisfied;
- **release condition** — which authoritative state or evidence unlocks the dependent;
- **artifact mapping** — exactly which versioned output becomes which downstream input;
- **routing predicate** — the condition selecting a branch;
- **join policy** — all, quorum, first-success, or explicit cancellation;
- **authority transfer** — who may request, approve, veto, or mutate;
- **failure route** — retry, compensate, replan, or escalate.

The Perez interpretation adds an assurance question to every important edge: can the
consumer independently detect that its input is wrong, or are producer and checker
optimizing the same proxy? A graph of mutually approving agents can be confidently wrong.
Executed tests, CI results, production behavior, customer outcomes, and retained human
judgment are stronger anchors because the optimizing agent cannot simply rewrite them.

### 3.3 Durable state and replay-safe effects

Graph execution crosses process failures and human wait time. LangGraph checkpoints state
at each step so a thread can pause, resume, inspect prior states, and recover. Its
durable-execution guidance requires non-deterministic or side-effecting operations to be
isolated and made idempotent, for example with idempotency keys or a check for an already
completed external action
([persistence](https://docs.langchain.com/oss/python/langgraph/persistence);
[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts);
[durable execution](https://docs.langchain.com/oss/python/langgraph/functional-api)).

This distinction matters in development orchestration. Replaying a repository read is
usually safe; replaying “open pull request,” “merge,” “deploy,” or “send message” may
duplicate irreversible effects. Checkpoints are insufficient unless each mutation has a
stable identity and reconciliation rule.

### 3.4 Scheduler, gates, fan-out, and joins

Edges only become operational when a scheduler evaluates them against authoritative
state. GitHub natively exposes blocking/blocked-by issue dependencies, while GitHub
Actions runs jobs without dependencies in parallel and uses `needs` for joins
([issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies);
[Actions](https://docs.github.com/en/actions/get-started/understand-github-actions)).
Concurrency controls are also necessary when distinct paths could mutate the same
resource
([GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)).

A safe fan-out/fan-in pattern has five properties:

1. branches are materially independent;
2. each branch gets isolated mutable state;
3. each output has stable provenance;
4. the join waits for a declared completion policy; and
5. synthesis resolves disagreement rather than silently taking the last write.

### 3.5 Observability and graph versioning

Useful traces preserve both the topology and the execution:

- graph/Definition Revision ID;
- node and edge IDs;
- immutable input and output references;
- claim, workspace, and actor identity;
- state transitions and gate decisions;
- attempt, retry, checkpoint, and escalation history;
- evaluator reports and external evidence;
- token, time, and financial cost.

Without topology versioning, a successful or failed run cannot be reconstructed after the
plan changes. Without per-node traces, the graph becomes a decorative diagram over an
opaque set of agent conversations.

## 4. Practical patterns

### 4.1 Tracker as control plane

OpenAI Symphony treats the project tracker as the authoritative queue and lifecycle state,
creates an isolated workspace and agent session for each eligible issue, reconciles
stalls or crashes, and allows plans to generate dependency-ordered task trees. Its
specification also separates durable issue state from ephemeral run-attempt state
([overview](https://openai.com/index/open-source-codex-orchestration-symphony/);
[specification](https://github.com/openai/symphony/blob/main/SPEC.md)).

This is a graph pattern even when no graph library is present. The issue tracker holds the
work graph; the orchestrator is the scheduler; workspaces isolate branches; CI and review
provide evidence; statuses and dependencies determine release.

OpenAI's harness-engineering report adds a repository-level complement: keep agent-facing
knowledge in versioned repository documentation and mechanically enforce architectural
dependency directions and allowed edges. This makes repository structure part of the
execution harness rather than background convention
([OpenAI harness engineering](https://openai.com/index/harness-engineering/)).

### 4.2 Deterministic skeleton, adaptive interior

The most credible sources converge on a hybrid rather than a fully scripted or fully
emergent system:

- use a deterministic graph for known stage boundaries, permissions, dependencies,
  joins, and acceptance gates;
- let an agent choose tactics inside a bounded node where the action sequence cannot be
  known in advance; and
- convert material replanning into a new version rather than silently mutating the graph.

Google warns that static graphs become unwieldy for complex iterative branching and
supports ordinary code for dynamic workflows
([dynamic workflows](https://adk.dev/graphs/dynamic/)).
OpenAI reports a similar lesson from Symphony: treating agents as rigid state-machine
nodes was too limiting, so the system gives them broad objectives and tools inside a
coarse status structure
([OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)).

### 4.3 Parallel independent work plus a barrier

Parallelism helps when work can be partitioned without frequent shared-state negotiation.
Anthropic's multi-agent research system uses an orchestrator-worker fan-out and reports
benefits on breadth-first research, but also notes substantially higher token usage,
stragglers at synchronous joins, and additional state-consistency and error-propagation
problems in asynchronous designs
([Anthropic multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)).

Anthropic's multi-agent C compiler experiment shows the coding analogue. Independent test
failures were easy to distribute; one large serial kernel failure caused agents to
duplicate and overwrite work until the oracle was decomposed. The experiment also
encountered frequent merge conflicts and depended on unusually strong executable tests
([Anthropic C compiler experiment](https://www.anthropic.com/engineering/building-c-compiler)).

The graph should expose true serial bottlenecks rather than manufacture branches to keep
agents busy.

### 4.4 Independent maker, checker, and synthesizer

An implementation node should not be its own final evaluator. Parallel reviews should:

- inspect the same immutable target;
- run in independent sessions;
- use distinct claims and workspaces;
- produce attributable reports; and
- meet at a synthesis barrier that preserves disagreement and provenance.

Mechanical checks and agent reviewers are complementary. Anthropic notes that executable
tests give coding agents objective feedback, while human review remains important for
requirements that tests do not capture
([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).

### 4.5 External anchors and counter-metrics

Every optimizer needs evidence it cannot redefine. A delivery graph should pair speed
with quality and cost:

- lead time **and** rework/revert rate;
- completed Work Items **and** evidence-contract failures;
- review throughput **and** escaped defects;
- agent success rate **and** human escalation rate;
- parallelism **and** integration/coordination cost;
- output volume **and** token/financial cost.

No single metric should decide whether the system is “better.” Root priorities and
trade-offs remain an Operator responsibility.

## 5. Limits and failure modes

### 5.1 The label is underspecified

Different authors may mean a workflow DAG, a cyclic state machine, a work-breakdown
graph, an evaluator network, or a knowledge graph. A design should name the graph type and
edge semantics instead of relying on “graph engineering” as if it were precise.

### 5.2 Graph overhead can exceed task complexity

Anthropic recommends starting with the simplest adequate pattern because agentic
orchestration adds latency, cost, and failure modes. AutoGen likewise recommends GraphFlow
when strict ordering, branching, parallelism, or loops are actually needed, and marks the
feature experimental
([Anthropic](https://www.anthropic.com/engineering/building-effective-agents);
[AutoGen](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html)).
A small, reversible task may need one agent plus tests, not a multi-stage graph.

### 5.3 More agents can mean only more compute

Multi-agent results must control for token and inference budgets. A 2026 controlled
multi-hop reasoning study found that single-agent systems matched or outperformed
multi-agent variants under equal reasoning-token budgets, suggesting some reported gains
are compute or context effects rather than topology effects. This is a preprint about
reasoning, not a general result about coding, but it is a useful measurement warning
([study](https://arxiv.org/abs/2604.02460)).

### 5.4 Bad decomposition becomes graph-shaped waste

A planner can omit real dependencies, invent unnecessary ones, over-decompose work, or
choose a join that discards useful minority findings. The Structured Graph Harness paper
explicitly makes performance depend on whether the planner identifies real parallelism.
No scheduler can recover information that the graph failed to model.

### 5.5 Static topology conflicts with discovery

Exploratory research, debugging, architecture discovery, and ambiguous product decisions
often reveal the next useful action only after evidence arrives. Forcing them into an
immutable detailed DAG creates false certainty. The stable part should be the governance
boundary and revision protocol, not a prediction of every tool call.

### 5.6 Durable execution is operationally hard

Checkpoints introduce schema evolution, stale-resume, duplicate-effect, cancellation,
and cleanup problems. Parallel paths add lost-update and inconsistent-read risks.
Human-interrupt nodes may wait indefinitely. Every external mutation needs a replay and
reconciliation policy.

### 5.7 Feedback edges can amplify error

Cycles are not automatically learning. An evaluator-optimizer loop can oscillate, reward
hack, or run without limit. A July 2026 empirical preprint on public agent repositories
found unbounded feedback paths that could amplify cost, context growth, and side effects;
the result is recent and should be treated as preliminary, but the failure mechanism is
credible
([When Agents Do Not Stop](https://arxiv.org/abs/2607.01641)).

### 5.8 Graphs expand security and authority surfaces

Each tool-capable node and each artifact edge can carry untrusted input toward a mutation
capability. A recent typed “Agent Dependency Graph” study models control, data, and
component edges specifically to find prompt-to-tool taint paths. It is also a fresh
preprint, but it usefully shows that topology is part of the threat model
([AgentFlow](https://arxiv.org/abs/2607.01640)).

### 5.9 There is no graph-engineering benchmark

Framework benchmarks generally measure task success or framework mechanics, not whether a
particular graph design is superior. Repository adoption should therefore be evaluated
against local outcomes: accepted correctness, escaped defects, rework, cycle time,
coordination cost, tokens, failed/replayed mutations, and human attention.

## 6. Application to `openab-vault`

This section is a **repository recommendation**, not an external source finding.

### 6.1 Recognize the graph already present

The repository already has a coherent macro-graph:

- Legacy ADR 0023 makes each
  execution dependency an explicit versioned edge and rejects cycles.
- Legacy ADR 0045 defines the
  optional research → parallel implementation → optional integration → parallel review
  → synthesis/remediation stage graph.
- Legacy ADR 0041
  separates reviewer claims, workspaces, sessions, and reports around one immutable
  target.
- Legacy ADR 0047
  puts the Transition Gate and GitHub state between isolated reviews and accepted
  decisions.
- The legacy glossary supplies the domain language for Definition Revisions,
  Work Dependencies, Evidence Contracts, Work Attempts, claims, Grants, and gates.

In other words, `openab-vault` is already graph-engineered in substance. Adopting LangGraph
or another runtime would be justified only if the Orchestrator needs its checkpointing or
dynamic control semantics; the label alone is not a reason.

### 6.2 Treat the dependency DAG and attempt loops differently

Keep the authoritative Work Dependency graph acyclic. Place adaptive loops inside bounded
Work Attempts:

```text
 Work Dependency DAG:
 Research -> Implement -> Integrate? -> Review -> Synthesize

 Inside one claimed Work Attempt:
 gather -> reason -> act -> observe -> verify
    ^                                  |
    +---------- bounded retry ---------+

 Gate failure:
 old target -> new remediation Work Item -> new target/review round
```

This preserves ADR 0023's eligibility semantics while allowing agents to debug and
self-correct. Remediation should remain new work with new evidence, not an implicit
back-edge.

### 6.3 Make edge contracts first-class

For every required dependency, record:

- prerequisite Work Item and required Definition Revision;
- release condition;
- expected artifact type and immutable reference;
- evidence required to satisfy the condition;
- consuming Work Item and input mapping;
- authority allowed to request and accept the release;
- failure, timeout, and stale-input behavior.

For joins, additionally record whether all branches are required, how cancellation works,
and who synthesizes conflicting outputs.

### 6.4 Parallelize only proven independence

Use parallel coder Work Items only when they have disjoint mutation scopes or named
integration ownership. Use parallel reviewers because their state is read-only and their
value comes from independent judgment. Surface serial bottlenecks rather than allowing
several agents to collide on them.

Claims, isolated workspaces, immutable Review Targets, and the Mutation Guard are not
incidental implementation details; they are the concurrency-control layer of the graph.

### 6.5 Anchor transitions outside agent consensus

A Transition Gate should prefer:

1. mechanically executed tests, builds, linters, and security checks;
2. immutable artifact identities and repository state;
3. independent review reports with retained provenance;
4. explicit Operator judgment for product, risk, and privileged-action trade-offs.

Several agents repeating the same conclusion is not independent evidence, especially if
they share a prompt, model, context, or evaluator.

### 6.6 Version, observe, and evaluate the graph

Expose a graph view derived from authoritative GitHub state rather than maintaining a
second editable diagram. At minimum, operators should be able to answer:

- Which Work Items are blocked, and by which unsatisfied edge?
- Which branches may run concurrently without conflicting claims or mutation scope?
- Which join is waiting, and what evidence is missing?
- Which graph/Definition Revision produced an accepted artifact?
- How many retries, escalations, and replayed mutations occurred?
- Which nodes consume most wall time, tokens, cost, and human attention?

Evaluate the development method using correctness and coordination outcomes, not only
throughput. Recommended baseline measures are accepted-work rate, escaped-defect and
revert rate, remediation rounds, dependency wait time, integration conflicts, claim
contention, agent cost, and Operator review time.

## 7. Recommended design principles

For this repository, “graph engineering” can be made precise as the following principles:

1. **Graph the work, not every thought.** Keep stage, dependency, evidence, and authority
   edges explicit; leave tactics inside a bounded attempt.
2. **Use versioned, typed contracts.** Inputs, outputs, release conditions, and gate
   evidence must survive conversation loss.
3. **Keep the macro-graph deterministic.** Claims, permissions, joins, and privileged
   mutations are code- and policy-governed.
4. **Permit local autonomy.** Agents choose tool sequences inside their authorized node.
5. **Fan out only independent work.** Isolation and a declared join are prerequisites for
   parallelism.
6. **Separate maker, checker, and synthesizer.** Preserve reviewer independence and
   report provenance.
7. **Anchor feedback externally.** Prefer executed evidence and retained human judgment
   over agent agreement.
8. **Bound every cycle.** Give retries, remediation rounds, polling, and evaluator loops
   budgets and escalation paths.
9. **Make side effects replay-safe.** Stable operation IDs and reconciliation rules
   accompany checkpoints.
10. **Version and observe topology.** A run is explainable only together with the graph
    revision that governed it.
11. **Measure quality, cost, and coordination together.** More nodes and more output are
    not outcomes by themselves.
12. **Earn complexity incrementally.** Add a graph feature only when a concrete
    dependency, concurrency, recovery, or assurance problem requires it.

## Sources

### Contemporary naming discourse

- Peter Steinberger, [“Are we still talking loops or did we shift to graphs
  yet?”](https://x.com/steipete/status/2078277297791189132), July 18, 2026. Primary
  social post; establishes the exchange, not a definition.
- Hamel Husain, [*Loop Engineering Is Dead. Enter Graph
  Engineering.*](https://x.com/HamelHusain/article/2078346425621237935), July 18,
  2026. Primary article page; establishes the label, not a standard.
- Carlos E. Perez, [*From Loop Engineering to Graph
  Engineering*](https://medium.com/intuitionmachine/from-loop-engineering-to-graph-engineering-d3ebeb08511c),
  July 19, 2026. Author's conceptual essay; one interpretation of a graph of improvement
  loops.

### First-party engineering documentation and reports

- Anthropic, [*Building Effective
  Agents*](https://www.anthropic.com/engineering/building-effective-agents).
- Anthropic, [*How We Built Our Multi-Agent Research
  System*](https://www.anthropic.com/engineering/multi-agent-research-system).
- Anthropic, [*Building a C Compiler with a Team of Parallel Claude
  Agents*](https://www.anthropic.com/engineering/building-c-compiler).
- Google, [ADK Graph Workflows](https://adk.dev/graphs/) and
  [Dynamic Workflows](https://adk.dev/graphs/dynamic/).
- LangChain, [LangGraph Graph
  API](https://docs.langchain.com/oss/python/langgraph/graph-api),
  [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence),
  [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), and
  [Functional API / durable
  execution](https://docs.langchain.com/oss/python/langgraph/functional-api).
- Microsoft, [AutoGen GraphFlow](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html).
- OpenAI, [*Open-sourcing Symphony: Turning Project Work into Isolated,
  Autonomous Runs*](https://openai.com/index/open-source-codex-orchestration-symphony/)
  and the [Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md).
- OpenAI, [*Harness Engineering: Leveraging Codex in an Agent-First
  World*](https://openai.com/index/harness-engineering/).
- GitHub, [Issue
  Dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies),
  [Understanding GitHub
  Actions](https://docs.github.com/en/actions/get-started/understand-github-actions),
  and [Concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency).

### Primary research and design proposals

- Bei et al., [*Graphs Meet AI Agents: Taxonomy, Progress, and Future
  Opportunities*](https://arxiv.org/abs/2506.18019), 2025.
- Hu Wei, [*From Agent Loops to Structured Graphs: A Scheduler-Theoretic Framework
  for LLM Agent Execution*](https://arxiv.org/abs/2604.11378), 2026. Position paper
  and design proposal; no reported empirical validation.
- Tran and Kiela, [*Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop
  Reasoning Under Equal Thinking Token Budgets*](https://arxiv.org/abs/2604.02460),
  2026. Preprint; multi-hop reasoning domain, not a general coding result.
- Wang et al., [*AgentFlow: Building Agent Dependency Graphs for Static Analysis
  of Agent Programs*](https://arxiv.org/abs/2607.01640), 2026. Recent preprint.
- Hou et al., [*When Agents Do Not Stop: Uncovering Infinite Agentic Loops in LLM
  Agents*](https://arxiv.org/abs/2607.01641), 2026. Recent preprint.

All web sources were checked on July 27, 2026.
