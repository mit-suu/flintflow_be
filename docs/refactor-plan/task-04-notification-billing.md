# Task 04 — Platform: Notification in-app + Billing mock gateway + sửa credit

**Wave:** 1 · **Người phụ trách:** C · **Effort:** 13 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Bổ sung hai mảng nền tảng còn thiếu hoàn toàn (Phases §9.2: 11.1 notification in-app; 9.1, 9.2, 9.6 credit ledger; 9.3/9.4 qua mock gateway) và sửa hai lỗi credit đã biết (reserve treo vĩnh viễn, deduct rồi lại release).

## Lệch hướng audit cần đóng
F3 (notification, billing), E1 (usage thiếu `expires_at`, tặng cứng 100 credit, `Subscription` không dùng), E2 (deduct trước parse rồi release).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Sửa: `flintflow_be/src/shared/ai/credit-reservation.service.ts` (thêm `expires_at` khi reserve = now + `CREDIT_RESERVE_TTL_MS` env, default 10 phút; `getOrCreateWallet` đọc `plan.config.free.initialCredits`; thêm `expireStaleReservations()`).
- Sửa: `flintflow_be/src/modules/credits/credit-transaction.model.ts` (thêm `expires_at?: Date`, `state?: reserved|deducted|refunded|expired`, `reservationId`).
- Sửa: `flintflow_be/src/shared/ai/ai-action.service.ts` (cả 2 hàm: parse trước, deduct sau parse thành công; biến `deducted` để catch chỉ release khi chưa deduct; xoá `Math.max(0, …)` che lỗi).
- Sửa: `flintflow_be/src/shared/ai/ai-action.route.ts` (`estimate-cost` thêm `authMiddleware`).
- Sửa: `flintflow_be/src/server.ts` (đăng ký `setInterval(expireStaleReservations, 60_000)`; không thêm queue lib).
- Sửa: `flintflow_be/src/modules/credits/subscription.model.ts` (dùng thật trong `POST /billing/upgrade`).
- Sửa: `flintflow_be/src/config/env.ts` (thêm `PAYMENT_WEBHOOK_SECRET`, `CREDIT_RESERVE_TTL_MS`, `MOCK_PAYMENT_URL`).
- Sửa: `flintflow_be/src/app.ts` mount `/api/v1/notifications`, `/api/v1/billing`.
- Sửa FE: `flintflow_fe/app/home/page.tsx:158` (badge `3` thành dữ liệu thật), `:166` (nhãn plan từ `/billing/balance`); `flintflow_fe/components/Sidebar.tsx` (`notificationCount` thật; link `/home/billing` đã có).
### Tạo mới
- `flintflow_be/src/modules/notification/{notification.model.ts, notification.service.ts, notification.controller.ts, notification.route.ts}` — model `{userId, type, title, body, link?, readAt?, meta?}`; `notify(userId, {type, title, body, link})`; routes `GET /notifications?unread=1`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`, `GET /notifications/unread-count`. Hàm `notifyAdmins(payload)`.
- `flintflow_be/src/modules/billing/{plan.config.ts, payment-intent.model.ts, billing.service.ts, billing.controller.ts, billing.route.ts, billing.validation.ts}` — `GET /billing/balance` (balance, reserved, plan, ledger 20 dòng gần nhất), `GET /billing/packages`, `POST /billing/checkout {packageId}` tạo `PaymentIntent{status:pending, amount, credits}` + `redirectUrl` mock, `POST /billing/webhook/mock` (HMAC `PAYMENT_WEBHOOK_SECRET`, idempotent theo `intentId`; success ghi `CreditTransaction{type:purchase}` + cộng `balance` + notify; failed notify), `POST /billing/upgrade {plan}` (ghi `Subscription`), `GET /billing/transactions?page=`.
- `flintflow_be/src/modules/billing/billing.test.ts`, `flintflow_be/src/shared/ai/credit-reservation.test.ts`.
- FE: `flintflow_fe/components/NotificationBell.tsx`, `flintflow_fe/app/home/notifications/page.tsx`, `flintflow_fe/app/home/billing/page.tsx` (số dư, gói, nút mua mở mock checkout page `app/home/billing/mock-checkout/page.tsx` gọi webhook mock với nút "Thanh toán thành công / thất bại"), `flintflow_fe/lib/api/notifications.ts`, `flintflow_fe/lib/api/billing.ts` (đặt tên theo T07; nếu T07 chưa merge thì tạo file và T07 gộp).

## Các bước implement
1. Notification model/service/routes + test.
2. Điểm phát notification vòng một: đăng ký thành công, thanh toán thành công/thất bại, credit dưới ngưỡng (`plan.config.lowCreditThreshold`), admin: user mới. (Gate/baseline sẽ gọi `notify` ở T13/T19.)
3. Billing model/service/routes; mock gateway là trang FE + webhook ký HMAC.
4. Credit fixes: `expires_at`, cron dọn, sửa thứ tự deduct, initial credits từ config.
5. FE: bell, trang notification, trang billing, mock checkout.
6. Swagger cho 2 module.

## Dependency
- Phụ thuộc: không.
- Chặn: T13 (meter dùng `expires_at`), T06 (admin đọc `CreditTransaction` mới), T19 (notify baseline).
- Chạy song song với: T01, T02, T03, T05, T06, T07.

## Output kỳ vọng
- Hai module BE mới có route + test; FE có chuông thông báo, trang thông báo, trang billing với mock thanh toán.

## Tiêu chí hoàn thành (DoD)
- [ ] Test: reserve rồi hết hạn, `expireStaleReservations` trả về `reserved` đúng và ghi `state=expired`.
- [ ] Test: parse lỗi thì không deduct, có release; parse ok thì deduct, không release.
- [ ] `curl` webhook mock có chữ ký đúng cộng credit; sai chữ ký trả 401; gửi lại cùng `intentId` không cộng lần hai.
- [ ] FE bell hiển thị số chưa đọc thật; đánh dấu đã đọc hoạt động.
- [ ] `POST /ai-actions/estimate-cost` không auth trả 401.

## Ghi chú / rủi ro
- Không tích hợp cổng thanh toán thật (Phases §9.2: mock/sandbox).
- `monthly_reset` (cron reset quota) để ngoài vòng một; ghi TODO có tên trong `plan.config.ts`.
