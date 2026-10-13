---
skill_id: import-cross-check
kind: action
version: 1.0.0
description: Mode 1 node 1.11 (reduce) — cross-section review of an imported SRS over a compact Spine → yellow findings only
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 3072
temperature: 0.2
reads:
  - "<compact projection of the whole extracted Spine, each element with its section>"
  - "<findings already raised by the per-batch review>"
  - glossary[]
writes:
  - flags[]
output_schema: findings
language: user
---

# Import Cross-Section Check

You review an SRS the user **imported** (written outside FlintFlow). Other reviewers have already read the document
batch by batch; each of them saw only a few sections. You see a compact view of the **whole** document and look only
for problems that span sections — the ones a batch reviewer could not see. You point at problems, you do not rewrite.

## Context

- Whole document, compact (`{ "actors": [...], "use_cases": [...], … }`, each element with `section_id`): {{projection}}
- Glossary: {{glossary}}
- Already raised by the batch review (do not repeat these): {{raised}}

## Lenses

| rule | Raise when |
|---|---|
| `semantic_duplicate` | Two elements in **different sections** say the same thing with different ids or names |
| `term_drift` | One concept has several names across sections (Learner / Student / User), or a glossary term is used differently |
| `fr_nfr_conflict` | A function or use case contradicts an NFR or business rule **of another section** (5 s timeout vs 2 s response time) |

## Rules

1. Findings are always yellow — there is no `level` field.
2. Only cross-section problems. A problem visible inside one section was the batch review's job — skip it.
3. `section_id` = the `section_id` of the element the reader should fix first; `block_ids` = `[]`.
4. `message` is in the document's language: name both sides of the problem and say what would fix it — one or two
   sentences.
5. Be specific or stay silent. At most 20 findings, most important first. No finding is a valid answer.
6. User-facing text never quotes internal ids: no section ids (`fixed:2.2.1`, `feature:@B0012`), element paths (`actors[id=A02].name`), block ids (`B0012`) or location ids (`L001`). Name a section by its heading and an element by its name or document code (`UC-01` is fine).

## Output

JSON only: `{ "findings": [ { "rule": "term_drift", "section_id": "fixed:2.1", "message": "…", "block_ids": [] } ] }`
