---
name: design-brief
description: Write or update docs/BRIEF.md, the brief of the design: what the conversation decided about the business, in one document the analyst can work from. Use when the person says the design is done, asks for a summary, a report or the documents, or before the session ends.
---

# The brief of the design

The glossary holds the words and the ADRs the few hard decisions: everything else the person decided
lives only in the conversation. The brief puts it in one document, so the analyst who reads the
design later finds every decision without reading the whole conversation.

Do NOT interview the person: synthesize what was said, the answers to every question included. Read
`GLOSSARY.md` and `docs/adr/` first and use their terms throughout; link an ADR instead of repeating it.

Write `docs/BRIEF.md` (update it when it exists: keep what still holds, change what the conversation
changed). It describes the business, never the implementation: no technologies, modules, schemas,
file paths or code. A decision the person took about technology belongs to an ADR, not here.

## Template

```markdown
# <What is being designed>

## Goal
Who it is for and the problem it solves, from their point of view. What success looks like.

## People and roles
Each role (glossary terms): what it does, what it can see and change, what it cannot.

## Flows
Each flow step by step, from what starts it to how it ends: who does what, what changes state, what
happens on each branch (accepted, refused, late, cancelled).

## Rules
Numbered, one decision each, as concrete as the conversation made it: amounts, percentages,
deadlines, limits, who decides, the exceptions. Every answer the person gave is a rule here or in a
flow above, unless it is in the glossary or an ADR.

## What the business keeps
The records and their facts as the business sees them (an Order has a Customer, its lines, a
status...), not as a database would store them.

## Notifications and timings
Who is told what and when; what has a deadline and what happens when it passes.

## Settings
What an administrator can change without a new design (tariffs, lists, timings).

## Open points
What was not decided, and who has to decide it. Never invent an answer: an open point is better.

## Out of scope
What the person excluded, and what is left for later.
```

Leave out a section with nothing to say. When the brief is written, tell the person in a few lines
what it holds and list the open points, so they can answer them before the session ends.
