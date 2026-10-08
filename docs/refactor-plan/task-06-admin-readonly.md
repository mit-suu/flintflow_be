# Task 06 — Admin read-only 10.1–10.3 (user list, metrics, AI cost)

**Wave:** 1 · **Người phụ trách:** D · **Effort:** 6 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Bổ sung mặt admin đọc theo Phases §9.2 (10.1 user list, 10.2 metrics, 10.3 AI cost) trên nền `AiActionLog`, `CreditTransaction`, `User`, `Project` đã có. Không làm suspend/adjust credit (10.4–10.7 hoãn).

## Lệch hướng audit cần đóng
F3 (admin chỉ có prompt template). Phụ: trang admin prompt dùng raw fetch thay `apiCall`.

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `flintflow_be/src/modules/admin/ai-action-log.model.ts`, `flintflow_be/src/modules/credits/credit-transaction.model.ts`, `flintflow_be/src/modules/user/user.model.ts`, `flintflow_be/src/shared/auth/admin.middleware.ts`.
- Sửa: `flintflow_be/src/app.ts` mount `/api/v1/admin` (router mới bên cạnh `/admin/prompt-templates`).
- Sửa FE: `flintflow_fe/app/admin/layout.tsx` (thêm sidebar admin: Users, Metrics, AI Cost, Prompt Templates, Feedback); `flintflow_fe/app/admin/prompt-templates/page.tsx` (bỏ `getAuthHeaders` raw fetch, dùng `apiCall`; ẩn nút tạo/sửa/activate theo T03 read-only).
- Sửa FE: `flintflow_fe/proxy.ts` (admin đăng nhập chuyển tới `/admin/metrics` thay `/admin/prompt-templates`).
### Tạo mới
- `flintflow_be/src/modules/admin/{admin.controller.ts, admin.route.ts, admin.service.ts, admin.validation.ts}` — `GET /admin/users?page&limit&role&isActive&q` (kèm `wallet.balance`, `projectsCount`, `lastLoginAt` nếu có từ `Session`), `GET /admin/users/:id` (chi tiết + 20 transaction gần nhất), `GET /admin/metrics` (`usersTotal, usersNew7d, projectsTotal, projectsActive7d, baselinesTotal` (0 đến khi T19), `aiCallsToday, aiFailRate7d`), `GET /admin/ai-cost?from&to&groupBy=day|actionType|provider|user` (aggregate `AiActionLog` tokens + `CreditTransaction{type:deduct}` credits; loại `state=refunded`; kèm `estimatedUsd` theo bảng giá `plan.config.providerUsdPer1k` từ T04 hoặc hằng tạm), `GET /admin/feedback` (stub `[]`, model feedback để wave sau).
- FE: `flintflow_fe/app/admin/users/page.tsx` (bảng phân trang, filter), `flintflow_fe/app/admin/users/[id]/page.tsx`, `flintflow_fe/app/admin/metrics/page.tsx` (thẻ số + bảng), `flintflow_fe/app/admin/ai-cost/page.tsx` (bảng theo ngày/actionType, tổng), `flintflow_fe/lib/api/admin.ts`.
- `flintflow_be/src/modules/admin/admin.test.ts` (403 cho user thường, 200 cho admin).

## Các bước implement
1. Service aggregate với Mongo pipeline; index bổ sung `AiActionLog {createdAt:1}` nếu thiếu.
2. Controller + zod validation + route (`authMiddleware, adminMiddleware`).
3. FE 3 trang + layout sidebar; dùng `apiCall`; không dùng lib chart (bảng là đủ vòng một).
4. Sửa trang prompt-templates dùng `apiCall`.
5. Swagger tag `Admin`.

## Dependency
- Phụ thuộc: không (đọc field `CreditTransaction` mới của T04 nếu đã merge; nếu chưa, dùng field cũ và cập nhật tại M1).
- Chặn: không.
- Chạy song song với: T01, T02, T03, T04, T05, T07.

## Output kỳ vọng
- 4 endpoint admin đọc + 3 trang FE hiển thị dữ liệu thật.

## Tiêu chí hoàn thành (DoD)
- [ ] User thường gọi `/admin/*` nhận 403; admin nhận 200.
- [ ] `ai-cost` khớp tổng `CreditTransaction{type:deduct}` trong khoảng ngày trên DB dev.
- [ ] Trang prompt-templates không còn `localStorage.accessToken` trực tiếp.
- [ ] FE typecheck/lint xanh.

## Ghi chú / rủi ro
- 10.4–10.7 (suspend, adjust credit, feedback dashboard) hoãn theo Phases §9.2.
