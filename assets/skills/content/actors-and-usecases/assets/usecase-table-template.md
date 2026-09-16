# Use case description table — rendered shape for `fixed:2.2.2`

Loaded only at render/assemble time (not counted in `asset_version`). One row per `use_cases[]` element,
in id order. Assemble (S-8.2) turns this into the numbered SRS table; this file only fixes the column
shape so S-3.5 writes descriptions that fit it without reformatting.

| Column | Source field | Notes |
| --- | --- | --- |
| ID | `use_cases[].id` | As stored, e.g. `UC03` |
| Name | `use_cases[].name` | Verb + object, Title Case |
| Actor(s) | `use_cases[].actor_ids[]` → `actors[].name` | Join with `, `; resolved at render time, not stored as names |
| Description | `use_cases[].description` | One sentence: actor, trigger, outcome |
| Includes | `use_cases[].includes[]` → target `.name` | Empty cell if none |
| Extends | `use_cases[].extends[]` → target `.name` | Empty cell if none |

## Example row

| ID | Name | Actor(s) | Description | Includes | Extends |
| --- | --- | --- | --- | --- | --- |
| UC03 | Accept Step At Gate | Founder / Business Analyst | The founder reviews a step's draft output at the gate and accepts it, moving the pipeline to the next step. | — | Run Guided Pipeline Step |

Description text must stand on its own without the table — it is also read verbatim by S-9 quality
checks and by the traceability map, not only rendered into this table.
