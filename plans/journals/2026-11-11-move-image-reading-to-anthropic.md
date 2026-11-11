---
title: Move image reading to Anthropic
date: 2026-11-11
summary: Switch import and CR image actions to Claude while preserving other AI routes
---

# Move image reading to Anthropic

Changed only the two image-reading actions (import diagrams and CR materials) to Anthropic claude-haiku-5-5. Added base64 PNG/JPEG payload support while preserving the exact text-only request shape. Missing Anthropic keys retain the import fallback, and HTTP 529 remains eligible for image rereading. Text action configurations, Gemini embeddings, response schemas, and credit prices are unchanged.

Validation: 263 affected unit tests and 23 integration tests passed; npm run typecheck and git diff --check passed. Review found no remaining issues. No live Anthropic API call was made. Runtime requires ANTHROPIC_API_KEY and a backend/worker restart to reload assets.

Local dependencies were synchronized with npm ci --ignore-scripts after the develop pull; package.json and package-lock.json are unchanged. An initial install without lockfile resolution selected newer dependencies and produced type errors; restoring the lockfile versions resolved them. Existing unrelated local files were preserved. No commit or push was performed.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
