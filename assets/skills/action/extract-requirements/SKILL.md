---
skill_id: extract-requirements
kind: action
version: 1.0.0
description: Business-flow §3.6.1 — read a raw reference document (minutes, email, notes) and extract a list of requirements, each pointing to its source paragraph, labelled against the current SRS
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0
reads:
  - "<reference document text with paragraph codes [D1-P03]>"
  - "<Spine projection: named elements of the current SRS>"
  - glossary[]
writes: []
output_schema: extractRequirements
language: user
---

# Extract requirements from a raw document

A raw document (meeting minutes, stakeholder email, transcript, notes) was attached to a baselined SRS. You read it once and
return the **list of requirements it contains**, each pointing back to the paragraph it came from, each labelled against
the current SRS. A business analyst (BA) reviews your list and decides what becomes a change request. You never write edits.

## Context

- Document: {{document_name}} (code {{doc_code}})
- Document text, one paragraph per line, each prefixed with its paragraph code:
{{document}}
- Current SRS — index of named elements (actors, use cases, functions, screens, rules, NFRs…) and the elements the document mentions:
{{projection}}
- Glossary:
{{glossary}}

## Rules

1. One item per requirement. A requirement is a statement the system must satisfy or a change someone asked for — not a
   decision about the meeting, not a greeting, not a date. Keep the requirement's own wording; write `text` in the
   document's language, one or two sentences, measurable when the source gives a number.
2. `source.para_id` is the exact paragraph code the requirement comes from (`D1-P03`); `source.quote` is the verbatim
   sentence(s) from that paragraph, at most 300 characters. Never invent a code; never quote text that is not there.
3. Exactly one `label` per item:
   - `new` — nothing in the SRS covers it ⇒ becomes a change.
   - `modification` — it changes an existing element ⇒ becomes a change; list the element paths in `entity_paths`
     (`use_cases[id=UC-01]`, `nfrs[id=NFR-02]`, `actors[id=A02]`…) taken from the index.
   - `duplicate` — the SRS already states it; no change, the document just becomes a source for that element —
     list the element in `entity_paths`.
   - `contradiction` — it conflicts with an element, with another requirement in this document, or with another
     document ⇒ ask the BA. Fill `question` (one sentence, in the document's language) and 2–4 `suggested_answers`.
   - `ambiguous` — not measurable, no milestone, or no actor ⇒ ask the BA. Fill `question` and `suggested_answers`.
   Labels are suggestions; the BA decides. Never raise a red flag — only code does.
4. Requirements that touch the same element or depend on each other share a `group` (short id such as `G1`); every
   item has a group, a lone requirement is its own group. Groups become one change request each; the BA can split them.
5. At most 40 items. Skip exact repeats of a requirement already listed (keep the first, add nothing).
6. Output JSON only, following the schema below. No prose outside the JSON.

## Output

```json
{
  "requirements": [
    {
      "id": "R1",
      "text": "Reports must be exportable to CSV for the finance team.",
      "source": { "para_id": "D1-P03", "quote": "Finance asked that every report can be exported to CSV." },
      "label": "new",
      "entity_paths": [],
      "group": "G1",
      "question": null,
      "suggested_answers": []
    }
  ]
}
```
