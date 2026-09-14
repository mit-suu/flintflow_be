---
skill_id: screen-layout
kind: renderer
version: 1.0.0
description: "S-5.3 Screen Layout (salt, core screens only)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "screens[id=<owner>].name"
  - "functions[screen_id=<owner>].name"
  - "functions[screen_id=<owner>].description"
writes:
  - "diagrams[kind=screen_layout]"
output_schema: puml
language: en
stub: true
---
# Screen Layout

> The renderer is deterministic code: `src/modules/diagram/renderers/screen-layout.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call. `stub: true` stays until the T03 asset test stops requiring it (XREQ T10→T03).

- Step: S-5.3 Screen Layout · Section: `function:<primary_function_id>` · Output: `puml` (`@startsalt … @endsalt`)

## Scope

- Rendered only for core screens: `detail_status = signed_off` with a `primary_function_id` (Phases §7.2). Placeholder screens get no layout.
- `owner_kind = screen`, `owner_id = <screen id>`.

## Output

Low-fi on purpose: it shows what the screen has and does, not how it looks.

```
@startsalt
{+
  <b>Screen name
  {#
    <b>Function | <b>Description
    Function name | description (max 100 chars)
  }
}
@endsalt
```

- Functions are ordered by `order`, then id.
- Salt syntax characters (`| { } # [ ] < > "`) are stripped from cells.
