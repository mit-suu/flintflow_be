# Task 15 — Assemble S-8.2 / S-8.3 / S-8.4 + nối export Word

**Wave:** 3 · **Người phụ trách:** C · **Effort:** 9 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [x] Xong (2026-09-15, nhánh `wave3/review`; `NO_WORKING_DRAFT` chờ contract-change — xem `flintflow/plans/reports/t15-report-260915-assemble-export.md`)

## Mục tiêu
Phases §9.3 bước 3: một luồng đi trọn fixture, render section từ field theo bảng §4, `RenderedDocument`, file Word (T05). Có §I Record of Changes từ `changes[]`, đánh số §3.x.y theo `order`, consistency pass tất định.

## Lệch hướng audit cần đóng
F2 (export), C8 (export không bị chặn, watermark DRAFT), A3 (section theo template FPT), một phần A4 (§I từ changes).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `context/Product-Brief-to-SRS-Phases.md` §6.3, §6.4 (S-8.x), §6.5; `context/srs-spine.md` §4, §4.2; `modules/render/{rendered-document.types.ts, docx-writer.ts, markdown-to-blocks.ts}` (T05); `modules/spine/{section-registry.ts, section-status.ts}` (T09); `modules/diagram/diagram.service.ts` (T10); `modules/spine/reference-fields.ts` (T08).
- Sửa: `flintflow_be/src/modules/render/export.route.ts` (T05) thêm route thật.
- Sửa FE (nhỏ, phối hợp D): `DocumentPane` bỏ copy/tải `.md` (D làm trong T16).
### Tạo mới
- `flintflow_be/src/modules/render/section-renderer.ts` — `renderSection(spine, changes, sectionId, opts)` trả `RenderedSection` cho từng id: `fixed:1` (vision, goals, release_scope in/out, business_rules high, actors system, ảnh `diagrams[context]`), `fixed:2.1` bảng actors, `fixed:2.2.1` ảnh usecase, `fixed:2.2.2` bảng UC (ID, name, actors, description, include/extend), `fixed:3.1.1` ảnh screen_flow + bảng điều hướng, `fixed:3.1.2` bảng Feature | Screen, `fixed:3.1.3` ma trận màn × vai trò (+ dòng con action), `fixed:3.1.4` bảng non-screen functions, `fixed:3.1.5` ảnh erd + bảng entity, `feature:<id>` heading §3.(2+order), `function:<id>` §3.(2+order).(order+1) với trigger/description/normal/abnormal/validations/business rules đọc + ảnh screen_layout nếu là `primary_function_id`, `fixed:4.1`, `fixed:4.2.1…4.2.4` bảng nfrs (metric/threshold), `fixed:5.1…5.4`, `fixed:5.5` glossary (derived, render lại vô điều kiện), `fixed:I` (S-8.3: từ `changes[]` gộp theo txn: ngày, step, reason, by; dịch reason theo ngôn ngữ export nếu có). Tham chiếu chéo từ khoá logic sang số section lúc assemble (cấm số cứng).
- `flintflow_be/src/modules/render/assemble.service.ts` — `assemble(projectId, {source: draft|baseline, partial?: bool})` trả `RenderedDocument`: `source=baseline` đọc `Baseline.snapshot` (T19 tạo; trước đó 404 `NO_BASELINE`), `partial` bỏ section rỗng (dev), gắn `status`/`awaiting_reaccept` từ T09, `watermark=DRAFT` + `flagsAppendix` (cờ đỏ mở, số stale, waive) khi draft; lưu `RenderedDocument` cache theo `spine_version` (collection `rendered_documents`), `assembled_at_version`.
- `flintflow_be/src/modules/render/consistency-pass.ts` — S-8.4 tất định: toàn vẹn tham chiếu (reuse `reference-fields`), thuật ngữ glossary chưa định nghĩa xuất hiện trong field render (heuristic), số section trùng; nhánh LLM (`CONSISTENCY_PASS`) để stub sau flag.
- `flintflow_be/src/modules/render/render.controller.ts` — `POST /projects/:id/assemble`, `GET /projects/:id/document?source=`, `GET /projects/:id/export/word?source=draft|baseline` (chưa assemble trả 409 `NO_WORKING_DRAFT` với `hint: "S-8.2"`).
- Điền `assets/skills/output/assemble-srs/SKILL.md` (mô tả quy trình, không gọi model).
- Test: `section-renderer.test.ts` (snapshot từng section từ fixture), `assemble.test.ts` (snapshot `RenderedDocument`), `export.e2e.test.ts` (docx sinh ra có 5 chương + §I).

## Các bước implement
1. `section-renderer` từng section theo thứ tự template; snapshot test.
2. Đánh số §3.x.y + cross-ref.
3. `assemble.service` + cache + partial.
4. `consistency-pass` tất định.
5. Routes + nối `writeDocx`.
6. Chạy fixture ra docx, mở kiểm tra thủ công.

## Dependency
- Phụ thuộc: T05, T09, T10; T08 (`reference-fields`).
- Chặn: T16 (`/document`), T19 (`source=baseline`), M3.
- Chạy song song với: T13, T14, T16.

## Output kỳ vọng
- Endpoint document/export chạy trên fixture; docx đủ 5 chương.

## Tiêu chí hoàn thành (DoD)
- [x] Snapshot `RenderedDocument` fixture ổn định. (`assemble.test.ts` + snapshot fixture 19 màn)
- [x] Docx từ fixture: 5 chương, §I có dòng từ `changes[]`, ảnh 5 diagram nhúng, watermark khi draft. (`export.e2e.test.ts` giải nén docx; chưa mở bằng Word tay)
- [x] Không chuỗi số section cứng trong field (test quét regex số dạng `3.x` trong prose fixture). (`export.e2e.test.ts`)
- [x] `export/word` khi chưa assemble trả 409 với hint. (`render.controller.test.ts`; mã `NO_WORKING_DRAFT` chưa có trong contract → đề xuất contract-change)

## Ghi chú / rủi ro
- `fixed:I` và `fixed:5.5` không tham gia stale/điểm sẵn sàng (§4.2).
- Bản baseline render từ snapshot, không từ Spine hiện tại.
