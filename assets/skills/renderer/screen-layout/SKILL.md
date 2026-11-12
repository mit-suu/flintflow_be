---
skill_id: screen-layout
kind: renderer
version: 3.1.0
description: "S-5.3 Screen Layout - the model describes one screen as a JSON ScreenSpec; code draws the web / mobile mockup in the project theme"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.2
reads:
  - "project.system_name"
  - "project.form_factor"
  - "screens[id=<owner>].name"
  - "screens[id=<owner>].description"
  - "screens[id=<owner>].is_popup"
  - "screens[id=<owner>].tabs"
  - "screens[id=<owner>].flow_to"
  - "functions[screen_id=<owner>].name"
  - "functions[screen_id=<owner>].trigger"
  - "functions[screen_id=<owner>].description"
  - "functions[screen_id=<owner>].validations"
writes:
  - "diagrams[kind=screen_layout]"
output_schema: renderFix
language: en
stub: false
---
# Screen Layout

You describe **one** screen as a JSON **ScreenSpec**: what the user sees and can do, top to bottom. Code turns the
spec into the mockup under §3.x.y of the SRS: browser frame for web, phone frame for mobile, header in the
project's brand colour, boxed inputs, solid / outlined buttons. Colours, pixels, fonts and the domain are the
project theme, **never** yours. Code calls you from `src/modules/diagram/screen-layout.ai.ts` (call kind
`render_fix`); a spec that fails the schema falls back to a plain `Function | Description` table. You write
nothing into the Spine.

## Input

A JSON object:
- `system_name` (may be null), `form_factor[]`, `allowed_platforms[]` (`web` / `mobile`: the platforms this
  project ships).
- `screen` (`name`, `description`, `is_popup`, `tabs[]`), `functions[]` (`name`, `trigger`, `description`,
  `validations[]`), `navigates_to[]` (names of the screens this one opens).
- Screens imported with an original picture also get `mode` and `original_images[]`; their rules come in an
  extra reference below.

## What to put on the screen

1. **Every function the user triggers here has its control**, labelled as in `trigger`: "clicks the Log in
   button" ⇒ a button `Log in`, "clicks the Sign up link" ⇒ a link, "checks the terms checkbox" ⇒ a checkbox,
   "selects a status filter" ⇒ a `select` field. System-side functions ("the system sends…") get no control.
2. **Every field a validation mentions has an input**: "Email must be a valid address" ⇒ field `Email`
   (required when the validation says so); a password gets `kind: "password"`, a date `kind: "date"`.
3. `navigates_to[]` screens are reached through a button, link or `nav` item: never twice.
4. Lists / results / history ⇒ `table` with the real column names and 2-3 sample rows; cart-like lists ⇒ `items`.
5. Real labels taken from the input, in the **language of the input** (English input ⇒ English). Sample values
   look real (`an.nguyen@example.com`, `18,990,000 VND`). No lorem ipsum, no ids (`FN001`, `S03`), no em dash.
6. One screen only, at most 20 blocks. Do not list the functions' steps.

## Spec shape

```
{ "title": "Create your account", "path": "/signup", "platforms": ["web", "mobile"],
  "nav": ["Home", "Orders"], "back": true, "columns": 2, "popup": false, "tabs": ["Profile", "Security"],
  "blocks": [ ...see the block table in the reference below... ] }
```

- `title`: the heading on the screen. `path`: a short route for the address bar (`/signup`, `/admin/orders`).
- `platforms` ⊆ `allowed_platforms`: where this screen exists. Admin / back-office screens and heavy data
  entry (wide tables, many filters) are usually **web only**; everything else gets every allowed platform.
- `nav`: top menu items when the screen shows the app's main navigation (≤ 6). `back`: true when the screen
  is reached from another one and returns to it (detail, form, checkout).
- `columns` (1-3, web only): how many fields per row. 2 for sign-up / profile forms with 4+ fields, 3 for
  filter rows, 1 for short forms (log in).
- `popup: true` when `screen.is_popup`: a dialog over the previous screen, no header or nav.
- `tabs` = `screen.tabs` when not empty; draw the content of the first tab.
- Optional keys may be left out; never add keys that are not listed.

## Output

Only a fenced json block. `puml` holds the envelope **as a JSON string** (escaped quotes):

```json
{ "puml": "{\"spec\":{\"title\":\"Log in\",\"path\":\"/login\",\"platforms\":[\"web\"],\"blocks\":[...]},\"screen_images\":[0],\"primary_color\":\"#E4572E\"}", "notes": "one short sentence on anything you had to guess" }
```

`screen_images` only when the input has `original_images`; `primary_color` only in mode `original`.

## Self-check

- [ ] `puml` parses as JSON with a `spec` that has `title`, `path`, `platforms`, `blocks` and only the keys above.
- [ ] Every block `type` is in the block table; strings are short (labels ≤ 60, table cells ≤ 40 characters).
- [ ] Every user-triggered function has its control; every validated field has an input.
- [ ] `platforms` only from `allowed_platforms`; popup / tabs follow the input.
- [ ] No colours, sizes or ids in the spec; no em dash.
- [ ] `qty` and `columns` are JSON numbers (`1`, not `"1"`); `required`, `primary`, `strong`, `back`, `popup` are `true` / `false`.
