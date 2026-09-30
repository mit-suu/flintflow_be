# Task 16 — FE Verification & Change panel + DocumentPane từ BE + Export UI + Onboarding

**Wave:** 3 · **Người phụ trách:** D · **Effort:** 10 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [x] Xong (2026-09-15, nhánh `wave3/review`; export từ BE thật + `PATCH /users/me` chờ — xem `flintflow/plans/reports/t16-report-260915-fe-verification-change.md`)

## Mục tiêu
Thay VerificationPane demo bằng dữ liệu thật (cờ đỏ/vàng, waive, điểm sẵn sàng), thêm Change panel (sửa qua chat với preview diff, hoà giải, undo, traceability), Document pane render `RenderedDocument` từ BE, Export UI theo §6.5, read-only view (UC 1.14), onboarding (UC 1.12).

## Lệch hướng audit cần đóng
C6 (demo hardcode), C3 phần FE (impact/stale/diff), C8 (export UI), C1 phần FE (sửa qua chat), 1.12 onboarding.

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `docs/api/pipeline-contract.md`; `types/{flags.ts, document.ts, spine.ts}` (T07); `hooks/*` (T12).
- Sửa: `flintflow_fe/app/projects/[projectId]/_components/VerificationPane.tsx` (viết lại), `DocumentPane.tsx` (render `GET /document`; bỏ copy/tải `.md`; highlight vùng đổi theo `changes[]` sau apply; chip `stale`/`awaiting_reaccept`; nút "xem tại step" link tới step sở hữu), `WorkspaceHeader.tsx` (Export mở `ExportPanel`), `ChatPane.tsx` (ô lệnh sửa gửi vào Change panel khi session không pipeline).
- Sửa: `flintflow_fe/lib/api/{flags.ts, export.ts, spine.ts}`; `flintflow_fe/mocks/handlers.ts` (thêm `/changes/preview`, `/reconcile`, `/undo`, `/traceability` mock cho tới khi T17 xong).
- Sửa: `flintflow_fe/app/home/page.tsx` (redirect `/home/onboarding` nếu `user.onboardedAt` null).
### Tạo mới
- `_components/FlagsPanel.tsx` (bảng cờ: level, rule_id, section, message, remediation_step link tới step; nút Waive mở `WaiveModal` với lý do ≥ 20 ký tự; luật không waive được không có nút; Recompute).
- `_components/ReadinessSummary.tsx` (`72% accepted · 4 chờ duyệt lại · 2 cờ đỏ`; không hiện điều kiện chốt bằng %).
- `_components/ChangePanel.tsx` (ô lệnh gọi `POST /changes/preview {instruction}`, mở `DiffPreviewModal` (bảng path / before / value / section ảnh hưởng / diagram render lại), Xác nhận gọi `POST /changes`; `NEEDS_CLARIFICATION` hiển thị câu hỏi; nút "Hoà giải một lượt" gọi `POST /reconcile` rồi diff gộp; nút "Undo op cuối" gọi `POST /undo`; lịch sử `GET /changes` 20 dòng).
- `_components/DiffPreviewModal.tsx`, `_components/TraceabilityMap.tsx` (bảng actor, use case, function, screen, entity từ `GET /traceability`; filter theo id).
- `_components/ExportPanel.tsx` (Word draft / Word baseline; chưa có bản ghép hiện lý do + nút "Đi tới S-8.2"; hiển thị version, `-draft`, số cờ đỏ sẽ in vào §I).
- `flintflow_fe/app/projects/[projectId]/view/page.tsx` (read-only projection: ẩn flags/assumptions/by/reason/readiness/stale; section bắt buộc chưa accepted hiện tiêu đề + "chưa hoàn thiện").
- `flintflow_fe/app/home/onboarding/page.tsx` (3 bước: tên/mục tiêu, chọn working mode mặc định, tạo project đầu) + BE nhỏ: `PATCH /users/me {name, onboardedAt}` (thêm vào `modules/user`, phối hợp A/C, ≤ 1 điểm).
- Test: `FlagsPanel.test.tsx`, `DiffPreviewModal.test.tsx`.

## Các bước implement
1. FlagsPanel + ReadinessSummary nối `GET /flags`, `GET /progress` (T09 thật).
2. DocumentPane nối `GET /document` (T15 thật) + ExportPanel.
3. ChangePanel + DiffPreviewModal + TraceabilityMap trên mock (T17 nối thật ở Wave 4).
4. Read-only view; onboarding.
5. Test; typecheck/lint.

## Dependency
- Phụ thuộc: T09, T12, T15; T17 (mock trước, nối thật tại Wave 4).
- Chặn: T23.
- Chạy song song với: T13, T14, T15.

## Output kỳ vọng
- Verification & Change panel thật; export UI; read-only view; onboarding.

## Tiêu chí hoàn thành (DoD)
- [x] FlagsPanel hiển thị cờ từ BE fixture; waive luật không waive được không có nút; waive hợp lệ cập nhật danh sách. (`FlagsPanel.test.tsx`, `useFlags.test.ts` — msw theo fixture)
- [x] DocumentPane render `RenderedDocument` fixture đủ 5 chương; chip stale đúng. (`DocumentPane.test.tsx`)
- [ ] Export Word draft tải về từ BE thật; chưa assemble hiện lý do + link S-8.2. (msw: `ExportPanel.test.tsx`, `handlers.change-flow.test.ts`; BE thật cần chạy tay)
- [x] ChangePanel chạy trọn trên mock; `/view` ẩn đúng các trường. (`ChangePanel.test.tsx`, `view/page.test.tsx`)
- [x] typecheck/lint/test xanh. (tsc 0 lỗi; lint 0 lỗi/14 warning baseline; 27 file / 181 test)

## Ghi chú / rủi ro
- Không có editor văn bản; chỉ NamesGlossaryPanel (T12) là form (§2.3).
