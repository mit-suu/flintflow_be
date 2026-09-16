# Testing — FlintFlow backend

Ba tầng test, chung một `vitest.config.ts` (mỗi tầng là một *project* của vitest):

| Project | File | Mongo | Provider AI | Chạy ở CI |
| --- | --- | --- | --- | --- |
| `unit` | `src/**/*.test.ts` (colocate cạnh code) | Không — model giả trong bộ nhớ | Mock | Có |
| `integration` | `test/integration/**/*.test.ts` | Mongo in-memory (replica set 1 node) | Mock ở tầng `callLLM` | Có |
| `e2e-ai` | `test/e2e-ai/**/*.test.ts` | Mongo in-memory | **Thật**, chỉ khi `E2E_AI=1` | Không |

## Lệnh

```bash
npm test                  # cả ba project (e2e-ai tự bỏ qua khi không có E2E_AI=1)
npm run test:unit         # chỉ unit — nhanh, không cần Mongo
npm run test:integration  # chỉ integration
npm run test:coverage     # unit + integration + coverage (giống CI), báo cáo ở coverage/
npm run typecheck         # src/
npm run typecheck:test    # src/ + test/ + vitest.config.ts (test/tsconfig.json)

npm test -- test/integration/billing.int.test.ts   # một file
npm test -- -t "INSUFFICIENT_CREDIT"               # lọc theo tên test
```

Lần đầu chạy integration, `mongodb-memory-server` tải binary `mongod` (~70 MB) vào `~/.cache/mongodb-binaries`
(CI cache thư mục này). Máy không có mạng: đặt `MONGOMS_SYSTEM_BINARY` trỏ tới `mongod` có sẵn.

## Unit (`src/**/*.test.ts`)

- **Không** nối Mongo, không có `setupFiles`. Nhiều test dựa vào `mongoose.connection.readyState !== 1` để
  đi nhánh `TRANSACTION_UNAVAILABLE` với model giả — đừng thêm kết nối vào project này.
- Mẫu mock model Mongoose: `src/modules/spine/op-engine.test.ts` (`vi.hoisted` + `vi.mock("./spine.model.js")`).

## Integration (`test/integration/`)

Chạy `app` thật qua HTTP (supertest) trên Mongo thật. `test/global-setup.ts` dựng **một** replica set cho cả
lượt; `test/setup.ts` cho mỗi worker một database riêng (`flintflow-test-<VITEST_POOL_ID>`), xoá dữ liệu trước
mỗi test, dựng index (unique `(projectId, seq)` của `changes` là thứ khoá lạc quan dựa vào).

`test/setup.ts` đặt trước khi `app` được import:

| Biến | Giá trị | Vì sao |
| --- | --- | --- |
| `MONGO_URI` | Mongo in-memory | `app.ts` gọi `connectDB()` ngay lúc import |
| `NODE_ENV` | `test` | |
| `SMTP_USER`, `SMTP_PASS` | rỗng | không gửi mail thật dù máy có `.env` |
| `PAYMENT_SERVICE_URL` | rỗng | `payment-service.client` bị mock trong test billing |
| `PAYMENT_CLIENT_ID` | `flintflow-test-client` | callback so `client_id` với biến này |
| `PLANTUML_BASE_URL`, `PLANTUML_TIMEOUT_MS` | cổng đóng, 1000 | render trả `render_status: "error"` ngay, kết quả không phụ thuộc máy có PlantUML hay không |

### Helper

| Helper | File | Việc |
| --- | --- | --- |
| `seedFixture(kind, opts)` | `test/setup.ts` | user → project → Spine (`spineSchema.parse`) → chat session `is_pipeline` → ví credit (mặc định 1000; `balance: null` ⇒ không tạo ví). `mutate` sửa Spine trước khi ghi. Trả `projectId`, `sessionId`, `spineVersion`, `token`. |
| `authAs(user)` | `test/setup.ts` | access token thật (cùng secret với `authMiddleware`) |
| `parseSse(text)` | `test/setup.ts` | tách luồng SSE của `/steps/:id/run` thành mảng event |
| `mockLlmRouterModule()` | `test/helpers/mock-llm.ts` | provider giả **ở tầng `callLLM`**: reserve/trừ/hoàn credit, parse, retry, `AiActionLog`, `Usage` đều là code thật. Draft trả op từ `fixtures/op-cases/<nhóm>/<step>.json` theo step trong prompt; elicit trả "không hỏi thêm"; change instruction mặc định hỏi lại. `mockOverrides.next` ghi đè từng lượt (trả chuỗi JSON hoặc `Error`). |
| `runStepHttp`, `gateHttp`, `startAt(step, targets?)` | `test/helpers/pipeline.ts` | gọi `/run` + `/gate`, gom event và mã lỗi (dù lỗi trả JSON hay event `error`); seed tiến độ |
| `loadOpCase`, `userWritableOps` | `test/helpers/op-cases.ts` | 10 ca op T02 |

```ts
vi.mock("../../src/shared/ai/providers/llm.router.js", async () =>
  (await import("../helpers/mock-llm.js")).mockLlmRouterModule()
)
import app from "../../src/app.js"          // import app SAU vi.mock
import { seedFixture } from "../setup.js"
```

### Bộ test hiện có

| File | Phủ |
| --- | --- |
| `spine-api.test.ts` | endpoint 1: 401, Spine fixture, lazy-create, 404 project người khác |
| `op-engine.int.test.ts` | endpoint 7, 8, 10, 11: 10 ca op T02 qua `/changes`, `base_version` cũ ⇒ 409, **hai request đồng thời chỉ một thắng**, undo, `path_not_writable` |
| `flags.int.test.ts` | endpoint 2, 12–14: fixture 19 màn 0 cờ, cờ đỏ fixture minimal, waive (không waive được / lý do ngắn / thành công), cờ đóng khi sửa |
| `pipeline-s3.int.test.ts` | endpoint 3, 4, 6: S-1.2 → S-3.6 qua SSE + gate, credit trừ đúng tổng `Usage`; lỗi `SPINE_VERSION_CONFLICT`, `NOT_PIPELINE_SESSION`, `INSUFFICIENT_CREDIT`, provider lỗi ⇒ hoàn credit |
| `change-flow.int.test.ts` | endpoint 7–11, 15: instruction → preview → apply không gọi lại model, `NEEDS_CLARIFICATION`, nhánh `dependent`/`post_baseline`, lý do bắt buộc sau baseline, reconcile, traceability |
| `baseline-export.int.test.ts` | endpoint 16–20: `NO_WORKING_DRAFT`, `BASELINE_BLOCKED`, assemble → document → `.docx`, baseline v1.0 + document/Word của baseline |
| `billing.int.test.ts` | balance/packages/transactions, checkout, callback `paid` cộng credit **đúng một lần kể cả 3 callback đồng thời**, `failed`, `client_id` sai |
| `notification.int.test.ts` | welcome + `admin_new_user` khi tạo ví, phân trang, đánh dấu đã đọc, cô lập giữa user |
| `op-case-eval.int.test.ts` | bộ chấm của `e2e-ai` với executor giả |
| `measure-tokens.int.test.ts` | driver `measure()` chế độ estimate |

## E2E với provider thật (`test/e2e-ai/`)

```bash
E2E_AI=1 npm run test:e2e-ai        # bash
$env:E2E_AI="1"; npm run test:e2e-ai  # PowerShell
```

- Cần key provider trong `.env` (skill hiện dùng `glm` ⇒ `MODAL_API_KEY`, `MODAL_PROXY_TOKEN_ID`,
  `MODAL_PROXY_TOKEN_SECRET`). **Tốn credit provider thật.** Không có `E2E_AI=1` thì cả file bị skip.
- `op-cases.e2e.test.ts`: 10 ca op T02, mỗi ca đi đúng đường production (`buildStepContext` → `draftOps`,
  retry schema ≤ 2, `executeAiAction` trừ credit trên ví seed). Kết quả ghi `test/e2e-ai/results/op-cases-<thời điểm>.md`;
  DoD T22 là ≥ 8/10 pass ở lần chạy ghi nhận — **ghi số thật, không làm tròn**.
- Luật chấm (`test/helpers/op-case-eval.ts`):
  - ca áp được: PASS khi có lô op hợp lệ **và** mỗi op kỳ vọng user ghi được có op cùng loại + cùng path
    (không so `value`);
  - ca `must_reject`: PASS khi lô cuối không chứa trọn bộ op sai. Cột ghi chú tách "model không sinh op sai"
    với "validator chặn op sai" — chỉ trường hợp đầu nói lên chất lượng model.
  - Ca bị `DraftRejectedError` không có token/credit trong bảng (lỗi không mang `usage`) — xem `AiActionLog`.

## Đo token (`npm run measure:tokens`)

`src/scripts/measure-tokens.ts` — xem chú thích đầu file. Tóm tắt:

```bash
npm run measure:tokens                                  # estimate, fixture 19 màn, ghi docs/measurements.md
npm run measure:tokens -- --fixture minimal --no-write  # in ra màn hình
npm run measure:tokens -- --mode real-draft             # draft gọi provider thật (tốn credit)
npm run measure:tokens -- --mode real --usd-in 0.15 --usd-out 0.6
```

- Mỗi step của `orderedSteps(fixture)` chạy `runStep` thật trên Spine ở trạng thái cuối (mọi step trước
  accepted) ⇒ input đo được là trần của step.
- `estimate` không gọi model: tokens_in = ký tự/4 của **prompt thật**; tokens_out ước lượng từ op-case fixture
  (không gồm reasoning ẩn). `real-draft`/`real`: số do provider báo, lấy từ `usages`.
- Chỉ thay khối giữa `<!-- T22:measure-tokens:start/end -->` trong `docs/measurements.md`; so với bảng
  `## Threshold` nhóm đặt (ô trống ⇒ "chưa đặt").
- Tự dựng Mongo in-memory; `--mongo-uri` để dùng Mongo khác — **đừng trỏ DB thật**, script ghi đè Spine của
  project nó tạo.

## Coverage

`npm run test:coverage` (v8). Ngưỡng trong `vitest.config.ts`: `src/modules/spine/**` và
`src/modules/pipeline/**` ≥ 70% lines — CI đỏ nếu tụt. Báo cáo HTML/lcov ở `coverage/` (CI upload artifact
`backend-coverage`).

## Lưu ý Windows

Vitest ghi lại snapshot chỉ vì CRLF: `git checkout -- <snapshot>` trước khi commit.
