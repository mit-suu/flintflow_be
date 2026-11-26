---
skill_id: cr-record-summary
kind: action
version: 1.0.0
description: Mode 1 release - rewrite the machine-built description of each change request line in the Record of Changes as one short sentence in the document language
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 2048
temperature: 0.2
reads:
  - "<one line per change request and kind of change: the sentence the code already built, and the list of changes behind it>"
writes: []
output_schema: crRecordSummary
language: user
---

# Record of Changes - concise descriptions

The Record of Changes table of a released SRS has one line per change request and kind of change (`A` added, `M` modified,
`D` deleted). The code already built a plain sentence for each line from the recorded changes. The reviewer asked for a shorter,
more natural wording. Your result replaces the built sentence only when it passes the code checks, otherwise the built
sentence stays, so never invent facts.

## Context

- Document language: {{language}}
- Lines to rewrite, as a JSON array (`cr_id`, `kind`, `built` = the sentence already built, `changes` = the distinct
  changes behind it, each `{ verb, target }`):

Rows:
{{rows}}

## Rules

1. Return exactly one item per input line, same `cr_id` and `kind`, nothing else.
2. One sentence per line, at most 20 words, in the document language. Say **what changed in the document** (for example
   "Add the function to change a delivery address and its confirmation message").
3. Use only what is in `built` and `changes`. Do not guess the reason for the change, do not copy chat sentences, do not mention the change
   request itself, and do not start with the `CR-xxx:` prefix (the code adds it).
4. Keep names exactly as given. Document codes such as `UC-05` or `BR-03` may stay. Never print internal ids (`FN045`, `S03`, `A04`).
5. A line of kind `A` only adds, `D` only deletes, `M` only modifies - the verb must match the kind.
6. No em dash, no quotes around the whole sentence, no trailing full stop needed.
7. Output JSON only, following the schema below. No prose outside the JSON.

## Output

```json
{
  "rows": [
    { "cr_id": "CR-004", "kind": "A", "text": "Add the Send Reminder use case" },
    { "cr_id": "CR-004", "kind": "D", "text": "Delete the message about expired sessions" }
  ]
}
```
