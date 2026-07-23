# Trace Product Decision Log

This document records only the critical trade-offs to avoid repeating the full case. See the [Product Case Study](portfolio-case-study-en.md) for problem context, implementation status, and evaluation.

## Decision 1: Do Not Build Another Task System

- **Alternative:** Add native tasks, calendar, team collaboration, and full planning workflows
- **Choice:** Read Calendar and Reminders, then add facts, interpretation, and next-step support
- **Reason:** Reduce migration cost and focus on the work-replay gap existing tools do not solve
- **Cost:** Context quality depends on system permission and external-data completeness

## Decision 2: Form Work Blocks Before Generating Advice

- **Alternative:** Send raw activity directly to an LLM for summarization
- **Choice:** Use deterministic logic to create reviewable work blocks before planning and review
- **Reason:** Raw events are too noisy to support stable explanation, correction, and evaluation
- **Cost:** Aggregation rules, boundary tests, and correction mechanisms must be maintained

## Decision 3: Embed the Agent in the Workflow Instead of Leading with Chat

- **Alternative:** Build a productivity-coach chat window
- **Choice:** Place perception, planning, observation, and review inside Today, Timeline, and Review
- **Reason:** Users need continuous context and actionable state, not a one-shot conversation
- **Cost:** Every surface needs a distinct job and structured output

## Decision 4: Make Correction the Trust and Learning Loop

- **Alternative:** Allow editing only the currently displayed result
- **Choice:** Update the record and save visible, resettable local rules
- **Reason:** The same mistake should not require repeated correction, and users must control learning
- **Cost:** Rule conflict, unlinking, and incorrect-rule accumulation require explicit handling

## Decision 5: Treat the Local Model as an Enhancement, Not a Dependency

- **Alternative:** Require an LLM for every plan and review
- **Choice:** Use a local model for structured output while preserving deterministic plans and template fallback
- **Reason:** The model may be absent, slow, or invalid; core value must remain available
- **Cost:** Two paths must be maintained with consistent semantics

## Decision 6: Treat RAG as the Next Evidence Layer, Not a Current Implementation Claim

- **Alternative:** Describe any historical-data access as RAG
- **Choice:** Call the current mechanism explicit context and rules; reserve vector retrieval, top-k evidence, and citations for the designed roadmap
- **Reason:** Technical terms must map to real mechanisms, not inflate roadmap work into shipped capability
- **Cost:** Current personalization relies mostly on rules and limited historical context

## Decision 7: Optimize Automatic Linking for Precision

- **Alternative:** Match every work block to a plan whenever possible
- **Choice:** Keep an Unknown state when evidence is weak and support manual link/unlink
- **Reason:** A false link contaminates plan comparison and long-term review, damaging trust more than a missing link
- **Cost:** Early coverage is lower and some results require confirmation

## Decision 8: Separate Implemented, Designed, and Unvalidated Work

- **Implemented:** Beta code and working flows
- **Designed:** System specifications for RAG and evaluation not yet completed
- **Unvalidated:** User value, long-term permission retention, retention, and productivity impact
- **Reason:** AI portfolio credibility comes from evidence boundaries, not the number of capability labels
