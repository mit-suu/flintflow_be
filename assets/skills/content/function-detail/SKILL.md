---
skill_id: function-detail
kind: content
version: 0.1.0
description: "S-5.2 and S-5.4 per screen — trigger, description, normal/abnormal flows, validations (≤ 6 functions per call)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "screens[id=<screen>]"
  - "functions[screen_id=<screen>]"
  - "features[]"
  - "roles[]"
  - "permissions[screen_id=<screen>]"
  - "business_rules[tier=detail]"
  - "addendum[]"
writes:
  - "functions[].trigger"
  - "functions[].description"
  - "functions[].normal[]"
  - "functions[].abnormal[]"
  - "functions[].validations[]"
  - "functions[].business_rule_ids[]"
output_schema: opTransaction
language: en
stub: true
---
# Function Detail

> **STUB** — frontmatter is the contract; content is written in **T18**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-5.2 Trigger & Description · S-5.4 Function Details (per screen, and @nonscreen)
- Section: function:<id>
- Output: `opTransaction`
