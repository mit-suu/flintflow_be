# Vận hành FlintFlow

Chạy hệ thống trên máy, chạy bằng docker compose, biến môi trường, seed dữ liệu, sao lưu, xoay secret.
Kiến trúc code ở `docs/architecture.md` và `flintflow_fe/docs/fe-architecture.md`.

Hệ thống có **bốn** tiến trình: Mongo · PlantUML · backend (:5000) · frontend (:3000). Ba cái đầu là
phụ thuộc bắt buộc của backend — thiếu PlantUML thì diagram trả `render_status: "error"` chứ không làm
sập app, thiếu Mongo thì không làm gì được.

---

## 1. Chạy trên máy (dev)

```bash
# 1. hạ tầng
cd flintflow_be
cp .env.example .env            # điền secret thật
docker compose up -d mongo mongo-init plantuml

# 2. backend
npm ci
npm run seed:e2e-user           # tài khoản đăng nhập được ngay (đã verified + có credit)
npm run dev                     # :5000

# 3. frontend
cd ../flintflow_fe
cp .env.example .env.local
npm ci
npm run dev                     # :3000
```

Kiểm nhanh: `curl http://localhost:5000/health` phải trả `mongo: "ok"`, `plantuml: "ok"`.

Mongo của compose chạy **replica set `rs0`**, nên từ máy phải nối bằng `directConnection=true`:

```
MONGO_URI=mongodb://localhost:27017/flintflow?directConnection=true
```

Không có `directConnection`, driver sẽ đọc cấu hình replica set và cố nối tới `mongo:27017` — tên
service chỉ phân giải được bên trong mạng docker.

---

## 2. Chạy tất cả bằng docker compose

```bash
cd flintflow_be
cp .env.example .env
docker compose up -d            # mongo + mongo-init + plantuml + backend + frontend
docker compose ps
curl http://localhost:5000/health
open http://localhost:3000
```

| Service | Ảnh | Cổng | Ghi chú |
| --- | --- | --- | --- |
| `mongo` | `mongo:7` | 27017 | `--replSet rs0`; dữ liệu ở volume `mongo-data` |
| `mongo-init` | `mongo:7` | — | chạy `scripts/mongo-init-rs.sh` rồi thoát; chạy lại được |
| `plantuml` | `plantuml/plantuml-server:jetty-v1.2025.4` | 8080 | tag **được ghim** |
| `backend` | build từ `./Dockerfile` | 5000 | đợi `mongo-init` xong mới khởi động |
| `frontend` | build từ `../flintflow_fe/Dockerfile` | 3000 | đợi `backend` healthy |

Biến điều chỉnh: `BACKEND_PORT` · `FRONTEND_PORT` · `MONGO_PORT` · `PLANTUML_PORT` · `PLANTUML_TAG` ·
`MONGO_DB` · `PUBLIC_API_URL` · `GOOGLE_CLIENT_ID` · `AI_PROVIDER_OVERRIDE` · `FRONTEND_CONTEXT`.
Đặt cổng khác là cách chạy compose song song với stack dev đang mở trên máy.

`/health` trả:

```json
{"status":"ok","mongo":"ok","plantuml":"ok","version":"1.0.0","assets":{"prompts":2,"skills":32,"steps":56}}
```

`mongo: "error"` ⇒ `status: "error"` + HTTP 503 (load balancer rút instance ra). `plantuml: "error"` chỉ
là `degraded` + HTTP 200 — diagram hỏng nhưng phần còn lại phục vụ được, chặn deploy vì nó là phản ứng
thái quá.

**Vì sao replica set dù chỉ một node.** Mongo chỉ cho phép transaction đa document trên replica set.
`src/shared/db/transaction.ts` có đường dự phòng khi không có transaction, nhưng đường đó ghi theo thứ
tự khác và không nguyên tử. Dev nên chạy đúng cấu hình production; nếu replica set làm máy chậm, bỏ
`--replSet` khỏi `command` của service `mongo` — code vẫn chạy, chỉ là kém an toàn hơn khi ghi.

**Vì sao tag PlantUML được ghim.** Tag nổi `jetty` từng đổi hành vi báo lỗi giữa hai lượt
`docker compose pull`, làm `src/shared/diagram/plantuml.test.ts` đỏ mà không có commit nào đổi code.

**`NEXT_PUBLIC_API_URL` là địa chỉ của trình duyệt, không phải của docker.** Next nhúng mọi biến
`NEXT_PUBLIC_*` vào bundle lúc **build**, và bundle đó chạy trong trình duyệt của người dùng —
`http://backend:5000` chỉ phân giải được bên trong mạng compose. Đổi giá trị này phải **build lại**
image FE, không phải restart container.

Lệnh hay dùng:

```bash
docker compose logs -f backend
docker compose up -d --build backend     # build lại sau khi sửa code
docker compose down                      # giữ dữ liệu
docker compose down -v                   # XOÁ luôn volume Mongo
```

---

## 3. Biến môi trường

`src/config/env.ts` validate bằng zod và **thoát ngay** nếu sai — thiếu secret không được phép chạy
tiếp. `.env.example` là danh sách đầy đủ kèm giải thích; dưới đây chỉ là những chỗ dễ sai.

| Biến | Bắt buộc | Ghi chú |
| --- | --- | --- |
| `NODE_ENV` | production | phải là `production`. Để `development` trên môi trường thật thì `app.ts:76` **cho qua mọi origin** dù `credentials: true`, và toàn bộ refine `isProd` của `env.ts` (secret ≥ 32, `MONGO_URI`/`APP_PUBLIC_URL` không localhost) đều tắt — hỏng im lặng, không có log nào báo |
| `MONGO_URI` | có | production **không được** chứa `localhost` |
| `JWT_ACCESS_SECRET` `JWT_REFRESH_SECRET` | có | production: ≥ 32 ký tự, không phải placeholder. `openssl rand -base64 48` |
| `COOKIE_SAME_SITE` `COOKIE_DOMAIN` | production | FE và BE **khác site** (FE `flintflow.io.vn`, BE `*.azurewebsites.net`) ⇒ `COOKIE_SAME_SITE=none`, nếu để `lax` trình duyệt không gửi cookie `refreshToken` ⇒ `/auth/refresh` trả `MISSING_REFRESH_TOKEN`, user bị đăng xuất sau khi access token hết hạn (FLF-137). BE ở subdomain cùng site (`api.flintflow.io.vn`) ⇒ giữ `lax`, `COOKIE_DOMAIN=.flintflow.io.vn`. Local không lộ lỗi vì `localhost:3000`/`:5000` cùng site. App setting production đã đặt `none` + `COOKIE_DOMAIN` trống, nhưng **chưa có tác dụng**: image đang chạy dựng từ `origin/main`, ở đó `auth.controller.ts` hardcode `sameSite: "lax"` và chưa có `auth-cookie.ts` — biến này chỉ được đọc từ bản `develop` trở đi, nên FLF-137 còn sống cho tới khi merge develop → main |
| `MODAL_BASE_URL` | khi dùng skill `provider: glm` | **không còn default trong code**; để trống ⇒ `AI_PROVIDER_NOT_CONFIGURED` |
| `APP_PUBLIC_URL` | khi bật billing | domain public của **BE này** để payment service POST callback (`payment-service.client.ts:48`); production không được là localhost |
| `PLANTUML_BASE_URL` | production | thiếu ⇒ default `localhost:8080` ⇒ **mọi** diagram `render_status: "error"` trong khi `/health` vẫn trả HTTP 200. Production: `https://flintflow-plantuml.azurewebsites.net` (§5) |
| `PLANTUML_TIMEOUT_MS` | không | default 15000. Production đặt **30000**: use-case ~70 UC mất 13 s ở lượt đầu sau khi PlantUML restart (JVM chưa JIT-warm), warm còn ~4 s |
| `AI_PROVIDER_OVERRIDE` | không | ghi đè provider của mọi skill; chỉ dùng cho CI / smoke (`mock`) |
| `REVIEW_LLM_ENABLED` | không | S-9.2 Quality Lens bằng LLM, mặc định tắt |
| `FLINTFLOW_ASSETS_DIR` | không | ghi đè thư mục `assets/`; image production đã có `/app/assets` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (FE) | không | thiếu ⇒ **không có nút đăng nhập Google**, phần còn lại chạy bình thường (`lib/google-auth.ts`). Nhúng lúc build ⇒ đổi phải build lại image FE |

Vài quyết định hay bị hỏi lại:

- **Không có `PAYMENT_WEBHOOK_SECRET`.** `handlePaymentCallback` kiểm `client_id` rồi **đọc lại đơn
  hàng từ payment service** (`getPaymentOrder`) thay vì tin payload gửi tới. Chữ ký webhook sẽ là một
  secret nữa phải xoay mà không thêm được gì so với việc không tin payload.
- **Không có `DIAGRAM_STORAGE`.** Ảnh diagram đã render luôn nằm trong GridFS (bucket `diagram-files`),
  không có lựa chọn thứ hai để cấu hình.
- **Không có biến chọn provider cho từng skill.** Provider nằm ở frontmatter `SKILL.md` — nó là một
  phần của prompt, không phải một phần của môi trường. `AI_PROVIDER_OVERRIDE` là cửa thoát hiểm cho CI,
  không phải cách cấu hình thường ngày.

### Secret không bao giờ được commit

`.env`, `.env.local` nằm trong `.gitignore` của cả hai repo và **chưa từng** có trong lịch sử git
(kiểm bằng `git log --all -- .env.local` và `git log --all -S "<client id>"`). Chỉ `.env.example` được
theo dõi, và nó chỉ chứa placeholder.

```bash
git ls-files | grep -E '^\.env' | grep -v example    # phải rỗng ở cả hai repo
grep -rn "modal.direct" src/                          # phải rỗng
```

---

## 4. Seed dữ liệu

```bash
npm run seed:e2e-user -- --email fixture@flintflow.io --password fixture-password-123 --credits 1000
npm run seed:e2e-user -- --email admin@flintflow.io --role admin --credits 5000
npm run seed:fixture -- --user fixture@flintflow.io --fixture full   # Spine 19 màn
npm run migrate:sections -- --dry-run                                # project mô hình cũ → Spine
npm run migrate:mode1-v2 -- --dry-run                                # xem trước
npm run migrate:mode1-v2                                             # xoá index chết của CR-theo-block (an toàn)
npm run migrate:mode1-v2 -- --clean-data                             # + xoá vị trí CR bản cũ, bỏ field chết (một chiều)
```

**`migrate:mode1-v2` bắt buộc với DB đã chạy P2–P4 trước mode 1 v2 (FLF-186).** Vị trí CR giờ theo `path` phần tử
Spine, nhưng mongoose **không bao giờ xoá index cũ** nên `changelocations` còn `projectId_1_cr_id_1_block_id_1`
UNIQUE — vị trí V4 không có `block_id` ⇒ C-3 chết từ vị trí thứ hai với `E11000 … dup key: { …, block_id: null }`.
Lần chạy mặc định chỉ đụng index (tạo lại được); xoá dữ liệu phải tự gọi `--clean-data`. Unique index
`(projectId, cr_id, path)` chỉ tạo được sau khi hết vị trí bản cũ (chúng không có `path`).

**Mode 1 v3 (bám BPMN, 2026-09-22) — không cần migration.** Dữ liệu project mode 1 tạo trước v3 vẫn đọc được
nguyên trạng: baseline v1 đã ký, CR nguồn `chat` (enum giữ để đọc), cờ đã waive, version 0.x/1.0 cũ. Chỉ hành vi
**từ nay** đổi: sau import mọi sửa qua CR (`CHANGE_REQUIRES_CR`), không chạy step / ký v1 / waive (`MODE1_NO_*`),
CR mới không nhận nguồn `chat`. Version cũ không có bản có đánh dấu (`has_tracked_file: false` ⇒ tải `tracked` trả
bản thường); import cũ không có `image_ref` nên bản render cũ vẫn thiếu ảnh — muốn có ảnh thì import lại file.
Đọc ảnh diagram (phase 5) cần `GEMINI_API_KEY`; thiếu key ⇒ I-4 **không dừng**, ảnh được giữ nguyên + cờ vàng
`import_image_unread` (không trích được thực thể từ ảnh). Key free tier hết quota ngày sau ~20 ảnh ⇒ lượt lỗi thành
`paused: resume_later` — môi trường thật dùng key trả phí.

Trong docker compose, image production không có `tsx` nhưng có bản đã biên dịch:

```bash
docker compose exec backend node dist/scripts/seed-e2e-user.js --email fixture@flintflow.io --credits 1000
```

`seed:e2e-user` đặt `emailVerified: true` và nạp ví. **Không** dùng `POST /auth/register` cho môi
trường tự động: `login` từ chối tài khoản chưa xác thực email (`403 EMAIL_NOT_VERIFIED`) và trong CI
không có hộp thư nào để bấm link.

Tài khoản admin đầu tiên cũng được tạo tự động từ `ADMIN_EMAIL` / `ADMIN_PASSWORD` lúc khởi động.

---

### Render lại sơ đồ use case của dự án cũ

```bash
npm run rerender:usecase -- --dry-run   # liệt kê project và số hình, không ghi
npm run rerender:usecase                # render lại thật
```

Chạy **một lần** cho **mọi** dự án sau khi deploy bản sửa ký pháp sơ đồ use case — không bỏ qua nhóm
nào. `source_hash` chỉ hash `actors[]` + `use_cases[]`, không hash code vẽ, nên không dự án nào tự vẽ
lại và `diagram_stale` cũng không bắn; `.puml` đang lưu giữ nguyên bản sai chuẩn cũ (mũi tên trên cạnh
actor, actor nối thẳng vào use case mở rộng) mà không có tín hiệu nào báo.

Điều đó đúng với **cả** dự án một hình (`D02`) lẫn dự án đã tách sẵn (`D02-1`, `D02-2`): id phần đầu
luôn được giữ nguyên nên mọi phần đều trùng id cũ và trùng `source_hash` ⇒ `unchanged()` short-circuit.
`force: true` của script là đường duy nhất làm mới.

Script **không gỡ id nào** khi số phần không đổi, nên baseline đã ký trỏ `diagram-ref:D02` hay
`diagram-ref:D02-1` vẫn nạp được ảnh §2.2.1 từ store. Số phần giảm (dự án rút bớt use case) thì phần
dư mới bị gỡ — đó là hành vi có sẵn, không phải do bản sửa này.

**Sao lưu Mongo trước** (mục 6): script ghi hàng loạt vào `diagrams[]` và file store.

Không dùng `POST /:projectId/diagrams/usecase/render {"force": true}` thay cho script: route đó không
truyền `step_id`, nên change ghi `step_id: null` và `fixed:2.2.1` bị đánh `stale` ⇒ cờ đỏ ở S-9.5.
Script truyền `step_id: "S-3.6"` đúng bước sở hữu section.

---

### Chạy step pipeline mà không gọi model

`AI_PROVIDER_OVERRIDE=mock` ghi đè provider của **mọi** skill; `mock.provider.ts` trả output hợp schema
theo `ActionType` (lô op **rỗng**). Đủ để một step đi trọn `Intake → Elicit → Draft → Render → Review →
gate_ready` trong ~0,3 s mà không ra mạng và không tốn credit thật:

```bash
AI_PROVIDER_OVERRIDE=mock docker compose up -d --wait backend
npm run run:pipeline -- --api http://localhost:5000/api/v1 --until B-0.2 --name "Smoke mock"
```

Nó chứng minh **đường đi**, không chứng minh nội dung — mock không đọc được Spine nên không sinh op nào.
Kiểm nội dung thì dùng fixture op-case (`fixtures/op-cases/`) hoặc provider thật (`E2E_AI=1`).

## 5. Production trên Azure

Subscription `Azure for Students`, region Southeast Asia.

| Thành phần | Tài nguyên | App Service Plan |
| --- | --- | --- |
| Backend | Web App `flintflow-be` (RG `flintflow-be_group`), image từ ACR `flintflowacr` | `ASP-mitsu-b404` (B1) — dùng chung với `payment-service` và 2 app khác |
| PlantUML | Web App `flintflow-plantuml` (RG `flintflow-be_group`), image `plantuml/plantuml-server:jetty-v1.2025.4` kéo thẳng từ Docker Hub, **không qua ACR** | `asp-flintflow-plantuml` (B1) — **của riêng nó** |
| Frontend | không nằm trên Azure | — |

**Vì sao PlantUML có plan riêng.** Nó là JVM và phải bật Always On, tức giữ RAM thường trú. Nhét chung
vào plan B1 đang gánh 4 app (trong đó có `payment-service`) thì khi thiếu RAM App Service không giết
riêng app gây áp lực mà restart cả plan — một sự cố render sẽ kéo theo cả thanh toán.

**Vì sao Always On.** ~10-20 lượt generate/ngày nên container idle gần như cả ngày. Không bật thì App
Service unload sau ~20 phút, và lượt render kế tiếp lãnh cold start JVM 10-30 s — vượt
`PLANTUML_TIMEOUT_MS`. Đây là lý do phải trả tiền cho plan B1 thay vì dùng Free.

App setting của `flintflow-plantuml`: `WEBSITES_PORT=8080` · `PLANTUML_LIMIT_SIZE=8192` · Always On ·
HTTPS only. Thiếu `WEBSITES_PORT` thì app trả 503 vĩnh viễn và log chỉ nói "container didn't respond to
HTTP pings", không nói gì về cổng.

**Mạng.** `.puml` chứa dữ liệu khách hàng, nên `flintflow-plantuml` chỉ nhận request từ outbound IP của
`flintflow-be` (26 rule Allow + Deny all mặc định). Hệ quả: curl thẳng từ máy vào PlantUML trả **403** —
đó là đúng, đường kiểm còn lại là `/health` của BE. Đổi plan của BE làm đổi outbound IP ⇒ phải thêm rule
cho dải mới:

```bash
az webapp show -g flintflow-be_group -n flintflow-be --query possibleOutboundIpAddresses -o tsv
az webapp config access-restriction add -g flintflow-be_group -n flintflow-plantuml --rule-name allow-be-<n> --action Allow --ip-address <ip>/32 --priority <n>
```

`deploy.yml` **không phải đổi**: PlantUML là app độc lập, không nằm trong pipeline.

### Smoke test sau khi deploy

`/health` trả **HTTP 200 cả khi PlantUML hỏng** (`degraded`, `health.ts:10-11`), nên `curl -sf` một mình
không phát hiện được — phải kiểm từng thành phần, nếu không PlantUML chết sẽ âm thầm làm mọi diagram
`render_status: "error"` mà không ai biết:

```bash
body=$(curl -sf https://<api>/health) || { echo "BE không trả lời"; exit 1; }
echo "$body" | jq
echo "$body" | grep -q '"mongo":"ok"'    || { echo "Mongo hỏng"; exit 1; }
echo "$body" | grep -q '"plantuml":"ok"' || { echo "PlantUML hỏng ⇒ diagram sẽ render_status: error"; exit 1; }

# đi vài step đầu của pipeline bằng provider thật, không đụng dữ liệu người dùng
npm run run:pipeline -- --api https://<api>/api/v1 --until S-1.4 --name "Smoke $(date -I)"
```

`src/scripts/run-full-pipeline.ts` tự đăng nhập, tạo project, chạy `run` → trả lời Elicit → `gate accept`
cho từng step, rồi ghi báo cáo markdown. Bỏ `--until` thì nó đi trọn `B-0.1 → S-9.5 → assemble → Word →
baseline` — đó là lượt chạy của mốc **M4** (số liệu ở `docs/measurements.md`). Một lượt trọn tốn vài
trăm credit và 30–60 phút, nên smoke test thường ngày hãy dùng `--until`.

---

## 6. Sao lưu và phục hồi Mongo

```bash
# sao lưu (từ máy, Mongo của compose)
docker compose exec -T mongo mongodump --archive --gzip --db flintflow > backup-$(date +%F).gz

# phục hồi
docker compose exec -T mongo mongorestore --archive --gzip --drop < backup-2026-09-16.gz
```

Ảnh diagram nằm trong GridFS **cùng database**, nên `mongodump` đã bao gồm chúng; không có thư mục file
nào phải sao lưu riêng. Tài liệu người dùng upload nằm ở Cloudinary — sao lưu theo chính sách của
Cloudinary, không nằm trong `mongodump`.

Trước khi phục hồi lên môi trường đang chạy: dừng backend (`docker compose stop backend`) để không có
lượt ghi nào xen vào giữa, phục hồi xong mới bật lại.

---

## 7. Xoay secret

Thứ tự đúng để không làm rơi request nào:

1. **JWT.** Đổi `JWT_ACCESS_SECRET` làm mọi access token đang lưu hành hết hiệu lực ngay — người dùng
   phải đăng nhập lại. Làm vào giờ thấp điểm; refresh token cũng phải đổi (`JWT_REFRESH_SECRET`) nếu
   nghi ngờ lộ, và khi đó xoá luôn collection refresh token.
2. **Khoá provider AI** (`MODAL_*`, `OPENAI_API_KEY`…): tạo khoá mới ở nhà cung cấp → cập nhật biến →
   restart backend → thu hồi khoá cũ. Không thu hồi trước khi restart: mọi step đang chạy sẽ hỏng giữa
   chừng và credit đã reserve phải đợi TTL mới hoàn.
3. **`PAYMENT_API_KEY`**: phối hợp với payment service; `client_id` đổi thì callback cũ bị từ chối
   (`INVALID_CLIENT_ID`), nên đổi cả hai phía trong cùng một cửa sổ.
4. **Google client id**: giá trị public theo thiết kế, nhưng vẫn phải đổi ở cả `GOOGLE_CLIENT_ID` (BE)
   và `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (FE, cần **build lại** image FE).

Sau mỗi lần xoay: `curl /health` và một lượt đăng nhập thật.

---

## 8. CI/CD

| Workflow | Repo | Chạy khi | Làm gì |
| --- | --- | --- | --- |
| `backend-ci` | be | push/PR main·master·develop | typecheck (cả test) · unit + integration + coverage · build |
| `docker` | be | push/PR main·master·develop | build image BE và FE · `docker compose up` thật rồi kiểm `/health` và transaction |
| `deploy` | be | push `main` | build → ACR → Azure Web App |
| `frontend-ci` | fe | push/PR main·master·develop | typecheck · lint · unit · build · **e2e Playwright** trên BE thật |
| `docker` | fe | push/PR main·master·develop | build image FE, chạy thử container |

Ba lỗi đã sửa vì sẽ hỏng ngay lượt chạy đầu (T24):

1. **`npm ci` hỏng trên Linux ở cả hai repo.** Lockfile sinh trên Windows thiếu optional dependency chỉ
   có ở nền tảng khác (`@emnapi/runtime`, `@emnapi/core` ở FE; `yaml` ở BE) ⇒
   `EUSAGE ... lock file is not in sync`. Nghĩa là **mọi** workflow và mọi image Docker đều chết ở bước
   cài. Sinh lại bằng `npm install --package-lock-only` trong container Linux (chỉ thêm entry thiếu,
   không đổi version). Lần sau chạm dependency nên làm y vậy.
2. job `e2e` của `frontend-ci` đặt `MONGODB_URI` và `JWT_SECRET` — **tên biến không tồn tại** trong
   `env.ts` (phải là `MONGO_URI`, `JWT_ACCESS_SECRET`), nên BE nối vào nhầm database;
3. job đó seed tài khoản bằng `POST /auth/register`, tạo ra tài khoản `emailVerified: false` mà kịch bản
   e2e **không đăng nhập được**. Giờ dùng `npm run seed:e2e-user`.

Mongo trong job `e2e` là **standalone** — `services:` của GitHub Actions không đổi được `command` của
container nên không bật được replica set. Đường có transaction được kiểm ở job `compose-health` của
workflow `docker`.
