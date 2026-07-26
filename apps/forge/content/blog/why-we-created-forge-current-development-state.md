---
title: "Why We Created Forge: Current Development State"
description: "Why Forge exists, how AI agents and automation can reshape issue tracking, and what is currently being developed inside the product."
slug: "why-we-created-forge-current-development-state"
keywords:
  - Forge
  - issue tracking
  - agents
  - AI
  - automation
status: "draft"
---

# Why We Created Forge: Current Development State

Software teams rarely lose momentum because they lack ambition. They lose it because the work becomes harder to see.

An issue starts as a customer signal, a bug report, a product decision, a meeting note, a Slack thread, a pull request, or a half-remembered conversation. Then it moves through tools, people, priorities, and rituals. Somewhere along the way, context gets compressed. The original reason disappears. The decision trail becomes fragmented. The next action is technically assigned, but no one is fully sure whether it is still the right next action.

That is the real problem Forge is being built to solve.

Forge started from a simple observation: issue tracking is no longer just about recording work. Modern teams need a workspace that helps them understand work, prioritize it, connect it to outcomes, and automate the repetitive coordination around it. As AI becomes part of everyday software delivery, the tracker should not remain a passive database waiting for humans to keep it clean. It should become a shared operating layer where people and agents can collaborate with clarity.

This article explains why we created Forge, the product philosophy behind it, and the current state of development. We will cover:

- Why traditional issue tracking often breaks down as teams scale.
- How Forge approaches issues, signals, initiatives, teams, and automation.
- Why agents need structured product context, not just prompts.
- What is already taking shape in Forge today.
- Where the product is heading next.

[Internal link placeholder: Link to a future article on "What is Forge?"]

For broader context, GitHub describes issues as a way to track ideas, feedback, tasks, and bugs within development workflows in its [official GitHub Issues documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/about-issues). That framing is still true. But the environment around issue tracking has changed. Forge exists because tracking work is now only the beginning.

## The Problem With Modern Issue Tracking

Issue tracking tools were created to make software work visible. They gave teams a place to record bugs, assign owners, define statuses, and follow progress. That foundation is valuable. Without a shared record, work becomes oral tradition.

But many teams have reached a point where the tracker itself creates a new kind of drag. The tool may contain thousands of issues, but the system does not always explain what matters now. It can show a backlog, but not always the reason an item is important. It can assign work, but not always preserve the conversation that shaped the decision. It can support workflows, but not always reduce the amount of manual coordination required to keep those workflows useful.

The result is a familiar set of symptoms:

- The same work is discussed in multiple places.
- Issues contain incomplete context or stale assumptions.
- Priorities change faster than the tracker reflects.
- Small decisions disappear into chat history.
- Triage becomes a recurring meeting instead of a living practice.
- Reporting depends on manual status updates.
- Automation exists, but it is disconnected from product judgment.

Issue tracking was supposed to create alignment. In practice, it often becomes one more place alignment must be maintained.

[Internal link placeholder: Link to a future article on "The Hidden Cost of Stale Backlogs"]

Atlassian's Jira documentation explains how issues and subtasks help teams break work into trackable units through [Jira Work Management support](https://support.atlassian.com/jira-work-management/docs/create-an-issue-and-a-sub-task/). That model is useful. The challenge is that the unit of work is no longer enough by itself. Teams also need to manage signals, ownership, decisions, goals, and execution context.

### Issue Tracking Needs to Become Context Tracking

An issue is not just a task. It is a container for a decision.

When the container lacks context, teams compensate with meetings, comments, tags, reminders, and direct messages. These are not failures of discipline. They are signs that the system is not carrying enough meaning.

Forge is being designed around the idea that issue tracking should include the surrounding context by default:

- What triggered this work?
- Which customer, internal signal, initiative, or conversation does it connect to?
- Who owns the outcome, not just the next step?
- What changed since the issue was created?
- Which related work could affect priority or scope?
- What can be automated safely?
- What still requires human judgment?

That shift matters because teams do not only need a better list. They need a better map.

## Why We Created Forge

We created Forge because the way teams build software is changing faster than the tools around the work.

The classic project-management stack assumes that humans manually collect context, write tasks, update fields, summarize status, chase blockers, and decide what to do next. AI changes that assumption. Agents can read, summarize, classify, draft, connect, and execute. Automation can remove many of the repetitive coordination steps that used to consume the week.

But AI does not magically fix messy systems. If an agent is pointed at scattered, stale, low-context work, it will amplify the mess. If automation runs without clear boundaries, it can create noise faster than it creates leverage.

Forge exists to build the operating layer between human judgment and AI-assisted execution.

[Internal link placeholder: Link to a future article on "How Forge Uses AI Without Replacing Product Judgment"]

OpenAI describes agents as systems that can accomplish tasks by using models, tools, and workflow context in its [Agents guide](https://platform.openai.com/docs/guides/agents). That direction is important for software teams, but it raises a practical question: where should an agent get reliable context about the work? Forge is our answer to that question.

### The Core Belief Behind Forge

The core belief behind Forge is that teams should spend less time maintaining the system of work and more time improving the work itself.

That belief has three parts:

1. Work should be visible without requiring constant manual reporting.
2. Context should travel with the issue, initiative, project, and team.
3. Agents and automation should support people by reducing coordination overhead, not by hiding complexity or making decisions opaque.

This is why Forge is not being built as a decorative layer on top of a backlog. It is being built as a focused workspace for triage, execution, and agent-assisted delivery.

The product name is intentional. A forge is where raw material becomes something stronger through heat, structure, and repeated shaping. In the same way, Forge is meant to take raw signals, conversations, issues, and goals, then help teams shape them into clearer decisions and better execution.

## The Work Has Changed: Signals Are Everywhere

Teams no longer receive work from one clean input channel.

A bug may appear in support feedback. A strategic idea may come from a sales call. A delivery risk may be visible in engineering activity before it appears in a status report. A customer pain point may be repeated across multiple conversations before it becomes a formal issue.

The old workflow often looked like this:

1. Someone notices a problem.
2. Someone creates an issue.
3. Someone adds labels, priority, owner, and status.
4. Someone discusses it in a meeting.
5. Someone updates the issue after the meeting.

The modern workflow is messier. Signals arrive continuously, and the important ones need to be recognized before they become urgent.

Forge is being developed with that reality in mind. The product includes a dedicated concept of signals because not every meaningful input begins as an issue. Some signals need to become issues. Some need to be attached to initiatives. Some need to inform prioritization. Some should simply be visible as evidence.

[Internal link placeholder: Link to a future article on "Turning Product Signals Into Action"]

Google's Site Reliability Engineering book defines toil as manual, repetitive, automatable work that scales with growth in its chapter on [eliminating toil](https://sre.google/sre-book/eliminating-toil/). The same pattern appears in product and delivery operations. When every signal requires manual collection, manual summarization, and manual routing, the system scales poorly. Forge is being shaped to reduce that burden.

### From Backlog Management to Signal Management

Backlog management asks, "What is in the list?"

Signal management asks, "What is the system trying to tell us?"

That difference is central to Forge. A backlog can become large and quiet. Signals are active. They help explain why a piece of work matters and how the surrounding environment is changing.

In Forge, signals are intended to help teams:

- Identify repeated patterns before they become roadmap surprises.
- Connect customer or internal feedback to active work.
- Understand why an issue exists.
- Support better triage with evidence.
- Give agents structured input for summarization and routing.

The goal is not to replace judgment with a score. The goal is to make judgment better informed.

## Why Agents Need a Better Workspace

Agents are becoming more capable, but their usefulness depends on the environment around them.

An agent can draft an issue summary, propose a set of next steps, classify incoming work, or help identify related projects. But for those actions to be trustworthy, the agent needs clear permissions, structured context, and a visible trail of what happened. It should know the difference between a source signal and an approved decision. It should know whether it is suggesting, drafting, updating, or executing.

That is why Forge treats agents as part of the product architecture rather than as a novelty feature.

The current app structure includes an Agent area designed as a home for agent-driven workflows, prompts, and automations that support the team. This is an early but important foundation. It gives Forge a dedicated place to define and evolve how AI participates in the work.

[Internal link placeholder: Link to a future article on "Designing Safe Agent Workflows for Software Teams"]

NIST's [AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) emphasizes the importance of managing AI risks through governance, mapping, measurement, and risk management practices. For Forge, this reinforces a key product principle: AI features should be legible, reviewable, and grounded in context.

### AI Should Reduce Coordination, Not Create Mystery

Many AI features fail because they produce output without enough explanation. A summary appears, but no one knows which sources were used. A priority suggestion appears, but no one can see the reasoning. An automation updates a field, but the team does not understand the trigger.

Forge is being designed around a different standard. AI-assisted work should be:

- Traceable: people can see where a suggestion came from.
- Reviewable: people can accept, edit, or reject meaningful changes.
- Contextual: suggestions are connected to issues, projects, teams, signals, calls, and initiatives.
- Bounded: agents operate within defined workflows rather than acting unpredictably.
- Useful: automation removes repeated effort instead of adding another dashboard to check.

This is the difference between AI as a feature and AI as infrastructure. Forge is being built for the second path.

## Automation Should Start With the Repetitive Work

Automation is most valuable when it removes work that people already understand but should not have to repeat.

In issue tracking, repetitive work appears everywhere:

- Creating issues from recurring inputs.
- Summarizing meeting notes into follow-up tasks.
- Linking related work across teams.
- Updating stale fields after status changes.
- Flagging issues that have lost ownership.
- Highlighting delivery risks.
- Turning product signals into triage candidates.
- Preparing weekly summaries from active initiatives.

These are not glamorous workflows, but they matter. Every repeated manual step steals attention from work that requires deeper thinking.

Forge approaches automation with a practical bias. The product is not trying to automate judgment away. It is trying to automate the preparation around judgment: collecting context, organizing signals, summarizing changes, and reducing status-maintenance work.

[Internal link placeholder: Link to a future article on "Automation Patterns for Issue Tracking"]

Martin Fowler's article on [Continuous Integration](https://martinfowler.com/articles/continuousIntegration.html) explains the value of reducing integration risk through frequent automated checks. The same philosophy applies to work management. The more frequently a system can keep context current, the less painful it becomes to understand what is happening.

### What Good Automation Feels Like

Good automation does not feel like a robot taking over. It feels like the system remembered what you would otherwise have had to reconstruct.

In Forge, the long-term vision for automation is to help answer questions like:

- Which issues changed materially since the last review?
- Which initiatives have signals but no active work?
- Which projects have unclear ownership?
- Which calls generated unresolved follow-ups?
- Which issues are related but tracked separately?
- Which updates should be summarized for a team view?

When automation works well, people do not spend the first half of every meeting rebuilding context. They start closer to the decision.

## The Current State of Forge Development

Forge is currently in active development. The foundation is taking shape around a focused set of product areas: the Forge home view, inbox, issue tracking, initiatives, projects, teams, signals, calls, insights, views, members, and an agent workspace.

The current direction is intentionally modular. Rather than treating everything as a generic ticket, Forge is being built around the different kinds of context that influence software delivery.

[Internal link placeholder: Link to a future product changelog or "Forge Development Updates" hub]

For an external benchmark on delivery practices, Google Cloud's DORA program has long studied the relationship between technical practices, delivery performance, and organizational outcomes through its [DevOps research and solutions](https://cloud.google.com/solutions/devops). Forge is aligned with a similar idea: better systems of work should help teams improve both flow and confidence.

### Forge Home

The Forge home view is being shaped as a starting point for triage, execution, and agent-assisted delivery. It is meant to help teams jump into the workspaces, issues, and teams that matter next.

The home view matters because a modern work system needs an orientation layer. When someone opens the product, the first question should not be, "Which filter do I need?" It should be, "What needs attention?"

### Inbox

The inbox is designed as a focused queue for fresh work, recent updates, and incoming activity. This is where triage becomes a daily habit rather than a periodic cleanup event.

The inbox supports the broader Forge philosophy: work should enter the system clearly, then move toward the right issue, project, initiative, team, or agent workflow.

### My Issues

My Issues is the execution surface for owned work. Its purpose is to help people understand what they are responsible for, what needs attention next, and what may be blocked or stale.

This area is important because ownership should be easy to see. A good issue tracking system helps reduce ambiguity around responsibility without turning every update into a performance ritual.

### Workspace

The workspace area currently includes initiatives, projects, calls, signals, insights, views, teams, and members. These modules reflect the belief that work has multiple dimensions:

- Initiatives connect long-running efforts to outcomes.
- Projects organize active streams of delivery.
- Signals preserve meaningful inputs.
- Calls capture conversations and follow-ups.
- Insights turn activity into decision-ready observations.
- Views help people save the slices of work they need.
- Teams show where collaboration and ownership live.
- Members keep participation and responsibility visible.

This structure is still evolving, but the shape is deliberate. Forge is not only tracking tasks. It is building a shared memory around the work.

### Team Spaces

Forge includes team-oriented spaces for product, engineering, and operations workflows, with sections for projects, issues, signals, calls, and insights. The intention is to let teams see their own operating context without losing connection to the broader workspace.

Team spaces matter because different groups need different views of the same reality. A delivery issue may matter to one team as execution work, to another as a planning risk, and to another as a customer-impact signal. Forge should make those relationships easier to navigate.

### Agent Workspace

The agent workspace is the beginning of Forge's AI and automation layer. It is intended to become the place where agent-driven workflows, prompts, and supporting automations can be configured, reviewed, and improved.

This is still early, but it is central to the product. Agents should not live as disconnected chat boxes. They should be connected to the work graph, the relevant context, and the actions they are allowed to take.

## What Makes Forge Different

Forge is not being created because the world needs another backlog UI.

It is being created because software teams are entering a new phase of work. The issue tracker can no longer be only a static record. It has to become more aware of context, more capable of supporting automation, and more useful as a foundation for agents.

[Internal link placeholder: Link to a future comparison article on "Forge vs Traditional Issue Tracking"]

The [GitHub Issues feature overview](https://github.com/features/issues) highlights project planning features such as task lists, project tables, and issue organization. These capabilities are part of the broader evolution of issue tracking. Forge builds from the same need for clarity, but pushes toward an agent-ready workspace where context, automation, and execution live closer together.

### 1. Forge Treats Context as a First-Class Object

In many systems, context is stored in comments, descriptions, links, and memory. Forge is being designed so context has a more durable shape.

Signals, calls, initiatives, projects, teams, and insights all help explain the work. They are not side notes. They are part of how the work should be understood.

### 2. Forge Connects Human Judgment and AI Execution

The purpose of AI in Forge is not to remove people from the loop. It is to make the loop healthier.

Agents can help with summarization, routing, pattern recognition, drafting, and follow-up preparation. People still define outcomes, make tradeoffs, approve meaningful changes, and bring judgment to ambiguous decisions.

### 3. Forge Is Built for Modular Workflows

Different teams have different operating rhythms. Some need tight execution views. Some need initiative-level visibility. Some need signal triage. Some need agent-assisted automation.

Forge is being built modularly so teams can use the surfaces that match the work without forcing every workflow into the same shape.

### 4. Forge Prioritizes Readability and Focus

The interface direction is focused and utilitarian. Work tools should be calm enough to use every day. Dense information should remain readable. Actions should be close to the context that explains them.

That design principle matters because issue tracking is not occasional software. It is where teams spend a meaningful part of their week.

## How Forge Supports Better Triage

Triage is one of the most important and most underestimated workflows in software development.

Good triage is not simply sorting tickets. It is deciding what deserves attention, what needs more context, what can wait, what should be closed, and what should become part of a larger initiative.

Poor triage creates hidden costs:

- Important work waits behind noisy work.
- Duplicate issues split attention.
- Urgent requests bypass the system.
- Old issues remain open because closing them feels risky.
- Teams debate priority without shared evidence.
- Work appears smaller than it really is because related signals are disconnected.

Forge is being designed to make triage more informed. The inbox, signals, issues, initiatives, and agent workflows all contribute to this.

[Internal link placeholder: Link to a future guide on "How to Run Better Triage in Forge"]

The Scrum Guide describes the Product Backlog as an emergent, ordered list of what is needed to improve a product in the official [Scrum Guide](https://scrumguides.org/scrum-guide.html). Even for teams that do not follow Scrum strictly, the idea of an evolving ordered list is useful. Forge extends that idea by focusing on the evidence and automation needed to keep the list meaningful.

### Triage Should Be Continuous

Triage works best when it is part of the system, not an occasional rescue mission.

Forge's development direction supports continuous triage by separating incoming work, owned work, team work, and larger initiatives. This allows different questions to be answered in the right place:

- What just came in?
- What do I own?
- What is my team focused on?
- Which initiative does this support?
- What signals are accumulating?
- What can an agent prepare before a human decides?

When those questions have clear homes, coordination becomes lighter.

## How Forge Supports Initiatives and Projects

Issues are necessary, but they are too small to carry strategic meaning alone.

A single issue may fix a bug, add a field, improve a flow, or complete an integration. But many meaningful outcomes require a collection of issues, projects, signals, and decisions. That is why Forge includes initiatives and projects as core concepts.

Initiatives represent longer-running efforts tied to outcomes. Projects represent clearer streams of work with owners, planned completion, and progress. Together, they help prevent the common problem where teams can see tasks but cannot see the larger reason those tasks exist.

[Internal link placeholder: Link to a future article on "Initiatives vs Projects in Forge"]

The Project Management Institute's overview of [project management](https://www.pmi.org/about/learn-about-pmi/what-is-project-management) describes projects as temporary efforts undertaken to create value through unique products, services, or results. Forge applies that practical distinction inside a software delivery workspace: projects need enough structure to guide execution, while initiatives need enough context to connect execution to outcomes.

### Why Outcomes Need a Place to Live

When outcomes live only in planning documents, they drift away from daily execution.

Forge is being built so initiatives can stay connected to the projects and issues that advance them. This makes it easier to answer:

- Which work supports this outcome?
- Which projects are active?
- Who owns the initiative?
- What is the target date?
- What signals suggest the initiative may need attention?
- What updates should be visible to the wider team?

This is also where agents can eventually become especially useful. If the system understands the relationship between initiative, project, issue, signal, and team, an agent can help summarize progress in a way that reflects the actual structure of the work.

## How Forge Supports Team Awareness

Most tools let people assign issues to individuals. Fewer tools help teams understand their shared operating context.

Forge includes team spaces because collaboration is not only about ownership. It is also about attention. A team needs to see the projects, issues, signals, calls, and insights that belong together. It needs to understand where the work is moving and where the context is changing.

[Internal link placeholder: Link to a future article on "Team Workspaces in Forge"]

Team Topologies, a widely referenced model for organizing software teams, emphasizes the importance of clear team responsibilities and interaction modes on the [official Team Topologies site](https://teamtopologies.com/key-concepts). Forge does not prescribe one organization model, but it is being built with a similar respect for team boundaries and collaboration patterns.

### Shared Awareness Beats Status Theater

Status updates are useful when they create shared awareness. They become wasteful when they only repeat what the system should already know.

Forge aims to make more of the system knowable before the meeting starts. If issues, signals, projects, and initiatives are connected, then status conversations can move faster:

- What changed?
- What is blocked?
- What needs a decision?
- What is no longer relevant?
- What needs follow-up?

The value is not fewer conversations for their own sake. The value is better conversations because the basics are already visible.

## How Forge Approaches Insights

Insights are where raw activity becomes useful interpretation.

Most teams have more data than they can use. They have issues, commits, comments, calls, roadmaps, metrics, customer requests, and operational signals. The problem is not scarcity. The problem is synthesis.

Forge includes an insights area because teams need a way to turn activity into observations that support decisions. This is where AI can help, but only when the underlying context is structured enough to trust.

[Internal link placeholder: Link to a future article on "From Signals to Insights in Forge"]

Google Cloud's DORA research notes that software delivery performance is connected to both speed and stability in its [DevOps research overview](https://cloud.google.com/solutions/devops). Forge's insight direction is influenced by that broader lesson: useful reporting should not only show movement, but help teams understand whether the movement is healthy.

### Insights Should Help Teams Decide

A useful insight is not just a chart. It is a clearer path to a decision.

Forge's insight layer is being shaped around questions such as:

- Which initiatives are gaining or losing momentum?
- Which areas generate repeated signals?
- Which issues remain unresolved across cycles?
- Which projects have unclear next actions?
- Which team spaces show rising coordination load?
- Which automations are saving time, and which need adjustment?

The aim is to make insights actionable without making them simplistic. Software work contains ambiguity. Forge should help teams navigate that ambiguity with better context.

## What We Are Prioritizing While Building Forge

Product development is a sequence of tradeoffs. Forge is still early, so the priority is to build the right foundation before adding complexity.

The current development focus can be summarized in five themes.

[Internal link placeholder: Link to a future roadmap article on "What We Are Building Next in Forge"]

The Shape Up methodology from Basecamp emphasizes appetite, shaping, and betting as ways to make product work more intentional in its [official Shape Up book](https://basecamp.com/shapeup). Forge is not tied to one planning method, but the principle is relevant: building the right product requires making scope clear enough to finish and flexible enough to learn.

### 1. A Clear Information Architecture

Forge needs strong foundations. The product is being organized around spaces that mirror how work actually appears: inbox, issues, initiatives, projects, signals, calls, insights, teams, views, members, and agents.

This information architecture matters because AI and automation depend on structure. If the core objects are unclear, intelligent workflows become fragile.

### 2. Focused Execution Surfaces

The product needs to help people see what deserves attention now. My Issues, team issue views, the inbox, and initiative views are all part of this execution layer.

The goal is to reduce the time between opening Forge and understanding the next meaningful action.

### 3. Context-Rich Work Objects

Forge is being built so work can connect to its surrounding evidence: signals, calls, initiatives, teams, and insights. This makes issue tracking more useful and gives agents better context for assistance.

### 4. Agent-Ready Workflows

The agent workspace is an early foundation for AI-assisted workflows. Over time, this should support structured prompts, repeatable automations, reviewable suggestions, and context-aware execution.

### 5. Calm, Practical Product Design

Forge is a daily-use tool. It needs to feel focused, readable, and efficient. The design direction favors clarity over spectacle and supports dense but organized information.

## Where Forge Is Heading

The long-term vision for Forge is an issue tracking and work orchestration platform where people and agents collaborate around a shared source of truth.

That means Forge should eventually help teams:

- Capture incoming work from multiple sources.
- Convert signals into issues, projects, or initiative context.
- Keep issue tracking clean with less manual maintenance.
- Use agents for summarization, routing, and follow-up preparation.
- Automate repetitive coordination workflows.
- Preserve decisions and context over time.
- Understand progress across initiatives and teams.
- Make better prioritization decisions with clearer evidence.

This is an ambitious direction, but it is grounded in a practical need. Teams do not need AI theater. They need less friction, better context, and more confidence that the work system reflects reality.

[Internal link placeholder: Link to a future article on "The Forge Roadmap for AI and Automation"]

OpenAI's Agents SDK documentation describes agents as model-powered systems configured with instructions, tools, and other control structures in the [Agents SDK guide](https://openai.github.io/openai-agents-js/guides/agents/). For Forge, the important product question is how those agents become useful inside real team workflows. The answer is not more magic. It is better context, safer automation, and clearer collaboration.

### The Future Is Not a Bigger Backlog

The future of issue tracking is not a bigger backlog with a chatbot attached.

The future is a more intelligent system of work:

- A system that understands where work came from.
- A system that keeps context close to execution.
- A system that lets agents help with bounded, reviewable tasks.
- A system that reduces manual coordination.
- A system that helps people focus on decisions, tradeoffs, and outcomes.

That is the direction Forge is moving toward.

## How to Think About Forge Today

Forge is best understood as an evolving product built around a clear thesis: issue tracking, AI, agents, and automation should converge into one practical workspace for modern software delivery.

Today, that means building the core surfaces carefully. It means shaping the information architecture before overloading the product with features. It means treating agent workflows as a serious foundation, not an add-on. It means making room for signals, calls, insights, initiatives, and team context because those are the inputs that make issue tracking meaningful.

If you are evaluating Forge or following its development, the most useful lens is not, "Does this replace every workflow today?" The better question is, "Is this the right foundation for where software work is going?"

We believe the answer is yes.

[Internal link placeholder: Link to a future article on "Getting Started With Forge"]

For another perspective on resilient work systems, the Agile Manifesto values working software, customer collaboration, and responding to change in the [official Agile Manifesto](https://agilemanifesto.org/). Forge is not a methodology tool, but it shares a practical respect for adaptability: the system should help teams respond to reality as it changes.

## Conclusion: Why Forge Exists Now

Forge was created because teams need a better way to manage the reality of modern software work.

Issue tracking still matters. In fact, it matters more than ever. But the tracker can no longer be only a place where tasks sit. It needs to become a workspace where context is preserved, signals are understood, agents can help safely, and automation removes repetitive coordination from the week.

The current state of Forge development reflects that belief. The foundations are being built around focused surfaces: inbox, issues, initiatives, projects, teams, signals, calls, insights, views, members, and agents. Each module supports the same larger goal: helping teams see the work clearly enough to make better decisions and move with confidence.

A useful operating principle for this next era is: "Make the important work visible, then make the repetitive work disappear."

That is what Forge is being built to do.

If your team is feeling the limits of traditional issue tracking, if AI experiments feel disconnected from real workflows, or if automation has not yet reduced the coordination load, Forge is being shaped for you. Follow the development updates, share the workflows that slow your team down, and help us build an issue tracking workspace where people and agents can do better work together.
