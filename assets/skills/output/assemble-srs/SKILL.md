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
3. Sinh số hiệu section (`assemble.service.numberOf`, Product-Brief-to-SRS-Phases.md
   §6.3): `fixed:X.Y.Z` → bỏ tiền tố `fixed:`; feature → `3.(2 + order)`;
   function → `3.(2 + order feature).(order function + 1)`. Số hiệu tính LÚC
   assemble — cấm ghi cứng số section vào field Spine (dò bằng test regex trên
   prose fixture).
4. Chèn 4 heading chương tổng hợp (`group:2..5` — User/Functional/Non-Functional
   Requirements, Requirement Appendix) ngay trước section đầu tiên của mỗi
   chương; chương 1 chính là `fixed:1`.
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
change đầu lô), người ghi (`by`), loại thay đổi suy từ tập `op` trong lô
(A/M/D), mô tả gộp từ `reason[]` không trùng.

## S-8.4 Consistency Pass (tất định — không thuộc skill này)

`consistency-pass.runConsistencyPass` chạy sau khi ghép xong: toàn vẹn tham
chiếu (`reference-fields.findDeadReferences`), số section trùng, thuật ngữ
viết hoa chưa có trong glossary (heuristic). Chỉ log cảnh báo, không chặn
export, không ghi Spine. Nhánh LLM (trùng lặp ngữ nghĩa, thuật ngữ lệch) là
stub sau flag `CONSISTENCY_LLM_ENABLED` — chưa hiện thực.

## Cache

`assemble()` lưu `RenderedDocument` vào collection `rendered_documents`
(`rendered-document.model.ts`) theo khoá `(projectId, spine_version)` —
`POST /assemble` gọi lại cùng version trả cache có sẵn, không ghép lại.
`GET /document`/`GET /export/word` với `source=draft` đọc bản cache mới nhất;
chưa từng `assemble` ⇒ `409 NO_WORKING_DRAFT` (`meta.hint = "S-8.2"`).
`source=baseline` luôn dựng lại tươi từ `Baseline.snapshot` (T19), không cache.

- Steps: S-8.2 Document Assembly · S-8.3 Record of Changes
- Section: all + fixed:I (fixed:I → field `recordOfChanges`, không phải `sections[]`)
- Output: `none` (không gọi model — xem `src/modules/render/assemble.service.ts`)
