# Task 07 — FE foundation: typed API layer, domain types, gỡ hardcode/demo, Document pane read-only

**Wave:** 1 · **Người phụ trách:** D · **Effort:** 6 điểm · **Trạng thái:** [ ] Chưa làm  [x] Đang làm  [ ] Xong

## Mục tiêu
Dọn nền FE để Wave 2 xây workspace v2: tách API client theo resource, gom domain types vào `types/`, bỏ editor trực tiếp trong Document pane (§2.3), xoá dữ liệu demo hardcode, bỏ khoá export theo %, gỡ Excalidraw/dep không dùng, thêm test runner.

## Lệch hướng audit cần đóng
C1 (FE: Document pane có nút Sửa ghi đè), C6 (VerificationPane demo hardcode), C8 (khoá export theo progress), B4 (nút "Yêu cầu sửa" chỉ prefill chat), D1 phần FE (`/draw-test`), nợ kỹ thuật FE (vòng import, type nằm trong component, dep thừa).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Sửa: `flintflow_fe/lib/api.ts` giữ nội dung làm `lib/api/client.ts`; `lib/api.ts` re-export để không phá call site cũ trong wave này.
- Sửa: `flintflow_fe/lib/auth.ts` (bỏ import `setAccessToken` từ api; chuyển `saveAuthToken` vào `lib/api/token-store.ts` để phá vòng).
- Sửa: `flintflow_fe/lib/ai-stream.ts` (import `ChatSession` từ `types/chat.ts`; tổng quát hoá thành `streamSse<T>(path, body, handlers)` dùng cho step runner sau).
- Sửa: `flintflow_fe/app/projects/[projectId]/_components/DocumentPane.tsx` (xoá state `editingSectionType/editBuffer/savingEdit`, nút Sửa, `PUT /:type`; xoá prop `workspacePhase`, `onAssembleSRS`; render markdown bằng `react-markdown` + `remark-gfm`; giữ tạm copy/tải `.md` đến T16).
- Sửa: `flintflow_fe/app/projects/[projectId]/_components/VerificationPane.tsx` (xoá L38-80 demo fallback, L136-155 card tĩnh, L258-260 "84%"; nếu `res.data` rỗng hiện empty state "Chưa có dữ liệu kiểm tra").
- Sửa: `flintflow_fe/app/projects/[projectId]/_components/PhaseNavBar.tsx:52-54,84`, `WorkspaceHeader.tsx` (bỏ khoá Export theo `progressPercent`/baseline; Export luôn bấm được, T16 sẽ hiển thị lý do khi chưa có bản ghép).
- Sửa: `flintflow_fe/app/projects/[projectId]/_components/ChatInput.tsx` (`creditEstimate` từ `POST /ai-actions/estimate-cost`), `ChatPane.tsx` (sửa kiểu `onSendMessage` khớp 2 tham số), `DiscoveryStepBar.tsx` (xoá prop chết `onStepClick`).
- Sửa: `flintflow_fe/app/projects/[projectId]/page.tsx` (xoá `handleSaveSectionContent`; ẩn nút rollback + `ConfirmRollbackModal` sau flag `ROLLBACK_ENABLED=false`).
- Sửa: `flintflow_fe/components/Sidebar.tsx` (gỡ `/draw-test`, `/home/account`, `/home/history`; giữ `/home/billing`, thêm `/home/notifications`).
- Sửa: `flintflow_fe/app/home/page.tsx` (search box lọc thật theo tên).
- Xoá: `flintflow_fe/app/draw-test/`, `flintflow_fe/components/diagram/ExcalidrawWrapper.tsx`, `flintflow_fe/types/excalidraw.d.ts`, `flintflow_fe/packages/excalidraw/` (nếu chỉ là node_modules rác), `app/logo-preview` (nếu không dùng).
- Sửa: `flintflow_fe/package.json` gỡ `@excalidraw/excalidraw`, `@excalidraw/mermaid-to-excalidraw`, `@ai-sdk/react`, `ai`, `iconsax-react`, `@types/lodash.throttle`; thêm `react-markdown`, `remark-gfm`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`; script `test`.
- Sửa: `flintflow_fe/next.config.ts` (bỏ `turbopack: {}` hoặc bỏ `--webpack` trong script; chọn một).
- Sửa: `flintflow_fe/.env.local` gỡ Google client ID thật; `.env.example` giữ placeholder.
### Tạo mới
- `flintflow_fe/lib/api/{client.ts, token-store.ts, projects.ts, chat.ts, documents.ts, spine.ts, pipeline.ts, flags.ts, export.ts, notifications.ts, billing.ts, admin.ts, index.ts}` — mỗi file là hàm typed wrap endpoint (ban đầu wrap endpoint hiện có; `spine/pipeline/flags/export` chỉ có chữ ký theo contract T08, điền ở T12/T16).
- `flintflow_fe/types/{project.ts, chat.ts, user.ts, spine.ts, pipeline.ts, flags.ts, document.ts}` — `spine.ts` copy thủ công từ `spine.types.ts` BE tại M1 (ghi chú "đồng bộ tay, nguồn là BE").
- `flintflow_fe/vitest.config.ts`, `flintflow_fe/test/setup.ts`, `flintflow_fe/components/Modal.test.tsx` (smoke).

## Các bước implement
1. Tách `lib/api/`, phá vòng import, thêm `index.ts`.
2. Tạo `types/`, chuyển interface ra khỏi `WorkspaceHeader`, `PhaseNavBar`, `ChatSessionSidebar`, `ProjectCard`, `VerificationPane`.
3. DocumentPane read-only + markdown renderer.
4. VerificationPane: xoá demo.
5. Bỏ khoá export; sửa ChatInput/ChatPane/DiscoveryStepBar; ẩn rollback.
6. Gỡ draw-test và dep; thêm vitest + smoke test.
7. Chạy `typecheck`, `lint`, `build`, `test`.

## Dependency
- Phụ thuộc: không; đồng bộ `types/spine.ts` với T01 tại M1.
- Chặn: T12, T16, T06 (dùng `lib/api/admin.ts`), T04 FE (dùng `lib/api/notifications.ts`, `billing.ts`).
- Chạy song song với: T01, T02, T03, T04, T05, T06. (T04 và T06 cùng tạo file trong `lib/api/`: thống nhất tên file ngay đầu wave; ai merge sau thì rebase.)

## Output kỳ vọng
- FE build xanh, không còn Excalidraw, Document pane chỉ đọc, VerificationPane không còn số giả.

## Tiêu chí hoàn thành (DoD)
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` xanh. *(typecheck/build/test xanh; lint còn 2 lỗi có sẵn ở `app/admin/prompt-templates/page.tsx` thuộc vùng T06)*
- [x] Grep các chuỗi demo (`Sinh viên & Tài xế`, `84%`) trong `VerificationPane.tsx` trả rỗng.
- [x] Không còn `PUT /specifications/projects/.../{type}` trong FE.
- [x] `lib/auth.ts` không import từ `lib/api/client.ts`.

## Ghi chú / rủi ro
- Wave này vẫn chạy với BE cũ (section-based); mục tiêu là dọn, không đổi luồng. Luồng mới ở T12.
