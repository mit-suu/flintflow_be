# Task 23 — FE tích hợp thật toàn bộ + e2e + dọn mock

**Wave:** 5 · **Người phụ trách:** D · **Effort:** 6 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Nối mọi panel FE vào BE thật (bỏ `NEXT_PUBLIC_API_MOCK` khỏi runtime), sửa drift so với contract phát sinh ở Wave 3–4, thêm Playwright e2e một kịch bản đầu-cuối, nhãn song ngữ từ step registry.

## Lệch hướng audit cần đóng
Đảm bảo C1/C6/C8/B4 phần FE thực sự đóng trên BE thật; dọn nợ FE còn lại.

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Sửa: `flintflow_fe/mocks/*` (chỉ dùng trong vitest; gỡ `browser.ts` khỏi `app/layout.tsx`), `flintflow_fe/lib/api/*` (đối chiếu `pipeline.dto.ts`), `hooks/*`, mọi `_components/*` mới (T12, T16, T20), `app/home/page.tsx`, `components/ProjectCard.tsx` (`STEP_LABELS` cứng thay bằng `progress.current_step` + registry; variant theo readiness thay `progressPercent`), `components/Sidebar.tsx`.
- Sửa: `flintflow_fe/package.json` (thêm `@playwright/test`, script `e2e`), `.github/workflows/ci.yml` (job e2e: khởi BE với `AI_PROVIDER=mock` + mongo memory hoặc service, chạy Playwright).
### Tạo mới
- `flintflow_fe/e2e/{workspace.spec.ts, playwright.config.ts}` — kịch bản: đăng ký (hoặc seed user), login, onboarding, tạo project, B-0.1 trả lời, … (rút gọn qua fixture minimal seed), chạy S-2.1, gate Accept, xem Document pane có §1, Verification hiện 0 cờ đỏ, Export Word draft tải về (kiểm content-type).
- `flintflow_fe/lib/i18n.ts` (nhỏ: `t(step, "vi"|"en")` từ registry; ngôn ngữ UI theo `user.locale` mặc định vi).
- `docs/fe-architecture.md` (routing, hooks, api layer, mock trong test).

## Các bước implement
1. Tắt mock runtime; chạy toàn bộ luồng trên BE dev; ghi drift rồi sửa FE (hoặc PR `contract-change` nếu BE sai).
2. ProjectCard/home dùng dữ liệu Spine.
3. Playwright + CI job.
4. i18n nhãn; docs.

## Dependency
- Phụ thuộc: toàn bộ Wave 4; T21 (legacy đã gỡ để không còn call site cũ).
- Chặn: M5, T24 (e2e chạy trong compose).
- Chạy song song với: T21, T22, T24.

## Output kỳ vọng
- FE hoàn toàn trên BE thật; e2e xanh trên CI.

## Tiêu chí hoàn thành (DoD)
- [ ] `grep -rn "NEXT_PUBLIC_API_MOCK" app lib components` rỗng (chỉ còn trong test/mocks).
- [ ] Playwright kịch bản pass trên CI với BE mock provider.
- [ ] Không còn `STEP_LABELS`/`progressPercent` trong `ProjectCard`.
- [ ] typecheck/lint/test/build xanh.

## Ghi chú / rủi ro
- e2e dùng mock provider BE để ổn định; luồng AI thật kiểm tay tại M4/M5.
