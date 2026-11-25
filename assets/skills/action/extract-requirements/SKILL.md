---
skill_id: extract-requirements
kind: action
version: 2.0.2
description: Business-flow §3.6.1 - read a raw reference document (minutes, email, notes) and extract a list of requirements, each pointing to its source paragraph, labelled against the current SRS
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 16384
temperature: 0
reads:
  - "<reference document text with paragraph codes [D1-P03], one part of the document per call>"
  - "<SRS elements code found for each paragraph (name / code mentions, keywords, meaning)>"
  - "<Spine projection: named elements of the current SRS>"
  - project.goals
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

- Document: {{document_name}} (code {{doc_code}}). {{part}}
- Document text, one paragraph per line, each prefixed with its paragraph code:
{{document}}
- SRS elements the server already found for these paragraphs (by name / code mention, keywords, or meaning). Use them to
  pick the label; they are candidates, not proof:
{{candidates}}
- Current SRS - index of named elements (actors, use cases, functions, screens, rules, NFRs…) and related rules:
{{projection}}
- Project goals (may be empty):
{{goals}}
- Glossary:
{{glossary}}
- Output language: {{output_language}}. Every text you write (`text`, `situation` texts, `symptom`, `root_cause`,
  `rationale`, option `label` / `description` / `pros` / `cons` / `risks`, `recommendation_reason`, `question`,
  `suggested_answers`) is in this language, even when the document or the SRS index uses another one. Quotes stay verbatim.

## Rules

1. One item per requirement. A requirement is a statement the system must satisfy or a change someone asked for - not a
   decision about the meeting, not a greeting, not a date. Keep the requirement's own wording; write `text` in the
   output language, one or two sentences, measurable when the source gives a number.
2. `source.para_id` is the exact paragraph code the requirement comes from (`D1-P03`); `source.quote` is the verbatim
   sentence(s) from that paragraph, at most 300 characters. Never invent a code; never quote text that is not there.
3. Exactly one `label` per item:
   - `new` - nothing in the SRS covers it ⇒ becomes a change.
   - `modification` - it changes an existing element ⇒ becomes a change; list the element paths in `entity_paths`
     (`use_cases[id=UC-01]`, `nfrs[id=NFR-02]`, `actors[id=A02]`…) taken from the candidates or the index.
   - `duplicate` - the SRS already states it; no change, the document just becomes a source for that element -
     list the element in `entity_paths`.
   - `contradiction` - it conflicts with an element, with another requirement in this document (two people saying
     opposite things), or with another document ⇒ ask the BA. Fill `question` (one sentence, in the output
     language), 2–4 `suggested_answers`, and `sides`: one entry per side with `speaker`, `para_id` and the verbatim `quote`.
     One disagreement is **one** item with every side in `sides` - never one item per speaker with the same question.
   - `ambiguous` - not measurable, no milestone, or no actor ⇒ ask the BA. Fill `question` and `suggested_answers`.
   - `inferred` - the document does not ask for it, but a problem it mentions implies a need ("CS spends the whole
     morning searching Excel" ⇒ order status lookup; "we open a branch in Da Nang next month" ⇒ multi-branch). Fill
     `inference` (rule 6). Never use `inferred` for something the document says outright.
   Labels are suggestions; the BA decides. Never raise a red flag - only code does.
4. `speaker`: the person who said it, only when the document names them (minutes, transcript: "Anh A:", "Lan said").
   Otherwise `null`. Never guess a speaker from a role or tone.
5. Requirements that touch the same element or depend on each other share a `group` (short id such as `G1`); every
   item has a group, a lone requirement is its own group. Groups become one change request each; the BA can split them.
6. `inference` (only for `inferred`, otherwise `null`):
   - `symptom` - the problem as the document states it; `symptom_quote` - the verbatim sentence, and `symptom_para_id`
     its paragraph code. No quote, no item: if you cannot quote the symptom, drop the item.
   - `root_cause` - why the problem happens; `rationale` - why it implies this need.
   - `options` - exactly 2 ways to meet the need, each with a short `label`, optional `description`, and `pros`,
     `cons`, `risks` (risks / assumptions), concrete to this project, not generic advice.
   - `recommended` - index (0 or 1) only when you are sure, backed by the document, the SRS or a project goal; then
     `recommendation_reason` names that ground. Not sure ⇒ `recommended: null`, `recommendation_reason: null`.
   - `serves_goal` - the project goal it serves, copied verbatim from the goals above; `null` when there are no goals
     or none fits.
   - `text` of the item is the inferred need in one sentence; `source` points to the symptom paragraph.
7. `situation` (once per answer): how things work today (`current`) and how they should work (`desired`), each point a
   short `text` with `para_id` and verbatim `quote`. Only points the document states; empty lists when it says nothing.
8. No limit on the number of items. List each requirement once: if two sentences say the same thing, keep one item.
   Put the requirements the document states first, `inferred` items after them.
9. Output JSON only, following the schema below. No prose outside the JSON.

<!-- ba-quality:shared:start -->
**Analysis quality** - applies to every finding, gap, proposed change, recommendation and reason you write (not to the plain answer options of a question):
- **(a) Quote it or drop it.** Each one rests on words you can copy verbatim from the uploaded documents, the Brief, the current SRS content or the user's messages. Where the output has a quote or source field, put that exact text there. Nothing to quote ⇒ do not raise it.
- **(b) Never ask what is already answered** - in the documents, the Brief, the SRS content, a settled decision or an earlier answer.
- **(c) Recommend only when you are sure**: a clear basis in the documents, the Brief, the SRS content or a settled decision. A recommendation always states its reason and that basis. Not sure ⇒ give the options side by side, with no recommendation.
- **(d) Specific to this project, never generic advice**: name the screen, role, data or rule it is about.
  - Fails: "nên cân nhắc bảo mật" (consider security).
  - Passes: "màn đối soát hiện số tiền, nên chỉ cho vai Kế toán xem" (the reconciliation screen shows amounts, so only the Accountant role should see it).
<!-- ba-quality:shared:end -->
## Output

```json
{
  "situation": {
    "current": [{ "text": "Finance exports reports by hand.", "para_id": "D1-P02", "quote": "Today we copy every report into Excel." }],
    "desired": [{ "text": "Reports export to CSV directly.", "para_id": "D1-P03", "quote": "Finance asked that every report can be exported to CSV." }]
  },
  "requirements": [
    {
      "id": "R1",
      "text": "Reports must be exportable to CSV for the finance team.",
      "source": { "para_id": "D1-P03", "quote": "Finance asked that every report can be exported to CSV." },
      "label": "new",
      "entity_paths": [],
      "group": "G1",
      "speaker": "Lan",
      "sides": [],
      "inference": null,
      "question": null,
      "suggested_answers": []
    },
    {
      "id": "R2",
      "text": "Customer service can look up an order's status by order number.",
      "source": { "para_id": "D1-P05", "quote": "CS spends the whole morning searching the Excel file." },
      "label": "inferred",
      "entity_paths": [],
      "group": "G2",
      "speaker": null,
      "sides": [],
      "inference": {
        "symptom": "CS spends a whole morning finding order status in Excel.",
        "symptom_quote": "CS spends the whole morning searching the Excel file.",
        "symptom_para_id": "D1-P05",
        "root_cause": "Order status lives only in a shared spreadsheet.",
        "rationale": "A lookup screen removes the manual search.",
        "options": [
          { "label": "Order lookup screen for CS", "description": null, "pros": ["Answers a customer in seconds"], "cons": ["New screen to build"], "risks": ["Assumes order data is already in the system"] },
          { "label": "Import the Excel file nightly", "description": null, "pros": ["Little change for CS"], "cons": ["Status up to a day old"], "risks": ["Excel layout may change"] }
        ],
        "recommended": null,
        "recommendation_reason": null,
        "serves_goal": null
      },
      "question": null,
      "suggested_answers": []
    }
  ]
}
```
