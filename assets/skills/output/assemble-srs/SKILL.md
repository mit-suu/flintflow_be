---
skill_id: assemble-srs
kind: output
version: 1.0.0
description: "S-8.2 Document Assembly + S-8.3 Record of Changes — deterministic, FPT order, section numbering"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0.1
reads:
  - "<whole Spine>"
  - "changes[]"
  - "diagrams[]"
  - "flags[]"
writes: []
output_schema: none
language: en
stub: true
---
# Assemble SRS

> **STUB** (giữ `stub: true` — quy ước `output`/`content`/`renderer` của asset test
> `prompt-assets.test.ts`, không phải action). `deterministic: true` ở
> `assets/step-registry.json`, S-8.2/S-8.3 KHÔNG bao giờ gọi model — mọi trường
> `provider`/`aiModel`/`maxTokens`/`temperature` ở trên chỉ để thoả frontmatter bắt
> buộc của registry, không dùng tới. Quy trình thật nằm trong `src/modules/render/`.

**Không gọi model.** S-8.2/S-8.3 là step tất định (`deterministic: true` ở
`assets/step-registry.json`) — toàn bộ quy trình chạy bằng code thuần trong
`src/modules/render/`, skill này chỉ mô tả quy trình cho người đọc/agent điều phối.

## Quy trình (S-8.2 Document Assembly)

1. Đọc Spine hiện tại (`spine.repository.get`), lấy `changes[]` của project
   (`spine.repository.listChanges`).
2. Liệt kê mọi section theo đúng thứ tự template FPT
   (`section-registry.listSections`) — cố định + `feature:<id>`/`function:<id>`
   sinh theo dữ liệu, feature/function chen giữa §3.1.5 và §4.
3. Sinh số hiệu section (`assemble.service.buildNumberMap`, Product-Brief-to-SRS-Phases.md
   §6.3): `fixed:X.Y.Z` → bỏ tiền tố `fixed:`; feature → `3.(2 + order)`;
   function → `3.(2 + order feature).<vị trí>` — `<vị trí>` là thứ tự 1-based của
   function trong danh sách đã gộp của chính feature đó (`section-registry.listSections`,
   screen-bound trước rồi non-screen), KHÔNG phải `functions[].order` đọc trực
   tiếp (order đánh riêng theo screen-bound/non-screen nên có thể trùng nhau).
   Function `feature_id` chết (không khớp feature nào còn sống) gom vào một mục
   riêng `3.(2 + features.length + 1)` "Unassigned Functions" cuối chương 3,
   không rơi về số của feature thật. Số hiệu tính LÚC assemble — cấm ghi cứng số
   section vào field Spine (dò bằng test regex trên prose fixture).
4. Chèn heading nhóm tổng hợp trước section con đầu tiên của từng nhóm: 4 chương
   (`group:2..5` — User/Functional/Non-Functional Requirements, Requirement
   Appendix, chương 1 chính là `fixed:1`) và 3 nhóm con (`group:2.2` Use Cases,
   `group:3.1` System Functional Overview, `group:4.2` Quality Attributes) — suy
   từ `def.parent` của `section-registry.listSections`, không phải bảng "section
   đầu tiên của chương" liệt kê tay.
5. Với mỗi section, gọi `section-renderer.renderSection(spine, sectionId, ctx)`
   → `RenderedSection` (bảng field→section §4 srs-spine.md). Ảnh diagram: tải
   PNG từ `diagram.service.loadDiagramFile` (GridFS), chèn base64 vào block
   `image`. Trạng thái/`awaiting_reaccept` lấy từ `section-status.computeSectionStates`
   (T09) — không tự suy diễn lại.
6. `fixed:5.5` (Glossary) luôn render lại vô điều kiện (`derived`, không tính
   stale/điểm sẵn sàng — §4.2 srs-spine.md).

## S-8.3 Record of Changes

`section-renderer.buildRecordOfChanges` gộp `changes[]` theo `txn` thành
`RenderedDocument.recordOfChanges[]` (KHÔNG phải một section trong `sections[]`
— `docx-writer.ts` render §I từ field riêng này). Mỗi dòng: ngày (`at` của
change đầu lô), người ghi (`by`, tra qua `User.name`/email theo lô, "System"
cho `by="system"`, id rút gọn nếu user đã bị xoá), loại thay đổi suy từ tập
`op` trong lô (A/M/D), mô tả gộp từ `reason[]` không trùng, `version` =
`v0.<i+2>` (`i` = thứ tự txn 0-based) vì Spine bắt đầu ở `spine_version=1` và
mỗi txn tăng đúng 1 — dòng cuối khớp `v0.<spine_version>` của chính tài liệu.
`assemble.service.ts` đọc `changes[]` cho §I thẳng từ `Change` model (projection
`{txn, at, by, reason, op, step_id}`, không qua `spine.repository.listChanges`
— không cần `before`/`value` ở đây).

## S-8.4 Consistency Pass (tất định — không thuộc skill này)

`consistency-pass.runConsistencyPass` chạy sau khi ghép xong: toàn vẹn tham
chiếu (`reference-fields.findDeadReferences`), số section trùng, thuật ngữ
viết hoa chưa có trong glossary (heuristic). Chỉ log cảnh báo, không chặn
export, không ghi Spine. Nhánh LLM (trùng lặp ngữ nghĩa, thuật ngữ lệch) là
stub sau flag `CONSISTENCY_LLM_ENABLED` — chưa hiện thực.

## Cache

`assemble()` lưu `RenderedDocument` vào collection `rendered_documents`
(`rendered-document.model.ts`) theo khoá `(projectId, spine_version)` —
`POST /assemble` gọi lại cùng version trả cache có sẵn, không ghép lại. Chỉ giữ
3 bản draft gần nhất mỗi project (dọn bản cũ sau khi ghi). Ảnh diagram trong
cache không lưu base64 thật — thay bằng tham chiếu `diagram-ref:<diagramId>`,
tải lại PNG lúc đọc (`stripImagesForCache`/`rehydrateImages`) để tránh phình
document tới trần 16MB của Mongo. Có ảnh tải lỗi lúc assemble (`render_status
= ok` nhưng PNG không tải được) ⇒ vẫn trả tài liệu nhưng KHÔNG ghi cache, lần
sau thử lại.

`GET /document`/`GET /export/word` với `source=draft` đọc bản cache mới nhất;
chưa từng `assemble` ⇒ `409 NO_WORKING_DRAFT` (`meta.hint = "S-8.2"`). Đính kèm
`meta.assembled_at_version`/`meta.spine_version`/`meta.stale` (`GET /document`)
hoặc header `X-Assembled-At-Version`/`X-Spine-Version` (`GET /export/word`) —
Spine có thể đã đổi tiếp sau lần `assemble` cuối, cache "mới nhất" không đồng
nghĩa "khớp Spine hiện tại".

`source=baseline` cache theo `(projectId, baseline_id)` — bất biến nên dựng một
lần, đọc lại từ cache các lần sau (trước đây dựng lại tươi mỗi lần xem, tốn kém
không cần thiết cho một snapshot không đổi).

- Steps: S-8.2 Document Assembly · S-8.3 Record of Changes
- Section: all + fixed:I (fixed:I → field `recordOfChanges`, không phải `sections[]`)
- Output: `none` (không gọi model — xem `src/modules/render/assemble.service.ts`)
