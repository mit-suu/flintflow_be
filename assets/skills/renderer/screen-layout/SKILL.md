---
skill_id: screen-layout
kind: renderer
version: 2.1.0
description: "S-5.3 Screen Layout — the model draws a low-fi PlantUML Salt wireframe of one core screen from its functions"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.2
reads:
  - "project.system_name"
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

You draw the wireframe of **one** screen as PlantUML **Salt**, the picture under §3.x.y of the SRS.
Code calls you from `src/modules/diagram/diagram.service.ts` (call kind `render_fix`) only for core screens
(`signed_off` with a `primary_function_id`), compile-checks your Salt on the PlantUML server and, when it
does not compile, falls back to a plain `Function | Description` table. You write nothing into the Spine.

## Input

A JSON object: `system_name` (may be null), `screen` (`name`, `description`, `is_popup`, `tabs[]`),
`functions[]` (`name`, `trigger`, `description`, `validations[]`) and `navigates_to[]` (names of the
screens this one opens).

## What to draw

Low-fi: what the user sees and can do on the screen, top to bottom — not colours, not pixels.

1. **Every function the user triggers here has its control**, labelled as in `trigger`: "clicks the Log in
   button" → `[ Log in ]`, "clicks the Sign up link" → `<u>Sign up</u>`, "checks the terms checkbox" →
   `[ ] I accept the terms`, "selects a status filter" → a dropdown. System-side functions (streaming,
   background jobs, "the system…") get no control.
2. **Every field a validation mentions has an input**: "Email must be a valid address" → an `Email` label and
   an input; a password gets a masked input; min/max price → two inputs on one row.
3. `navigates_to[]` screens are reached through a button or link already drawn — do not add a second one.
4. Lists / results / history → a `{#` table with the real column names and one or two sample rows.
5. Real labels in English, taken from the input; sample values that look real (`john@example.com`,
   `2,500,000,000`). No lorem ipsum, no Vietnamese diacritics, no ids (`FN001`, `S03`).
6. Keep it one screen: at most ~25 lines of widgets. Do not draw the functions' `normal[]` steps.

## Layout

```
@startsalt
{
  {+
    {
      <b>SYSTEM NAME
      Screen name
    }
    ..
    ...widgets, one per line, top to bottom...
  }
}
@endsalt
```

- Draw the frame exactly as above, no `.` spacer rows/columns around the content: code pads the frame for you.
- The header is `system_name` in capitals, then the screen name; without `system_name` only the screen name.
- **Pop-up** (`is_popup: true`): no header, the whole body is a titled box `{^"Screen name"` … `}` instead of `{+`.
- **Tabs** (`tabs[]` not empty): right under the header, `{/ <b>First tab | Second tab | Third tab }`, then
  draw the content of the first tab.

## Salt cheat sheet (anything else breaks the compile)

| Widget | Salt |
| --- | --- |
| Heading / plain text | `<b>Log in to your account` / `Don't have an account?` |
| Text input (label on the line above) | `Email` then `"john@example.com          "` — pad with spaces for width |
| Password | `"........                  "` — dots, **never `**`** (that is bold) |
| Button / main button | `[ Cancel ]` / `[        Log in        ]` (wider) |
| Link | `<u>Forgot password?</u>` |
| Checkbox | `[ ] Remember me` · `[X] Checked` |
| Radio group | `{ (X) Fast \| ( ) Coaching }` |
| Dropdown | `^All statuses        ^` |
| Multi-line text | `{+` then the placeholder line, `.`, `.`, then `}` |
| Widgets on one row | `{ [ ] Remember me \| <u>Forgot password?</u> }` |
| Table | `{#` then `<b>Name \| <b>Status` then `Sunrise Villa \| Approved` then `}` |
| Separator | `..` alone on its line |
| Image / map placeholder | `{+` then `Map area` then `}` |

**One widget per line.** Two widgets side by side only inside a row `{ a | b }` — a bare `"...." [ Show ]` on
one line prints as plain text. Password with a show toggle: `{ "........          " | [ Show ] }`.
Inside text never use `" [ ] { } | ^ # < >` except as the syntax above. `[text]` is a **button**, not an
input — an input is always in double quotes.

## Example

Input: Login, functions "Submit Credentials" (trigger "clicks the Log in button", validations on Email and
Password), "Open Forgot Password" ("clicks the Forgot password link"), "Navigate to Register" ("clicks the
Sign up link"), "Log In with Google" ("clicks the Google button").

```
@startsalt
{
  {+
    {
      <b>FLINTFLOW
      Login
    }
    ..
    <b>Log in to your account
    Email
    "john@example.com              "
    Password
    "........                      "
    { [ ] Remember me | <u>Forgot password?</u> }
    [            Log in            ]
    [ Continue with Google ]
    ..
    { Don't have an account? | <u>Sign up</u> }
  }
}
@endsalt
```

## Output

Only a fenced json block, the Salt in `puml` with `\n` line breaks:

```json
{ "puml": "@startsalt\n{\n  {+\n    ...\n  }\n}\n@endsalt\n", "notes": "one short sentence on anything you had to guess" }
```

## Self-check

- [ ] Starts with `@startsalt`, ends with `@endsalt`, one diagram, braces balanced.
- [ ] Every user-triggered function has its button/link/control; every validated field has an input.
- [ ] Inputs in double quotes, buttons in brackets, password as dots, no `**`.
- [ ] Every line holds one widget, or one `{ … | … }` row — never two bare widgets.
- [ ] Pop-up drawn as `{^"Name"`, tabs as `{/ … }`, header only on non-pop-up screens.
- [ ] English only, no ids, no diacritics.
