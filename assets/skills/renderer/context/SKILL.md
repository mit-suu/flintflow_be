---
skill_id: context
kind: renderer
version: 1.7.1
description: "S-2.5 System Context Diagram (level-0 data flow: system circle, actor rectangles)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "project.system_name ?? project.name"
  - "actors[].name/.kind/.flows_in/.flows_out"
  - "use_cases[].name/.actor_ids"
writes:
  - "diagrams[kind=context]"
output_schema: puml
language: en
stub: false
---
# Context

> The renderer is deterministic code: `src/modules/diagram/renderers/context.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call.

- Step: S-2.5 System Context Diagram (re-rendered at S-3.6) · Section: `fixed:1` · Output: `puml`

## Output

- Level-0 data-flow style, rendered as Graphviz DOT inside `@startdot` / `@enddot`. The system is a compact true circle (`shape=circle`, equal width/height) in the centre (label `project.system_name ?? project.name`, alias `SYSTEM_`). Its default radius is 100 points; it grows only for the system title or enough distinct attachment points, never to match the actors' label lanes.
- One plain box per actor (every kind, no stereotype), alias = actor id.
- Place actors by the number of resolved in/out pairs (after filling missing counterparts and use-case fallbacks). ONE pair ⇒ distribute evenly TOP/BOTTOM by actor id, choosing the row with fewer actors (ties ⇒ top). TWO or more ⇒ LEFT/RIGHT, choosing the side with fewer total pairs so far (id order, ties ⇒ left). Never choose positions from actor kind, raw array length or a fixed actor-count cutoff.
- `context-layout.ts` computes fixed actor positions, separate attachment points, explicit cubic Bézier controls and label positions. Use `layout=nop2`, `pin=true`, `overlap=true` and `splines=true` to preserve the supplied paths. Node `pos`, edge `pos` and label `lp` are in POINTS; node width/height remain in inches. Arrows fan inward from the spread-out actor ports to compact, distinct ports on the circle. Keep the controls in disjoint sectors and preserve each arrow's own ports; never merge ports to create the curves.
- Each arrow is ONE gentle quadratic arc, converted exactly to cubic controls for DOT. Both controls stay on the same side of the chord: no S bends, waves or curvature reversals. The renderer splits the curve before the arrowhead without changing its shape.
- Each `flows_in[i]` / `flows_out[i]` pair gets its OWN two visible arrows, with ONE label directly on each arrow. N pairs ⇒ N in-arrows + N out-arrows. Zero-size invisible point nodes attach each arrow exactly to the shape borders; every arrow has unique ports. These nodes add no flows. Do not add hidden edges or separate label carriers. The edge attributes `actor_id`, `flow` and `pair_index` identify the exchange.
- S-2.3 and S-3.1/S-3.2/S-3.3 write equal-length `flows_in`/`flows_out` lists with one exchange per item; the matching request/result or acknowledgement is at the same index. Prefer these project-specific labels; preserve all explicit labels apart from sanitisation.
- Legacy data with unequal list lengths or blank items is paired by ORIGINAL index before filtering: missing output gets `Response to <input>`; missing input gets `Acknowledgement of <output>`. Skip an index only if BOTH labels are empty/whitespace. This balances every pair and preserves the remaining explicit labels; the generic display fallbacks do not mutate the Spine or confirm new business requirements.
- Neither list ⇒ every participating use case (sorted by id) supplies `<use case> request` and `<use case> result`. For `human`/`time`, requests go in and results go out; for `system`, requests go out and results come in. No use cases ⇒ `<actor name> interaction request/result` (`Scheduled task request/result` for time actors), so both arrows still have labels.
- Labels: show ALL flow names, exactly one requirement/output per arrow. Never join multiple labels on an arrow, truncate them or emit `+ N more`.
- Wrap long labels at word boundaries without truncating their content; wrapping one requirement over several typography lines still labels only one arrow. Actor spacing and size grow with label size and pair count. Flow labels use a borderless white HTML table on the edge so a curved stroke cannot run through the letters; escape `&`, `<` and `>` in their text. The table contains exactly one requirement/output, with `<BR/>` for typography only.
- Use a white background, a light slate system fill, slate arrows/text, generic `sans-serif` font (14 for actors, 12 for edge labels, 18 for the system), and no shadows. The system has an unpadded label; its dimensions come from the computed geometry.
- Elements are sorted by id, so the same Spine always yields the same text.

## When it re-renders

The `source_hash` covers `project.system_name ?? project.name`, `actors[].name/.kind/.flows_in/.flows_out` and `use_cases[].name/.actor_ids`. Editing any description does not re-render. S-3.1 adds human actors and use cases, so the diagram drawn at S-2.5 goes stale and S-3.6 re-renders it.
