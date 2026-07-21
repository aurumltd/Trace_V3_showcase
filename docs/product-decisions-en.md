# Trace Product Decisions

This document summarizes the product decisions behind Trace. It is written for product reviewers who want to evaluate judgment, tradeoffs, and AI product design depth.

## Decision 1: Do not build another task system

**Problem:** Users already have Calendar, Reminders, Notion, or lightweight task habits. Asking them to migrate into a new system creates high friction.

**Decision:** Trace reads existing planning context instead of replacing it.

**Why it matters:** This keeps adoption lightweight and makes Trace an interpretation layer, not another planning database.

## Decision 2: Start from facts, not self-reporting

**Problem:** Manual time tracking depends on memory and discipline. It also breaks when users are busy.

**Decision:** Trace starts from real activity capture and then aggregates activity into work blocks.

**Why it matters:** The product creates a factual baseline before asking AI to summarize or recommend anything.

## Decision 3: Use AI to interpret work, not just summarize text

**Problem:** Generic AI summaries can sound useful while missing the user's actual plan and execution state.

**Decision:** Trace structures AI around work understanding, planning, execution monitoring, and review.

**Why it matters:** The agent has a product job: convert noisy behavior into plan-aware decisions.

## Decision 4: Make correction a core loop

**Problem:** AI will misread window titles, project context, and user intent.

**Decision:** Users can correct titles, categories, context keys, time ranges, and Calendar / Reminder links.

**Why it matters:** Correction is the trust and learning mechanism. It turns AI mistakes into local learned rules.

## Decision 5: Ground recommendations with context and RAG

**Problem:** Agent suggestions can become generic if they are not grounded in the user's own work evidence.

**Decision:** Use local retrieval / RAG to retrieve relevant work blocks, reminders, calendar constraints, learned rules, and review summaries.

**Why it matters:** Recommendations should explain their evidence instead of appearing as black-box advice.

## Decision 6: Prefer low-confidence fallback over false certainty

**Problem:** Overconfident AI planning can damage trust quickly.

**Decision:** When evidence is weak or tools fail, Trace falls back to explicit rules, cached context, and editable suggestions.

**Why it matters:** The product is safer when it says "I am not sure" and asks for correction instead of forcing automation.

## Decision 7: Keep the product local-first

**Problem:** Work activity data is sensitive. Users may not want raw behavior records sent to third-party systems.

**Decision:** Prioritize local storage, local rules, local context, and local AI summaries where available.

**Why it matters:** Privacy is not only a technical requirement. It shapes the product's trust model and adoption path.

## Decision 8: Separate Today, Timeline, and Review jobs

**Problem:** Productivity products often collapse dashboards, logs, and reviews into the same screen.

**Decision:** Today answers "what now," Timeline answers "what exactly happened," and Review answers "what pattern should I change."

**Why it matters:** Each surface has a distinct user job and agent responsibility.

## Decision 9: Treat implementation status as part of product credibility

**Problem:** AI product portfolios can overstate roadmap concepts as shipped features.

**Decision:** The README separates implemented beta capabilities from designed roadmap items.

**Why it matters:** Clear status boundaries make the product case more credible for senior PM review.
