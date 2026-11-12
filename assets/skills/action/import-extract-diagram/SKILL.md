---
skill_id: import-extract-diagram
kind: action
version: 1.2.2
description: Mode 1 I-4 (images) - classify one diagram image of an imported SRS section and extract the Spine entities it shows
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 8192
temperature: 0.1
reads:
  - "<one attached image (PNG/JPEG) from the section, with its block id and caption>"
  - "<field list of the entities a diagram can show>"
  - "<keys already extracted in earlier sections and from the section text>"
writes:
  - "<actors, use_cases, entities, screens, functions[].interactions / .activity_nodes / .activity_flows (via code-built ops after user confirmation)>"
output_schema: importExtractDiagram
language: user
---

# Read Diagram Image

You look at **one image attached to this message**. It comes from a section of an existing SRS that a user uploaded.
If it is a diagram, you return what it shows as Spine **entities**. The image is the source of truth: you copy the
labels exactly as drawn, you never invent elements, arrows or names that you cannot read.

## Context

- Section (registry id): {{section_id}} - heading as written: {{heading_text}}
- Image block: [{{block_id}}] - caption / text next to it: {{caption}}
- Fields you may fill (names and enums):
{{schema_excerpt}}
- Keys already used that this image may refer to (a relevant subset, not every element) - reuse them to refer to the
  same element, never create a duplicate:
{{known_keys}}

## Step 1 - classify

`diagram_kind`:

- `usecase` - UML use case diagram: stick-figure actors, ovals, system boundary, `<<include>>` / `<<extend>>` arrows.
- `erd` - entity–relationship / class / database diagram: boxes with attributes, relationship lines.
- `screen_flow` - screens (boxes or wireframes) connected by navigation arrows.
- `context` - system context diagram: the system in the middle, external actors / systems around it.
- `sequence` - UML sequence diagram: lifelines (stick figure / boxes) with vertical dashed lines, horizontal numbered
  messages between them, `alt` / `opt` frames.
- `activity` - UML activity diagram (or a flowchart of one process): solid start dot, rounded action boxes, diamonds,
  thick fork / join bars, end bullseye, often vertical swimlanes with an actor name on top.
- `deployment` - UML deployment diagram: 3D boxes (nodes, `<<device>>`, `<<executionEnvironment>>`) possibly nested,
  components / artifacts inside them, plain lines between boxes labelled with protocols.
- `other` - anything else (screenshot of one screen, logo, photo, chart, state machine, component diagram, unreadable
  or blurry image). For `other` return `items: []` - code keeps the original image in the document.

## Step 2 - extract (only for the seven diagram kinds)

1. One `item` per element you can read:
   - `usecase`: every actor ⇒ `actors` (`kind`: `human`, or `system` for an external system / service);
     every oval ⇒ `use_cases` with `actor_ids` = the actors linked to it by a plain line.
     A solid line between two **actors** ending in a hollow triangle is a generalization: the actor at the triangle is
     the general one, the actor at the other end inherits from it ⇒ the inheriting actor gets `parent_id` = the general
     actor (`Customer --▷ Guest` ⇒ Customer `parent_id: "Guest"`). Only human ↔ human; no triangle visible ⇒ no `parent_id`.
     `<<include>>` / `<<extend>>` are dashed arrows: find the **arrowhead** first; the oval at the other end is the tail.
     The relation always goes on the **tail** oval and names the oval at the **arrowhead**; the arrowhead oval gets nothing.
     - `Checkout - - <<include>> - -> Pay` ⇒ Checkout `includes` ["Pay"] (the base includes the part it always runs).
     - `Apply Coupon - - <<extend>> - -> Checkout` ⇒ Apply Coupon `extends` ["Checkout"] (the extension names its base).
     - An oval that lists **extension points** is a base: every use case named there `extends` it.
     - Never give the same two ovals a relation in both directions; if you cannot see which end has the arrowhead,
       leave the relation out.
   - `erd`: every box ⇒ `entities` with `relations` = the entities it is connected to.
   - `screen_flow`: every screen ⇒ `screens` with `flow_to` = one `{ "to": <screen>, "trigger": <label written on the arrow, if any>, "guard": <text in [brackets] on a branch leaving a diamond, without the brackets, if any> }` per outgoing arrow (a diamond is not a screen: the screen before it is the source, each branch's target is `to`).
   - `context`: every external party ⇒ `actors` (`human` or `system`), never the system itself (the circle / centre box).
     Each arrow between the party and the system carries data: arrowhead at the **system** ⇒ its label goes in that
     actor's `flows_in`; arrowhead at the **party** ⇒ `flows_out`. One string per arrow, the label exactly as written
     (`"orders, payments, returns"` stays one string). Read every arrow - a party usually has one in AND one out; never
     drop one direction, never invent a label for an arrow you cannot read. A line with arrowheads at both ends ⇒ its
     label in both lists. The label of the system circle is the system name: return it as a `project` item
     `{ "system_name": <label> }` (key `null`).
   - `deployment`: every 3D box ⇒ `deployment_nodes` (`kind`: `device` for `<<device>>` / hardware, `execution_environment`
     for `<<executionEnvironment>>` / OS / runtime / container / database server, else `node`); `parent` = the name of
     the box it is drawn inside (or null); `components` / `artifacts` = names of the component / artifact shapes inside it.
     The smaller / grey text under a box's bold name is that node's `description` (who uses it, its role, properties):
     one string exactly as written, never split on commas, never turned into components. Box "Trình duyệt" with
     "GV, phụ huynh" under it ⇒ `{ "name": "Trình duyệt", "description": "GV, phụ huynh", "components": [] }`; likewise
     "Reverse proxy" / "TLS, ép HTTPS", "Web Server" / "public, port 443". `components` / `artifacts` only for named
     software units drawn as UML component (box with the two-tab icon or `<<component>>`) / artifact (document icon or
     `<<artifact>>`) shapes, or a list labelled as components / artifacts - otherwise `[]`.
     `links` = one `{ to: <other box name>, protocol: <label on the line> }` per line leaving this box (each line once).
   - `sequence` describes **one function** (the section's function, or the function / use case named in the caption or
     title): return **one** `functions` item whose `key` is that function's key from *Known keys* (never a new function; no
     matching function ⇒ `diagram_kind: "other"`, `items: []`). Its `value` holds only `interactions`: one
     `{ from, to, message, kind, flow, guard? }` per arrow, top to bottom. `from` / `to` = the actor key or name as drawn,
     or `"system"` for the system lifeline (Frontend, Backend, Server, Database all count as `"system"`; a message between
     two of them is skipped). `kind`: `request` solid arrow, `response` dashed return arrow. Messages of an `alt` / `opt`
     branch other than the main success branch ⇒ `flow: "abnormal"`, `guard` = the condition without brackets. `message` =
     the label without its number (`1.2:`), no `,` `[` `]`.
   - `activity` describes **one use case** (named in the caption / title, or the use case whose functions include the
     section's function): return **one** `use_cases` item whose `key` is that use case's key from *Known keys* (never a new
     use case; none matches ⇒ `diagram_kind: "other"`, `items: []`). Its `value` holds only `activity_nodes` +
     `activity_flows`. Node `{ id: "N1", "N2"… (your local ids), kind, name?, lane? }`: `initial` (solid dot), `final`
     (bullseye), `action` (rounded box, `name` = its text), `decision` (diamond with ≥ 2 outgoing arrows, `name` = the
     question if written), `merge` (diamond that only joins), `fork` / `join` (thick bar). `lane` = the actor name on top of
     the swimlane, or `"system"` for a System lane; no swimlanes ⇒ no `lane`. Flow `{ from, to, guard? }` per arrow with
     your local ids; `guard` = the `[condition]` on the arrow, without brackets.
2. `key` = the code written in the image (`UC-01`, `SCR-02`) exactly as written, or a key from *Known keys* when the
   element is clearly the same one (same name). `null` when there is none - code assigns one. Never put the element's
   name in `key`.
3. References (`actor_ids`, `includes`, `extends`, `relations`, `flow_to`, interaction ends, lanes) use keys from *Known keys* or, for elements
   without a key, their **name as drawn** - code resolves names.
4. `value` holds only what the image shows (usually just `name` and the references). No descriptions you made up (a description written in the image, like a node subtitle, is fine).
5. `source_block_ids`: always `["{{block_id}}"]`.
6. `confidence` in [0, 1]: at most 0.7 - reading an image is never as sure as reading text; 0.5 or less when a
   label is small, cut off or ambiguous. The user confirms every item before it enters the Spine.
7. `unmapped_block_ids`: `[]`.

## Output

JSON only, no prose:

```json
{ "section_id": "fixed:2.2.1",
  "diagram_kind": "usecase",
  "items": [
    { "entity": "actors", "key": null, "value": { "name": "Learner", "kind": "human" },
      "confidence": 0.7, "field_confidence": {}, "source_block_ids": ["B0012"] },
    { "entity": "use_cases", "key": "UC-02", "value": { "name": "Log in", "actor_ids": ["Learner"], "includes": [], "extends": [] },
      "confidence": 0.65, "field_confidence": {}, "source_block_ids": ["B0012"] }
  ],
  "unmapped_block_ids": [] }
```
