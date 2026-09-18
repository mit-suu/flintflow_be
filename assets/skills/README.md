# Skills — prompt asset theo BMAD (T03)

Nguồn sự thật cho mọi prompt của pipeline B-0 → S-9 (`Product-Brief-to-SRS-Phases.md` §8). **Không có DB override**: sửa file ở đây, commit, deploy. Trang admin prompt chỉ đọc.

```text
assets/skills/
├─ action/     10 skill hành động dùng chung mọi phase (Phases §3, §8.2 nhóm A)
│              + 5 skill mode 1 (import-*, cr-*; FLF-171, khung `stub` tới P2)
├─ content/    13 skill nội dung theo phase (nhóm B + product-brief)
├─ renderer/   5 renderer PlantUML (Phases §7.1)
├─ output/     2 skill đầu ra cuối (assemble, completeness score)
├─ LICENSE-BMAD.md
└─ <kind>/<skill_id>/
   ├─ SKILL.md            luôn nạp, ≤ ~150 dòng
   ├─ references/*.md     nạp có điều kiện: getSkill(id, { references: [...] })
   └─ assets/*-template.md nạp lúc render (không tính vào asset_version)
```

## Frontmatter

```yaml
---
skill_id: draft-to-ops          # BẮT BUỘC — trùng tên thư mục, duy nhất toàn cây
kind: action                    # BẮT BUỘC — action | content | renderer | output, trùng thư mục cha
version: 1.0.0                  # BẮT BUỘC — semver do người sửa tăng (asset_version tự tính)
description: Một câu mô tả      # tuỳ chọn
provider: glm                   # BẮT BUỘC — glm | openai | anthropic | gemini | modal
aiModel: zai-org/GLM-5.3-Flash  # BẮT BUỘC
maxTokens: 4096                 # BẮT BUỘC, > 0
temperature: 0.2                # BẮT BUỘC
reads:                          # BẮT BUỘC — field Spine skill được nạp (cột Sở hữu/Đọc/Suy dẫn, srs-spine §4)
  - screens[]
  - functions[]
writes:                         # BẮT BUỘC — field Spine skill được phát op; [] nếu không ghi
  - functions[]
output_schema: opTransaction    # BẮT BUỘC — một tên hoặc mảng tên (bảng dưới)
language: en                    # BẮT BUỘC — en: nội dung render vào SRS · user: theo ngôn ngữ user
stub: true                      # tuỳ chọn — skill chờ task sau điền nội dung
---
```

| `output_schema` | Schema (`src/shared/ai/response-parser.ts`) | Dùng cho ActionType |
| --- | --- | --- |
| `opTransaction` | `{txn?, ops: [{op: set\|add\|remove\|renumber, path, value?, reason?}], notes?}` | draft, regenerate, revision, glossary_scan, reconcile |
| `elicit` | `{reply, questions[]}` | elicit |
| `discoveryStep` | `{reply, questions[], ops?}` | discovery_step |
| `review` | `{flags: [{level, rule_id?, section_id, message}]}` | review, consistency_pass |
| `changeInstruction` | `{clarification_needed?, txn?, ops?, notes?}` | change_instruction |
| `renderFix` | `{puml, notes?}` | render_fix |
| `importExtract` | `{section_id, items: [{entity, key, value, confidence, field_confidence, source_block_ids}], unmapped_block_ids}` | import_extract_fields (mode 1) |
| `findings` | `{findings: [{rule, section_id, message, block_ids}]}` — chỉ cờ vàng | import_semantic_check, cr_consistency (mode 1) |
| `crClarify` | `{ambiguous, questions[], targets: {entity_paths[], keywords[]}}` | cr_clarify (mode 1) |
| `crPropose` | `{locations: [{location_id, conclusion, reason, new_text?, comment_text?, spine_ops}]}` | cr_propose (mode 1) |
| `puml` | text `.puml` (renderer, T10 chốt) | — |
| `none` | không gọi model — skill mô tả logic tất định cho code | — |

ActionType → skill hành động: `SKILL_BY_ACTION_TYPE` trong `src/shared/ai/ai-action.types.ts`. Skill nội dung/renderer của step do step runner (T13) ghép thêm.

## `asset_version`

`sha256` hex của `SKILL.md` (gồm frontmatter) + mọi `references/*.md` theo tên, xuống dòng chuẩn hoá LF. Ghi vào `sections[].asset_version`. Sửa một chữ trong reference ⇒ version đổi.

## Quy tắc viết

- `reads`/`writes` viết dạng **block list** (`- actors[]`). Flow list `[actors[], roles[]]` là YAML sai vì `[`/`]` trong giá trị.
- Nội dung render vào SRS: **tiếng Anh**. Hội thoại, `flags[].message`, `changes[].reason`: theo user (Phases §1.3).
- Model chỉ phát op; không bao giờ sinh lại cả section.
- Không nhắc số hiệu section (`3.4`) trong văn xuôi — dùng khoá logic (`feature:F2`).
- Placeholder `{{name}}` được `interpolatePrompt` thay lúc chạy.
- `skill_id` là hợp đồng với T11/T13: đổi tên phải qua PR `contract-change`.

## Kiểm tra

`npm test -- prompt-assets` kiểm: frontmatter đủ, không trùng `skill_id`, mọi ActionType không deprecated có skill hoặc prompt, `output_schema` của skill khớp ActionType, skill action ≤ 150 dòng.
