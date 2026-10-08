# Task 03 — Tái cấu trúc prompt asset thành skill (BMAD) + bỏ DB override

**Wave:** 1 · **Người phụ trách:** B · **Effort:** 6 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Chuyển 8 prompt phẳng thành cấu trúc 29 skill theo Phases §8 (`SKILL.md` + `references/` + `assets/`), nguồn sự thật là đĩa, ghi `asset_version`. Định nghĩa các `ActionType` mới theo `call_kind` và schema đầu ra op batch để T08/T11 dùng. Dọn pipeline Excalidraw.

## Lệch hướng audit cần đóng
D2 (8 prompt phẳng thay vì 29 skill), D3 (DB override ưu tiên hơn đĩa), một phần D1 (Excalidraw song song), một phần D4 (prompt yêu cầu tiếng Anh cho nội dung render).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Sửa: `flintflow_be/src/shared/ai/prompt-assets.ts` (quét `assets/skills/**/SKILL.md`, index theo `skill_id`, nạp `references/*.md` theo yêu cầu, tính `asset_version` = sha256 nội dung SKILL.md + references; giữ quét `assets/prompts/*.md` cho `chat`, `summarize_document`).
- Sửa: `flintflow_be/src/shared/ai/prompt-registry.service.ts` (xoá nhánh `PromptTemplate.findOne`, thêm `getSkill(skillId): {template, providerConfig, references, asset_version}`; giữ `interpolatePrompt`).
- Sửa: `flintflow_be/src/shared/ai/ai-action.types.ts` (thêm `ActionType`: `ELICIT, DRAFT, RENDER_FIX, REVIEW, REGENERATE, REVISION, DISCOVERY_STEP, CONSISTENCY_PASS, GLOSSARY_SCAN, RECONCILE, CHANGE_INSTRUCTION`; giữ `CHAT`, `SUMMARIZE_DOCUMENT`; đánh dấu deprecated `GENERATE_SECTION, PRIORITY_RANKING, SCOPE_OUT_OF_SCOPE, CHAT_DISCOVERY, DIAGRAM_*`).
- Sửa: `flintflow_be/src/shared/ai/response-parser.ts` (thêm `opTransactionSchema` `{txn?, ops: [{op: set|add|remove|renumber, path, value?, reason?}], notes?}`, `elicitSchema` `{reply, questions[]}`, `reviewSchema` `{flags: [{level, rule_id?, section_id, message}]}`, `changeInstructionSchema` `{clarification_needed?: string, ops?}`).
- Sửa: `flintflow_be/src/shared/ai/credit-reservation.service.ts` bảng giá theo actionType mới (elicit 1, draft 4, review 2, regenerate 4, revision 3, render_fix 1, discovery_step 2, consistency_pass 3, glossary_scan 2, reconcile 4, change_instruction 3).
- Sửa: `flintflow_be/src/shared/ai/ai-action.controller.ts:49-63` gỡ nhánh `generate_diagram`.
- Sửa: `flintflow_be/src/modules/admin/prompt-template.controller.ts` + `route.ts`: POST/PUT/PATCH trả 410 `PROMPT_OVERRIDE_DISABLED`; GET vẫn trả bản trên đĩa (đọc từ registry).
- Sửa: `flintflow_be/src/shared/ai/prompt-assets.test.ts`; `flintflow_be/assets/prompts/README.md`; `flintflow_be/src/shared/ai/README.md`; `flintflow_be/src/scripts/seed-from-md.ts` (giữ nhưng chỉ dùng cho `assets/prompts`).
- Di chuyển: `flintflow_be/assets/prompts/drawtest/` sang `assets/prompts/_archive/drawtest/`; `flintflow_be/assets/diagram-skill/` sang `assets/_archive/diagram-skill/`; `flintflow_be/src/modules/drawtest/` sang `src/_archive/drawtest/` (tsconfig exclude).
### Tạo mới
- `flintflow_be/assets/skills/action/{srs-orchestrator,phase-intake,elicit-loop,draft-to-ops,apply-change-op,deterministic-check,review-section,gate-check,meter,plantuml-conventions}/SKILL.md` — nội dung thật (10 file).
- `flintflow_be/assets/skills/content/{project-classifier,product-overview,high-level-rules,actors-and-usecases,screens-and-flow,authorization-matrix,entities-erd,non-screen-functions,function-detail,nfr-quality-attributes,appendix-content,glossary,product-brief}/SKILL.md` — stub có frontmatter (nội dung ở T14/T18/T20).
- `flintflow_be/assets/skills/renderer/{context,usecase,screen-flow,erd,screen-layout}/SKILL.md` — stub (T10 điền).
- `flintflow_be/assets/skills/output/{assemble-srs,srs-completeness-score}/SKILL.md` — stub (T15/T19 điền).
- `flintflow_be/assets/skills/README.md` — quy ước frontmatter: `skill_id, kind: action|content|renderer|output, version, provider, aiModel, maxTokens, temperature, reads[], writes[], output_schema: opTransaction|elicit|review|…, language: en|user`.
- `flintflow_be/assets/skills/LICENSE-BMAD.md` — copyright notice MIT cho phần tái dùng (Phases §8.1).

## Các bước implement
1. Chốt frontmatter và thư mục; viết README.
2. Viết 10 skill action từ Phases §3, §4.1, §8.2 (mỗi `SKILL.md` ≤ 150 dòng; chi tiết luật vào `references/`).
3. Tạo stub 19 skill còn lại với `reads/writes` lấy từ srs-spine §4 và Phases §6.4.
4. Sửa loader/registry/test; thêm `asset_version`.
5. Thêm ActionType + schema + giá.
6. Chuyển admin prompt sang read-only; gỡ drawtest; cập nhật `tsconfig.json` exclude `_archive`.
7. Cập nhật `prompt-assets.test.ts`: mọi ActionType không deprecated có skill hoặc prompt; không trùng `skill_id`; frontmatter đủ.

## Dependency
- Phụ thuộc: không.
- Chặn: T10, T11, T13, T14, T18, T20.
- Chạy song song với: T01, T02, T04, T05, T06, T07.

## Output kỳ vọng
- Cây `assets/skills/` với 29 SKILL.md (10 đủ nội dung, 19 stub), loader mới, registry chỉ đọc đĩa.

## Tiêu chí hoàn thành (DoD)
- [ ] Server boot qua `startup-checks` với cấu trúc mới.
- [ ] `prompt-assets.test.ts` xanh; test mới: `getSkill("draft-to-ops")` trả `asset_version` ổn định.
- [ ] `PUT /admin/prompt-templates/:actionType` trả 410.
- [ ] `grep -r "drawtest" src/` chỉ còn trong `_archive`.

## Ghi chú / rủi ro
- Tên `skill_id` và `ActionType` là hợp đồng với T11/T13; chốt sớm, đổi phải báo nhóm.
- Giữ model `PromptTemplate` (không xoá) để không phá seed cũ; xoá ở T21 nếu không còn dùng.
