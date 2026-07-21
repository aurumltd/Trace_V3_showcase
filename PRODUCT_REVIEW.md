# Trace Product Review Brief

Trace is a product management showcase for an AI agent product, not only a technical demo. The goal is to demonstrate how an ambiguous productivity problem can be turned into a bounded, trustworthy, local-first AI product.

## 1. Product Thesis

Knowledge workers do not only need another timer, task manager, or AI summary. They need a reliable way to understand:

- what actually happened
- what moved the plan forward
- what drifted from the plan
- what should be adjusted next

Trace addresses this by becoming an interpretation layer over existing work habits instead of replacing the user's Calendar, Reminders, or task system.

## 2. Strategic Product Choice

The core product decision was to reject a heavy all-in-one productivity system.

| Option | Why it was rejected or chosen |
|---|---|
| Build a full task/calendar system | Rejected because it increases migration cost and competes with tools users already trust |
| Build a raw activity tracker | Rejected because raw logs do not explain what work actually means |
| Build a chatbot productivity coach | Rejected because a chat interface is weak at continuous context and plan comparison |
| Build a lightweight work interpretation and planning agent | Chosen because it fits existing habits and focuses on the missing layer: facts, interpretation, and next-step judgment |

## 3. AI Product Judgment

Trace treats the agent as an embedded product mechanism, not a personality layer.

The agent is responsible for:

- compressing raw activity into semantic work blocks
- aligning work blocks with Calendar and Reminders context
- generating remaining-day plans with rationale, next action, prep hint, energy level, and priority reason
- comparing suggested plan blocks against actual behavior
- producing structured review output: did, drift, next
- learning from user correction without hiding the rules

The agent is not allowed to:

- silently take over the user's task system
- pretend certainty when context is weak
- overwrite user-edited Calendar events
- generate generic advice without evidence

## 4. Trust Design

The trust mechanism is not "better prompts." It is correctability.

Users can correct work block title, category, activity type, context key, time range, Reminder link, and Calendar link. Corrections update local learned rules so that the system becomes closer to the user's own work semantics over time.

For an AI agent product, this is a senior product decision: user correction is not a secondary editing feature; it is the product's quality improvement loop.

## 5. Technical Product Constraints

The product is shaped by real macOS constraints:

- active-window capture requires careful permission handling
- Calendar and Reminders access can fail, time out, or require fallback
- user-edited Calendar events must not be overwritten
- local activity data is highly private
- local AI summaries should not block core product value
- learned rules must be explainable and resettable

These constraints led to a local-first architecture, conservative fallback behavior, and an explicit separation between implemented beta features and future agent capabilities.

## 6. Evidence in the Repository

| Product capability | Where to review |
|---|---|
| full case study | `docs/portfolio-case-study-en.md` |
| agent architecture | `docs/ai-agent-system-design-en.md` |
| key product decisions | `docs/product-decisions-en.md` |
| Today planning flow | `src/pages/Today.tsx`, `src/utils/planning.ts` |
| work-block aggregation and context matching | `src/utils/workblocks.ts` |
| correction loop and learned rules | `src/pages/Timeline.tsx` |
| macOS Calendar integration | `src-tauri/src/calendar.rs` |

## 7. What This Demonstrates

This project demonstrates:

- senior product judgment under ambiguous scope
- AI agent workflow design beyond a chatbot wrapper
- ability to define product boundaries and non-goals
- human-in-the-loop design for AI trust
- technical collaboration understanding across frontend, desktop runtime, macOS context, and AI fallback
- roadmap thinking from beta reliability to agent quality evaluation
