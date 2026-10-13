# Job nền: BullMQ + Redis

Việc chạy lâu hoặc phải thử lại khi lỗi không chạy trong request HTTP, cũng không chạy kiểu `void fn()` trong tiến trình
API. Những việc này được đưa vào hàng đợi trên Redis, rồi tiến trình **worker** riêng nhận và xử lý.

## Vì sao làm

| Trước (in-process) | Sau (BullMQ) |
|---|---|
| Server khởi động lại thì job import đang chạy bị mất, người dùng phải bấm "Tiếp tục" | Job nằm trong Redis. Worker chết giữa chừng thì job bị đánh dấu *stalled* và worker khác nhận chạy lại |
| Gửi SMTP lỗi thì chỉ in OTP ra console, không gửi lại | Retry với backoff (OTP: 3 lần; mail mời: 5 lần) |
| Đăng ký hoặc quên mật khẩu phải chờ SMTP xong (~2–3 s) | API chỉ đưa job vào hàng đợi (~200 ms) |
| Job AI vài phút chạy chung tiến trình với API | Tách worker ra, scale riêng bằng `--scale worker=N` |
| Code ghi "Giả định một instance BE" | Chống trùng job qua Redis, chạy được nhiều instance |
| Không xem được job nào đang chạy hay lỗi | Bull Board tại `/api/v1/admin/queues` (chỉ admin) |

## Kiến trúc

```
API ──enqueue──▶ Redis ◀──nhận job── worker (src/worker.ts)
 │                                      │
 └────────── MongoDB (trạng thái nghiệp vụ) ◀──┘
```

**Mongo vẫn là nguồn sự thật.** Trạng thái `extracting`, `paused`… của import vẫn nằm ở `ImportedDocument`. Queue chỉ
quyết định *ai chạy và khi nào*. Vì vậy mọi processor phải chạy lại được an toàn.

| Queue | Job | Chống trùng | Retry | Song song |
|---|---|---|---|---|
| `import` | `extract` (I-4), `finalize` (1.10–1.12 / resume `checking`) | `extract-<importId>`, `finalize-<importId>` | 2 lần, backoff 30 s | `JOB_IMPORT_CONCURRENCY` (2) |
| `embedding` | `sync` | `embed-<projectId>`, gộp lượt khi đang chạy (`keepLastIfActive`) | 3 lần, backoff 10 s | 1 |
| `email` | `otp`, `invitation` | không | OTP 3 lần / 5 s; mời 5 lần / 30 s | 5 |
| `system` | `topup-resume` (chạy tiếp mode 1 sau khi nạp tiền), `expire-reservations` (mỗi phút) | `topup-<intentId>` | 3 lần | 4 |

Vì sao chạy lại được an toàn:
- **I-4** đi tiếp từ `extract_cursor`, nên section đã trích không gọi AI lại.
- **Finalize** khi retry làm đúng như người dùng bấm "Tiếp tục": hoàn về mốc (`finalize_checkpoint`) rồi chạy lại. Nếu
  đã sang `checking` thì chỉ chạy phần 1.11–1.12 còn thiếu.
- **Embedding** chỉ embed phần tử có `text_hash` thay đổi.
- **Lỗi nghiệp vụ** (`ApiError` 4xx như sai trạng thái hay hết credit) **không retry**, vì chạy lại cũng không khá hơn.
- **Hết lượt retry** thì `onFinalFailure` đưa nghiệp vụ về trạng thái nhất quán, ví dụ `paused: resume_later` cho
  import, hoặc in OTP ra console như trước.

## Hai driver (`JOB_DRIVER`)

- **`inline`** (mặc định): job chạy trong tiến trình API, một lần, không retry, đúng hành vi cũ. Dev, test và CI
  không cần Redis. `vitest.config.ts` ép driver này cho test.
- **`bullmq`**: cần `REDIS_URL`. Worker chạy bằng `npm run worker` (hoặc `npm run dev:worker`). Để chạy chung một
  terminal khi dev, đặt `WORKERS_IN_PROCESS=true`.

Code nằm ở `src/shared/queue/`:
- `job-runner.ts`: `defineJob`, `startJob`, `enqueueJob`, `isJobActive`, `waitForJob`
- `workers.ts`: worker, graceful shutdown
- `board.ts`: Bull Board

Danh sách module khai báo job nằm ở `src/jobs.ts`. **Thêm job mới thì phải thêm module của nó vào đây**, nếu không
worker sẽ không biết processor.

## Chạy

```bash
# Dev: Redis trong docker, API và worker trên máy
docker compose up -d mongo mongo-init redis plantuml
JOB_DRIVER=bullmq REDIS_URL=redis://localhost:6379 npm run dev         # terminal 1
JOB_DRIVER=bullmq REDIS_URL=redis://localhost:6379 npm run dev:worker  # terminal 2

# Toàn bộ bằng compose (backend + worker đã đặt sẵn JOB_DRIVER=bullmq)
docker compose up -d
docker compose up -d --scale worker=3
```

Dùng chung một Redis cho nhiều môi trường (ví dụ máy dev và production cùng trỏ Redis Cloud) thì **mỗi môi trường phải có
`QUEUE_PREFIX` riêng** (ví dụ `flintflow-dev`). Nếu không, worker trên máy dev sẽ nhận job của production.

Cấu hình Redis bắt buộc phải có `maxmemory-policy noeviction` (compose đã đặt). Bật AOF để job không mất khi Redis
khởi động lại. `/health` có thêm trường `redis`; Redis chết thì `status: degraded`.

## Kiểm thử

- `src/shared/queue/job-runner.test.ts`: kiểm driver inline.
- `src/shared/queue/job-runner.bullmq.test.ts`: kiểm với Redis thật (chống trùng, retry, hết lượt, gộp lượt):
  ```bash
  docker run -d --name ff-redis-test -p 6390:6379 redis:7-alpine
  TEST_REDIS_URL=redis://localhost:6390 npx vitest run src/shared/queue
  ```

## Kịch bản demo độ bền

1. `docker compose up -d`, đăng nhập admin, mở `/api/v1/admin/queues`.
2. Bấm finalize một SRS lớn. Job `finalize` xuất hiện ở trạng thái *active*.
3. Chạy `docker compose kill worker` để tắt worker giữa chừng.
4. Chạy `docker compose start worker`. Sau tối đa ~2 phút (`lockDuration`), job bị đánh dấu *stalled* và được chạy lại
   từ mốc. Import đi tới `gap_review` mà không cần ai bấm "Tiếp tục".
5. Muốn demo nhanh hơn: tắt worker rồi đăng ký tài khoản mới. Job `email/otp` nằm chờ trong Redis, bật worker lên là
   mail được gửi ngay.

## Lưu ý

- Job email OTP mang mã dạng rõ trong Redis. Vì vậy job bị xoá ngay khi xong, job lỗi chỉ giữ 10 phút, code không log
  `job.data`, và Redis không mở cổng ra ngoài ở production.
- `docker stop` cho worker 60 s (`stop_grace_period`) để kết thúc job đang chạy. Quá hạn thì job bị *stalled* và được
  worker khác nhận lại.
