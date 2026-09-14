# Field → section map — source: srs-spine.md §4

`stale` propagates along **all three** columns. The projection of a step = every field listed in any column for the sections it feeds.

| Field | Owns (main render) | Reads (printed, not owned) | Derives (must re-run derivation) |
| --- | --- | --- | --- |
| `project.vision`, `.goals[]`, `.name` | `fixed:1` | — | — |
| `project.release_scope` | `fixed:1` | — | — |
| `project.type`, `.domain`, `.complexity`, `.stakes` | — | — | `fixed:4.2.1` … `fixed:4.2.4` (NFR thresholds) |
| `business_rules[tier=high]` | `fixed:1` | — | — |
| `actors[kind≠human]` | `fixed:1` | `fixed:2.1` | `diagrams[context]` |
| `actors[]` | `fixed:2.1` | `fixed:2.2.2`, `fixed:3.1.3` | `diagrams[usecase]`, `fixed:5.5` |
| `roles[]`, `permissions[]` | `fixed:3.1.3` | — | — |
| `use_cases[]` | `fixed:2.2.2` | — | `diagrams[usecase]` |
| `features[]` | `feature:<id>` | `fixed:3.1.2` | §3.x numbering (assemble) |
| `screens[].name/.description/.feature_id` | `fixed:3.1.2` | `fixed:3.1.1`, `fixed:3.1.3`, `function:<id>` | `diagrams[screen_flow]`, `fixed:5.5` |
| `screens[].flow_to[]/.is_popup/.tabs[]` | `fixed:3.1.1` | — | `diagrams[screen_flow]` |
| `screens[].primary_function_id` | — | — | `diagrams[screen_layout]` |
| `functions[screen_id≠null]` | `function:<id>` | `fixed:3.1.2`, `fixed:2.2.2` | — |
| `functions[screen_id=null]` | `function:<id>` | `fixed:3.1.4`, `fixed:2.2.2` | — |
| `functions[].order` | — | — | §3.x.y numbering (assemble) |
| `functions[].validations[]` | `function:<id>` | — | `fixed:5.1` (S-7.1) |
| `functions[].abnormal[]` | `function:<id>` | — | `fixed:5.3` (S-7.3) |
| `entities[]` | `fixed:3.1.5` | — | `diagrams[erd]`, `fixed:5.5` |
| `nfrs[category=interface]` | `fixed:4.1` | — | — |
| `nfrs[category=usability]` | `fixed:4.2.1` | — | — |
| `nfrs[category=reliability]` | `fixed:4.2.2` | — | — |
| `nfrs[category=performance]` | `fixed:4.2.3` | — | — |
| `nfrs[category=other]` | `fixed:4.2.4` | — | — |
| `business_rules[tier=detail]` | `fixed:5.1` | `function:<id>` | — |
| `common_requirements[]` | `fixed:5.2` | — | — |
| `messages[]` | `fixed:5.3` | — | — |
| `other_requirements[]` | `fixed:5.4` | — | — |
| `glossary[]` | `fixed:5.5` | — | — |
| `changes[]` | `fixed:I` | — | — |
| `diagrams[kind=context]` | `fixed:1` | — | — |
| `diagrams[kind=usecase]` | `fixed:2.2.1` | — | — |
| `diagrams[kind=screen_flow]` | `fixed:3.1.1` | — | — |
| `diagrams[kind=erd]` | `fixed:3.1.5` | — | — |
| `diagrams[kind=screen_layout]` | `function:<primary_function_id>` | — | — |

**Never mapped to a section** (internal state): `sessions[]`, `progress`, `steps[]`, `assumptions[]`, `flags[]`, `sections[]`, `baselines[]`, `usage[]`, `spine_version`, `addendum[]`, `project.form_factor`, `project.working_mode`.

## Brief input per phase (Phases §6.1)

| Phase | Brief steps | Spine written |
| --- | --- | --- |
| S-1 | all of B-1 + addendum | `project` |
| S-2 | B-1.1, B-1.3, B-1.4 | `release_scope`, `actors[kind≠human]`, `business_rules[tier=high]` |
| S-3 | B-1.2, B-1.4 | `actors[]`, `roles[]`, `use_cases[]` |
| S-4 | B-1.4, B-1.2, B-1.5 | `features[]`, `screens[]`, `permissions[]`, `entities[]`, `functions[]` (skeleton) |
| S-5 | B-1.2, B-1.4, B-1.5, S-4, addendum | `functions[].*` |
| S-6 | B-1.4, B-1.5, B-1.6, addendum | `nfrs[]` |
| S-7 | B-1.6, addendum | `business_rules[tier=detail]`, `common_requirements[]`, `messages[]`, `other_requirements[]` |
| S-8 | accepted sections S-2 → S-7 | `glossary[]` |
| S-9 | B-1.1, B-1.5 | `flags[]`, `baselines[]`, `priority` |
