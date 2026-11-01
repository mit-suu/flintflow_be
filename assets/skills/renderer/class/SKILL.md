---
skill_id: class
kind: renderer
version: 1.0.0
description: "S-4.5 Class Diagram, domain level (UML 2.5.1, SVG built in code: one diagram per feature at the head of §3.x)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "entities[].name"
  - "entities[].attributes"
  - "entities[].feature_ids"
  - "entities[].relations"
  - "entities[].relation_verbs"
  - "entities[].relation_cardinality"
  - "entities[].relation_optional"
  - "features[].name"
  - "features[].order"
writes:
  - "diagrams[kind=class]"
output_schema: none
language: en
stub: false
---
# Class

> The renderer is deterministic code: `src/modules/diagram/renderers/class.renderer.ts` (data, splitting) and `class-layout.ts` (boxes, relations) on the shared grid placer / orthogonal router (`orthogonal-place.ts`, `orthogonal-route.ts`, `orthogonal-ends.ts`). There is no `puml` source, so `render_fix` never applies. This skill documents the output.

- Step: S-4.5 · Section: `feature:<id>` (head of §3.x) · `owner_kind = feature`, `owner_id` = feature id · Output: `svg`
- IEEE 830 Annex A.3 (organised by object), optional. **Analysis (domain) level**: business classes and attributes, no data types, no methods. The design-level class diagram (stereotypes, operations, visibility) is Report 4 / IEEE 1016 and is a different artifact.
- Nothing is invented: every class is an `entities[]` element, every attribute an `attributes[]` element, every line a `relations[]` id.

## Data → diagram

- One diagram per feature that has entities (features by `order`). An entity belongs to a diagram when its `feature_ids` contains the feature; one entity may appear in several diagrams. An entity with no feature (old Spine, import mode 1) has no class diagram. Relations to entities of another feature are not drawn here (the ERD shows them).
- Class box, 2 compartments: bold name (≤ 2 lines), then attributes, one per line, left aligned. A class without attributes shows the name compartment only. No operation compartment.
- Attribute text: `name`, then ` {id}` for `kind = key`, ` {ref}` for `reference`, then ` [0..1]` when `required = false`. Long text is cut with `...`.
- Relation per `relations[]` id: association, solid line, no arrowhead, id `<parent>><child>`. Association name = `relation_verbs[<child>]` (`has` when missing), on the line. Multiplicity at both ends: parent `1`, or `0..1` when the child is in `relation_optional`; child `*` for `relation_cardinality` `N` (default), `0..1` for `1`. The minimum on the child side is not in the Spine, so it is 0.
- Aggregation (hollow diamond at the whole), composition (filled diamond) and generalization (hollow triangle at the parent class) are supported by the drawing code but the Spine has no data for them, so none is generated.

## Layout

- Grid placement by parent → child rank; right-angle lines only (`allowBends`), straight when nothing is in the way, otherwise L / Z / U bends. No line through a shape or text, no overlapping lines (`checkScene` issues must be empty). Self relations are a small U loop on one side.
- More than 25 classes in a feature ⇒ split (connected components packed, a larger one cut breadth-first, relations across a cut not drawn); a diagram that fails the geometry check is split again. Title `Class Diagram — <feature> (i/n)`; the first part of each feature keeps the original diagram id.
- All fills `#7ACFF5`, stroke / text black. Samples: `docs/diagram_guideline/class/`, `docs/diagram_image_test/class/`.
