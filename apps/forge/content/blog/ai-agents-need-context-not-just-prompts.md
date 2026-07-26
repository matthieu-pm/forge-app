---
title: "AI Agents Need Context, Not Just Prompts"
description: "AI agents can only help software teams when they understand the work around the prompt: issues, signals, calls, initiatives, and teams."
slug: "ai-agents-need-context-not-just-prompts"
keywords:
  - Forge
  - AI agents
  - issue tracking
  - prompts
  - context
  - automation
  - signals
status: "draft"
---

# AI Agents Need Context, Not Just Prompts

The easiest way to make an AI agent look useful is to give it a good prompt.

The hardest way to make an AI agent actually useful is to give it the right context.

That difference matters more than most teams realize. Prompts are visible. Context is structural. Prompts are easy to rewrite. Context has to be captured, organized, permissioned, connected, and kept current. Prompts tell an agent what to do. Context helps the agent understand what the work means.

This is where many AI experiments in software teams begin to disappoint. The model is capable. The prompt is clever. The demo is promising. But when the agent enters real product and engineering work, it runs into the same old mess: stale issues, missing decision history, disconnected customer signals, meeting notes with no follow-up trail, initiatives that drift away from execution, and team ownership that lives more in memory than in the system.

The problem is not that teams need better prompt libraries. The problem is that agents need a better workspace.

Forge is being built around that belief. AI agents should not operate on a pile of disconnected tickets. They should work inside a structured system of issues, signals, calls, initiatives, teams, and insights. That structure is what turns a prompt from a one-off instruction into a reliable workflow.

[Internal link placeholder: Link to "Why Issue Tracking Is Breaking in the AI Era"]

OpenAI's [Agents guide](https://platform.openai.com/docs/guides/agents) describes agents as systems that can use models, tools, and instructions to accomplish tasks. For software teams, the missing ingredient is often not another instruction. It is the workflow context that lets the agent act usefully and safely.

## The Prompt Is Not the Product

Prompts are important. A vague instruction produces vague output. A focused instruction can make an agent more useful, more predictable, and easier to evaluate.

But prompts are only one layer of the system.

If the underlying work context is weak, even a strong prompt has to compensate for missing information. It has to infer what should have been explicit. It has to guess which issue matters, which signal is relevant, which team owns the work, which initiative is current, and which decision has already been made. Sometimes it guesses well. Sometimes it does not. Either way, people have to spend time checking the output because the system did not give the agent enough grounding.

This is why prompt-first AI workflows often hit a ceiling. They improve the interaction, but they do not repair the environment around the interaction.

Good prompts can help an agent:

- Summarize a thread.
- Draft an issue.
- Classify feedback.
- Generate follow-up tasks.
- Propose a status update.
- Suggest related work.

Good context helps the agent know whether those actions are correct, relevant, and safe.

[Internal link placeholder: Link to "What Makes a Good Issue in 2026?"]

OpenAI's [Agents SDK documentation](https://openai.github.io/openai-agents-js/guides/agents/) separates concepts such as instructions, tools, and run context. That separation is useful: instructions shape behavior, tools enable action, and context gives the agent information about the work it is doing. Forge's product direction starts from the same practical distinction.

### A Better Prompt Cannot Fix Missing Work Memory

Most teams do not lack words. They lack shared memory.

An issue might describe what needs to be built, but not why it matters. A call might include the customer pain, but the follow-up issue may not link back to the conversation. An initiative might define a desired outcome, but the active projects may not clearly show how they support it. A team might own a domain, but the tracker may only show individual assignees.

When that memory is missing, agents struggle in ways that feel subtle at first:

- Summaries omit the original customer signal.
- Drafted issues repeat decisions that were already rejected.
- Suggested priorities ignore initiative context.
- Automations route work to the wrong team.
- Follow-up tasks lose the nuance from the call.
- Status updates describe activity but not progress.

The prompt did not fail alone. The system failed to preserve meaning.

## Context Is the New Interface

For years, the main interface for work management was the task list. A team opened the tracker, viewed the backlog, filtered issues, updated statuses, and moved work across columns.

In the AI era, the interface is changing.

Agents do not only need screens. They need structured access to the work. They need to know what objects exist, how those objects relate, what actions are allowed, and which sources support their outputs. In other words, context becomes an interface.

That does not mean replacing human interfaces with hidden automation. It means designing the product so both people and agents can understand the same work system.

Forge is being shaped around structured work objects because those objects give context a durable form:

- Issues represent concrete units of work.
- Signals represent meaningful inputs before or around work.
- Calls represent conversations, decisions, and follow-ups.
- Initiatives represent longer-running outcomes.
- Teams represent ownership, collaboration, and operating context.
- Insights represent synthesized observations that support decisions.

When these objects are connected, the system becomes easier for people to navigate and easier for agents to assist.

[Internal link placeholder: Link to "The Future of Issue Tracking Is a Shared Work Graph"]

Anthropic's [Model Context Protocol documentation](https://docs.anthropic.com/en/docs/mcp) reflects a broader industry movement toward connecting AI systems to external tools and data sources. Forge applies that same context-first idea at the product level: agents need access to the right work context, not just a text box.

### Context Has to Be Structured Enough to Trust

Not all context is equally useful.

A long comment thread is context, but it may be noisy. A meeting transcript is context, but it may contain unresolved ideas. A customer quote is context, but it may represent one account rather than a broad pattern. A label is context, but it may be stale. A priority field is context, but it may hide the reasoning behind the priority.

For agents, this matters. An agent needs to know not only what information exists, but what kind of information it is.

Forge's approach is to give context stronger shapes. A signal is different from an issue. A call is different from an initiative. A team is different from an assignee. An insight is different from raw activity. Those distinctions help agents avoid flattening everything into undifferentiated text.

That is the difference between "summarize this pile" and "prepare a triage brief from these customer signals, related issues, and active initiatives for this team."

## Issues: The Work Item Is Only the Start

Issues are still necessary. They give work a place to live. They help teams assign owners, define status, discuss implementation, and track progress.

But an issue is only the start of the context an agent needs.

Consider a simple issue: "Improve onboarding workspace setup."

The title gives the agent a topic. The description may explain a proposed change. But the agent also needs to know:

- Which users or accounts struggled with onboarding?
- Which calls or support conversations mentioned the problem?
- Which initiative does onboarding support?
- Which team owns the setup experience?
- Which related issues are already open?
- What has already been tried?
- What should not be changed because of technical constraints?
- Which updates require human approval?

Without those connections, the agent can generate plausible work. With those connections, the agent can support better work.

[Internal link placeholder: Link to "How to Write Agent-Readable Issues"]

GitHub's [Issues documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/about-issues) describes issues as places to track ideas, feedback, tasks, and bugs. Forge builds from that familiar unit, but treats the issue as one object inside a larger context network.

### Agent-Ready Issues Need Relationships

An issue becomes more useful to an agent when it is connected to the surrounding work.

Useful relationships include:

- Source signals that explain why the issue exists.
- Calls that contain relevant customer or internal discussion.
- Initiatives that explain the outcome the issue supports.
- Projects that organize delivery.
- Teams that clarify ownership.
- Related issues that show dependencies, duplicates, or prior work.
- Insights that summarize patterns across activity.

This does not mean every issue needs every relationship. It means the system should support relationships when they matter. A small bug may need only a clear reproduction path. A strategic workflow change may need signals, calls, initiatives, and multiple team links.

Agent-ready issue tracking is not about adding ceremony. It is about making the important context available when the work requires it.

## Signals: Agents Need to Know Where Work Came From

One of the biggest weaknesses in traditional issue tracking is that it often loses the source of the work.

A product request becomes a ticket. A customer complaint becomes a bug. A sales objection becomes a roadmap item. An incident pattern becomes a reliability project. But once the issue exists, the original signal may fade.

Agents need those signals.

Signals help an agent understand why something matters before it becomes fully specified work. They provide evidence, urgency, repetition, and nuance. They also help prevent the tracker from becoming a pile of isolated tasks with no visible origin.

[Internal link placeholder: Link to "Signals vs Issues: Why Modern Teams Need Both"]

The Scrum Guide defines the Product Backlog as an emergent, ordered list of improvements in the official [Scrum Guide](https://scrumguides.org/scrum-guide.html). Signals are one way to keep that list grounded in reality. They help explain what should enter the backlog, what should change priority, and what deserves more investigation.

### Signals Make AI Triage More Useful

AI triage is only as good as the evidence it can see.

If an agent reviews incoming work without signal context, it may classify and route issues based on surface text. If the same agent can see related support feedback, customer calls, analytics changes, and active initiatives, it can prepare a much better triage summary.

Signal-aware agents can help teams:

- Cluster repeated feedback.
- Identify related issues.
- Suggest when a signal should become an issue.
- Attach new evidence to existing work.
- Flag when an initiative is accumulating new signals.
- Prepare product and engineering triage notes.

This is not about letting AI decide priority alone. It is about letting AI prepare the evidence so people can decide faster and with more confidence.

## Calls: Conversations Carry Decisions

Some of the most important product and engineering context lives in conversations.

Customer calls reveal pain in the customer's own words. Internal planning calls capture tradeoffs. Incident reviews explain why a system failed. Product reviews decide what should change. Engineering discussions define constraints that may never make it into the issue description.

If those calls are disconnected from the work, agents lose a major source of truth.

This is especially important because AI can summarize calls well enough to create a false sense of completeness. A summary may include action items, but miss the decision behind them. It may list follow-ups, but fail to link them to the right initiative or team. It may capture what was said, but not what should happen next.

[Internal link placeholder: Link to "From Customer Conversations to Actionable Issues"]

NIST's [AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) emphasizes governance, mapping, measurement, and management as part of trustworthy AI. In work management, this supports a practical product principle: when agents act on conversation data, the source, purpose, and review path should be clear.

### Calls Need to Become Connected Work

In Forge, calls are part of the structured work system because conversations often create or reshape work.

An agent should eventually be able to help answer:

- Which issues came from this call?
- Which follow-ups remain unresolved?
- Which signals appeared across multiple calls?
- Which team owns the next action?
- Which initiative does this conversation affect?
- What changed because of this decision?

That is much more useful than a standalone transcript summary.

The goal is to move from passive call notes to connected work memory. Agents can help summarize and draft, but the product should preserve the relationship between the conversation and the work it created.

## Initiatives: Agents Need to Understand Outcomes

Issues explain tasks. Initiatives explain outcomes.

Without initiative context, agents may optimize for local completion rather than meaningful progress. They can help close tickets, but miss whether those tickets advance the outcome the team actually cares about.

This is a common failure mode in software work. The backlog shows activity. The roadmap shows ambition. The connection between the two is unclear.

Forge treats initiatives as first-class because agents need to understand the larger effort behind the work. If an initiative is focused on improving activation, reducing support load, hardening a platform area, or preparing a launch, related issues and projects should be connected to that purpose.

[Internal link placeholder: Link to "Initiatives vs Projects in Forge"]

The Project Management Institute describes projects as temporary efforts undertaken to create value in its overview of [project management](https://www.pmi.org/about/learn-about-pmi/what-is-project-management). Forge uses similar practical reasoning: teams need structures that connect temporary work to durable outcomes.

### Outcome Context Changes Agent Behavior

An agent with initiative context can produce different and better outputs.

Without initiative context, a status update might say:

"Three issues were completed, two remain in progress, and one is blocked."

With initiative context, it can say:

"The onboarding initiative moved forward through completed workspace setup improvements, but activation measurement remains blocked because the event taxonomy issue has no owner."

The second version is more useful because it connects activity to outcome.

That is the kind of context Forge is being built to support. Agents should help teams understand progress, risk, and next actions at the level where decisions are made.

## Teams: Agents Need Ownership and Boundaries

Agents also need to understand teams.

In many trackers, ownership is reduced to an assignee. That is useful, but incomplete. Real ownership often lives at the team level. A person may own the next task, but a team owns the domain, the workflow, the system, or the outcome.

If an agent does not understand team context, it can create coordination problems:

- It routes work to the wrong group.
- It suggests updates without knowing who should review them.
- It summarizes issues without understanding team priorities.
- It misses that a signal affects multiple teams.
- It recommends automation that conflicts with how a team operates.

Team context gives agents boundaries. It tells them where work belongs, who should be involved, and which workflows matter.

[Internal link placeholder: Link to "Team Workspaces in Forge"]

Team Topologies emphasizes clear team responsibilities and interaction patterns in its [key concepts](https://teamtopologies.com/key-concepts). Forge does not force one operating model, but it is being designed with the same respect for team ownership and collaboration boundaries.

### Agents Should Support Teams, Not Create Hidden Work

Bad automation creates hidden work.

An agent drafts something, but someone has to fix it. It updates a field, but another team disagrees. It creates issues, but no one owns them. It summarizes status, but misses the team's real concern. The agent appears productive while creating cleanup.

Team-aware agents should reduce that burden. They should help prepare work for the right team, in the right format, with the right context and review path.

In Forge, team spaces are part of the answer. They give projects, issues, signals, calls, and insights a shared operating home. That makes agent assistance more grounded because the agent can work within the team's visible context.

## The Real AI Advantage Is Better Coordination

There is a temptation to measure AI agents by how much work they can do alone.

For software teams, the more valuable question is how much coordination they can remove.

A good agent does not need to replace a product review, engineering discussion, or prioritization decision. It can make those moments better by preparing the context:

- Summarizing relevant signals.
- Drafting issues from calls.
- Linking related work.
- Flagging missing ownership.
- Preparing initiative updates.
- Identifying stale or duplicate issues.
- Suggesting next actions for review.

This is where AI becomes operationally valuable. It reduces the time people spend reconstructing context so they can spend more time making decisions.

[Internal link placeholder: Link to "How AI Can Reduce Product and Engineering Coordination Work"]

Google's Site Reliability Engineering book defines toil as manual, repetitive, automatable work that scales with growth in its chapter on [eliminating toil](https://sre.google/sre-book/eliminating-toil/). Many coordination tasks in issue tracking have the same shape. Forge's automation direction is focused on reducing that kind of work.

### The Best Agents Make the System Calmer

AI should not make the work system louder.

If agents create more issues, more summaries, more notifications, and more dashboards without improving clarity, they become another source of noise. The best agents make the system calmer. They remove repeated effort. They surface what matters. They explain their sources. They stay inside useful boundaries.

That is why context matters more than prompt cleverness. A prompt can generate output. A context-rich workspace can help the agent generate the right output at the right moment for the right team.

## What an Agent-Ready Workspace Requires

An agent-ready workspace is not just a tracker with AI features added on top.

It needs product foundations that make context durable and usable.

[Internal link placeholder: Link to "The Forge Roadmap for AI and Automation"]

GitHub's documentation for [Copilot coding agent](https://docs.github.com/en/copilot/concepts/coding-agent/coding-agent) shows how coding agents can be assigned work in development workflows. That is a strong sign of where the category is moving. As agents become more embedded in delivery, the surrounding work system needs to provide clearer assignments, context, and boundaries.

### 1. Clear Work Objects

The system needs objects that represent the real shape of work:

- Issues for tasks and defects.
- Signals for meaningful inputs.
- Calls for conversations and follow-ups.
- Initiatives for outcomes.
- Teams for ownership.
- Insights for synthesized understanding.

These objects make context addressable. Agents can reference them, connect them, summarize them, and act around them.

### 2. Visible Relationships

Context lives in relationships.

An issue related to a signal is different from an issue with no source. A project connected to an initiative is different from a standalone list of tasks. A call linked to follow-up issues is different from a transcript in a folder.

Relationships help agents understand what belongs together.

### 3. Reviewable Actions

Agents should be able to draft, suggest, summarize, and prepare. Meaningful changes should be reviewable.

This builds trust. People are more likely to use agent workflows when they can see what changed, why it changed, and which sources were used.

### 4. Team Boundaries

Agents need to understand who owns what.

Team boundaries help with routing, permissions, notifications, summaries, and escalation. They also prevent agents from treating the whole workspace as one undifferentiated backlog.

### 5. Automation That Starts Small

The safest automation starts with repetitive, well-understood work:

- Drafting triage summaries.
- Linking obvious related work.
- Preparing follow-ups.
- Flagging missing owners.
- Summarizing initiative changes.

Over time, automation can become more powerful. But it should earn trust by reducing friction before it expands.

## How Forge Connects Prompts to Work Context

Forge's product direction is built around the belief that agents need structured context before they can become reliable teammates.

That is why Forge is not only an issue tracker. It is being shaped as a workspace where the objects around issue tracking can connect:

- Issues hold work.
- Signals explain where work came from.
- Calls preserve conversations and decisions.
- Initiatives connect work to outcomes.
- Teams clarify ownership and operating context.
- Insights help turn activity into decisions.
- Agents and automation help prepare, summarize, route, and maintain the system.

This structure gives prompts something stronger to operate on.

Instead of asking an agent, "Summarize this ticket," a team should be able to ask:

"Prepare a triage brief for this team using new signals, related issues, recent calls, and active initiatives. Highlight what needs human review."

That is a different class of workflow. It is not prompt magic. It is context-aware work orchestration.

[Internal link placeholder: Link to "Join the Forge Beta" or "Follow Forge Development Updates"]

### Forge Is Built for Human Judgment Plus Agent Assistance

Forge is not being built to remove people from the loop.

It is being built to improve the loop.

People should still make the important calls: what matters, what tradeoffs are acceptable, what should be built, what should wait, and what risks are worth taking. Agents should help prepare the ground for those decisions by reducing the repetitive work around them.

That is the future Forge is aiming toward: people making better decisions because the system carries more context, and agents helping because they can finally see enough of the work to be useful.

## Conclusion: Better Prompts Are Not Enough

Better prompts can improve an AI agent. Better context can change what the agent is capable of doing.

That is the real lesson for software teams entering the AI era. If agents only see isolated tasks, they will produce isolated assistance. If they can see issues, signals, calls, initiatives, teams, and insights as connected parts of the same work system, they can help teams triage, summarize, route, update, and decide with more confidence.

The future of AI agents in software work will not be won by prompt libraries alone. It will be won by products that understand the shape of the work.

A useful principle for this next phase is: "The prompt tells the agent what to do. Context tells the agent what the work means."

Forge is being built from that principle. If your team is experimenting with AI agents but still struggling with stale tickets, scattered customer signals, meeting follow-ups, and unclear ownership, the missing layer may not be another prompt. It may be the structured workspace that helps agents and people understand the work together.
