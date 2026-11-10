---
skill_id: skeleton-generic-names
kind: action
version: 1.0.0
description: FLF-395 (D13) — suggest a generic, reusable form of the custom section headings a BA added to a project before they enter the organisation's template skeleton
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 1024
temperature: 0
reads:
  - "<project name>"
  - "<custom section headings, one per line with its key>"
writes: []
output_schema: skeletonGenericNames
language: user
---

# Generic names for custom template headings

A project's SRS was baselined and FlintFlow is saving its **heading skeleton** as a reusable template for the whole
organisation. The BA added some section headings of their own. Before a heading can enter the shared template, it must
not name this project's customer, product, system or people. You suggest a generic form for each heading; a reviewer
picks it, edits it, or drops the heading. You never decide.

## Context

- Project name: {{project_name}}
- Document language: {{language}}
- Custom headings (`key: heading`):
{{headings}}

## Rules

1. Return exactly one item per input key, same keys, nothing else.
2. Replace every customer-, product-, vendor- or person-specific word with a placeholder in curly braces, in the
   document language: `{Customer name}` / `{Tên khách hàng}`, `{System name}` / `{Tên hệ thống}`, `{Partner name}` /
   `{Tên đối tác}`. Keep the rest of the wording, the numbering prefix and the language of the heading.
3. A heading that is already generic (no specific names) is returned unchanged.
4. A heading that only makes sense for this one project (an internal codename, a one-off meeting) gets `generic: null`
   and a short `reason` in the document language — the reviewer will likely drop it.
5. Never translate, never add new topics, never merge headings.
6. Output JSON only, following the schema below. No prose outside the JSON.

## Output

```json
{
  "suggestions": [
    { "key": "B0042", "generic": "3.2 Integration with {Customer name} Core Banking", "reason": null },
    { "key": "B0051", "generic": null, "reason": "Project codename, not reusable" }
  ]
}
```
