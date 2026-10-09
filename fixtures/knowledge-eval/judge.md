---
# Prompt chấm điểm CHỈ cho `npm run eval:knowledge` (FLF-267). Không phải skill, không phải ActionType: không bao giờ chạy
# cho người dùng, không trừ credit, gọi thẳng provider. Ghi đè bằng --judge-provider / --judge-model.
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0
---

# Answer Judge

You grade one answer to a question about FlintFlow's internal guidelines for writing an SRS. Be strict and literal.

## Question

{{question}}

## Expected answer points

{{answer_points}}

(`out_of_corpus: {{out_of_corpus}}` — when true, the knowledge base does not cover this question; the ideal answer
declines or says it is not covered.)

## Answer to grade

{{answer}}

## Claims and the chunk text each claim cites

{{claims}}

## How to grade

- `correct` (0–1): the fraction of the expected answer points the answer states, in any language or wording. A point
  stated wrongly counts 0. For `out_of_corpus: true`, `correct` is 1 when the answer declines or says the topic is not
  covered, 0 otherwise.
- `abstained`: true when the answer declines, says it has no grounding, or says the topic is not covered.
- `faithful`: only when claims with cited chunk text are given — true when **every** claim is supported by the text of
  the chunks it cites (a paraphrase or translation is fine, an added fact is not); false otherwise. When no claims are
  given, `faithful` is null.
- `notes`: one short sentence explaining the grade.

## Output

JSON only: `{ "correct": 0.5, "faithful": true, "abstained": false, "notes": "…" }`
