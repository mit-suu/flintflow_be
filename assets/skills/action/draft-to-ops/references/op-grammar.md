# Op grammar — source: srs-spine.md §1, §3; Phases §2.1

```json
{ "txn": "t42", "op": "set", "path": "actors[id=A03].name", "value": "Administrator", "reason": "typo" }
```

## Operations

| `op` | `path` points to | `value` | Effect |
| --- | --- | --- | --- |
| `set` | a field (scalar, object or whole array field) | required | Replace the value. Creates the field if absent |
| `add` | an array, suffix `[]` | required — the new element (object with `id` when the array is keyed) or a scalar for scalar arrays | Append |
| `remove` | an element selector `arr[id=X]`, or a scalar in a scalar array `arr[=X]` | omitted | Delete; the engine adds cascade ops to the same batch |
| `renumber` | an array with an `order` field, optionally filtered | optional `{ "field": "order" }` | Rewrite `order` to 0..n-1 keeping current relative order |

## Selectors

| Form | Example | Notes |
| --- | --- | --- |
| By id | `actors[id=A03]` | Default for every keyed array |
| Composite natural key | `permissions[screen_id=S3,role_id=R1,action=create]` | Only for `permissions[]` (it also has `id`) |
| Filter for renumber / reads | `functions[feature_id=F2,screen_id=null]` | `null` literal allowed |
| Nested | `functions[id=FN07].validations[id=V2].statement` | Keys at every level |
| Scalar in array | `screens[id=S3].flow_to[=S5]` | For `remove` from arrays of ids |
| Singletons | `project.release_scope.in`, `progress.screen_queue` | Object paths use dots |

**Forbidden**: numeric index `actors[1]`, wildcard `actors[*]`, changing an `id` field, paths outside the step's writable set.

## Element shapes (srs-spine.md §2)

```text
features[]         { id, name, order }
actors[]           { id, name, kind: human|system|time, description }
roles[]            { id, name, actor_id | null }
use_cases[]        { id, name, actor_ids[], function_ids[], description, includes[], extends[] }
screens[]          { id, feature_id, name, description, flow_to[], is_popup, tabs[],
                     primary_function_id, queue_order, detail_status }
permissions[]      { id, screen_id, role_id, action }
entities[]         { id, name, description, relations[] }
functions[]        { id, screen_id | null, feature_id, order, name, trigger, description,
                     normal[], abnormal[], validations[] { id, kind: business|format|required, statement },
                     business_rule_ids[], priority }
nfrs[]             { id, category: interface|usability|reliability|performance|other,
                     statement, kind: quantitative|descriptive, metric?, threshold?, priority }
business_rules[]   { id, tier: high|detail, statement, source_validation_ids[] }
common_requirements[] { id, category, statement }
messages[]         { id, code, text, function_ids[] }
other_requirements[]  { id, kind: risk|assumption|open_question|technical_risk, statement }
glossary[]         { id, term, term_native?, definition }
addendum[]         { id, topic, content, content_en, target_section, captured_at }
assumptions[]      { id, path, statement, rationale, origin_step_id, status, confirmed_at }
```

## Examples

Add a screen to feature F2 during S-4.1:

```json
{ "op": "add", "path": "screens[]", "value": { "id": "S7", "feature_id": "F2", "name": "Invoice List", "description": "Lists invoices with filters.", "flow_to": [], "is_popup": false, "tabs": [], "primary_function_id": null, "queue_order": 6, "detail_status": "pending" }, "reason": "screen inventory" }
```

Remove feature F1 (order 1 of 0..3) — cascade and renumber in one batch:

```json
[
  { "op": "remove", "path": "features[id=F1]", "reason": "merged into F2" },
  { "op": "renumber", "path": "features[]", "reason": "keep order contiguous" }
]
```

Swap two features: two `set … .order` ops plus nothing else — the intermediate duplicate order is fine because invariants run at the end of the batch.

Quantitative NFR:

```json
{ "op": "add", "path": "nfrs[]", "value": { "id": "NFR05", "category": "performance", "statement": "Search results are returned within 2 seconds for 95% of requests at 200 concurrent users.", "kind": "quantitative", "metric": "p95 response time", "threshold": "2 s @ 200 users", "priority": null } }
```
