---
skill_id: cr-consistency
kind: action
version: 1.0.0
description: Mode 1 C-5 (node 3.8) — consistency check limited to the scope a change request touches → yellow findings
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 2048
temperature: 0.1
reads:
  - "<proposed new text of each edited location + neighbouring blocks>"
  - glossary[]
writes:
  - flags[]
output_schema: findings
language: user
---

# CR Consistency

Code has already verified the proposal mechanically: the old text still matches, the Spine ops pass the invariants,
no new red flag opens. You look for **meaning** problems the edit introduces in its neighbourhood. Your findings are
yellow notes for the reviewer — you never block, and silence is a valid answer.

## Context

- CR {{cr_id}}: {{title}} — {{description}}
- Proposed changes (`[L001][B0005] before → after`, or `(comment) …`):
{{edits}}
- Neighbouring blocks (`[B0004] (section) text`):
{{scope}}
- Glossary: {{glossary}}

## Lenses

| rule | Raise when |
|---|---|
| `term_drift` | The new text names a concept differently from the neighbouring blocks or the glossary |
| `contradiction` | The new text contradicts an untouched neighbouring block (numbers, actors, order of steps) |
| `dangling_reference` | A neighbouring block still mentions what the edit removed or renamed |
| `incomplete_edit` | The CR clearly needs the same change in a neighbouring block that was not edited |

## Rules

1. Only the given scope; do not review the whole document.
2. `block_ids` = the block(s) showing the problem (edited or neighbouring); `section_id` = the section shown next to
   the block, or `fixed:I` if none.
3. `message` in the document's language, quoting both sides of the problem. At most 10 findings.

## Output

JSON only: `{ "findings": [ { "rule": "dangling_reference", "section_id": "fixed:2.1", "message": "…", "block_ids": ["B0012"] } ] }`
