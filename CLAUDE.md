# FlintFlow — Backend

Nền tảng AI hỗ trợ soạn thảo SRS: người dùng trò chuyện theo một quy trình có hướng dẫn, model chỉ sinh
**op**, code áp op vào một cấu trúc dữ liệu duy nhất rồi render ra tài liệu Word theo template FPT.

Repo này đang trong đợt refactor lớn theo `context/srs-spine.md` + `context/Product-Brief-to-SRS-Phases.md`
(24 task, 5 wave). Kế hoạch, quy tắc và báo cáo nằm ở repo riêng `claude_plan`
(thư mục anh em `../claude_output`): `plan-overview.md`, `coding-rules.md`, `task-01…24-*.md`,
`task-report-template.md`. **Đọc `coding-rules.md` trước khi sửa code** — nó có bảng vùng sở hữu file
theo task, điều cấm, và quy trình yêu cầu chéo (XREQ).

## Lệnh

```bash
npm run dev          # tsx watch src/server.ts (cổng 5000)
npm run typecheck    # tsc --noEmit
npm test             # vitest run — test colocate cạnh code (src/**/*.test.ts)
npm test -- src/modules/spine/          # chạy một thư mục
npm run build        # tsc -p tsconfig.build.json
npm run seed:fixture # nạp fixtures/spine-fixture-19-screens.json vào Mongo
npm run migrate:sections -- --dry-run   # chuyển project cũ (collection `sections`) sang Spine, ghi docs/migration-report.md
npm run eval:usecase-s3 -- --label X --runs 3   # đo chất lượng S-3 (actor/use case/include-extend) bằng provider thật, fixtures/s3-eval
```

Node 22, ESM (`"type": "module"`) — **mọi import nội bộ phải có đuôi `.js`** kể cả khi file nguồn là `.ts`.

## Kiến trúc: mọi thứ xoay quanh Spine

`Spine` (`src/modules/spine/spine.types.ts`) là **một document Mongo mỗi project**, chứa toàn bộ nội dung
SRS dưới dạng có cấu trúc: `project`, `actors[]`, `use_cases[]`, `features[]`, `screens[]`, `functions[]`,
`entities[]`, `nfrs[]`, `business_rules[]`, `messages[]`, `glossary[]`, `diagrams[]`, `flags[]`,
`steps[]`, `progress`… Tách ra collection riêng vì giới hạn 16MB: `changes`, `usages`, `baselines`.

Luồng ghi **duy nhất**:

```
model → op[] → op-engine.applyTransaction() → Spine mới + changes[] → render/assemble → .docx
```

- **Op** (`op.types.ts`): `{op: set|add|remove|renumber, path, value?, reason?}`. `path` phân giải
  **qua khoá, không qua chỉ số**: `actors[id=A03].name`, `permissions[screen_id=S3,role_id=R1,action=create]`.
- **Transaction**: áp tuần tự → mở rộng **cascade** (xoá phần tử đang bị tham chiếu) → kiểm **8 bất biến**
  và schema ở **cuối lô** → ghi `changes[]` (mỗi change có `before`, đủ để revert).
- **Khoá lạc quan**: mọi request ghi mang `base_version`; lệch ⇒ `409 SPINE_VERSION_CONFLICT`. Một
  transaction tăng `spine_version` đúng một lần.
- **Giá trị suy diễn không lưu DB**: `status` của section, `% tiến độ`, `awaiting_reaccept` đều là hàm
  tính (`section-status.ts`). Lưu chúng là vi phạm.

## Quy trình 12 phase

`51 step cố định + 5 × N` (N = số màn + 1 nếu có function không thuộc màn nào). Nguồn sự thật:
`assets/step-registry.json` + `src/modules/pipeline/step-registry.ts`. Step của vòng S-5 mang id
`S-5.<n>@<screen_id>` hoặc `S-5.<n>@nonscreen`.

Mỗi step chạy khung: **Intake → Elicit → Draft → Render → Review → Gate → Meter**
(`step-runner.service.ts`). Gate có 4 hành động `accept · revision · regenerate · accept_as_is`, trần
**8 lượt gọi model/step** và **3 regenerate/step**.

Context đưa cho model là **projection** của Spine theo `reads` của step, **không bao giờ là cả Spine hay
cả transcript** (`context-projection.ts`).

## Điều cấm (PR bị từ chối ngay)

1. Ghi thẳng vào Spine bằng `Model.updateOne/save` ngoài `spine.repository` / `op-engine`.
2. Lưu giá trị suy diễn (`status` section, `progressPercent`) vào DB.
3. Ghi raw text của model vào Spine khi parse thất bại — parse lỗi chỉ thành thông báo cho lượt retry.
4. Nạp toàn transcript hoặc toàn Spine vào prompt.
5. Bỏ qua bất biến, bỏ `base_version`, nới trần 8 lượt / 3 regenerate.
6. Thêm endpoint không có trong `docs/api/pipeline-contract.md`.
7. Dùng `any` mới trong `modules/spine`, `modules/pipeline`.
8. Hard-code URL provider, secret, client id, dữ liệu demo.
9. Commit secret / `.env`.

## Hợp đồng đã đóng băng (sửa phải qua PR nhãn `contract-change`, 4/4 duyệt)

`src/modules/spine/spine.schema.ts` · `op.types.ts` · `section-registry.ts` (bảng §4) ·
`src/modules/pipeline/pipeline.dto.ts` · `docs/api/pipeline-contract.md` · `assets/step-registry.json` ·
`src/modules/render/rendered-document.types.ts`.

Trước khi thêm mã lỗi hay field mới: **kiểm tra cái đang có đã đủ chưa**. Phần lớn nhu cầu đã được T08
lường trước trong `pipeline.dto.ts`.

## Bản đồ module

| Đường dẫn | Việc |
|---|---|
| `modules/spine/` | Spine schema/model/repository; op engine, path resolver, cascade, 8 bất biến |
| `modules/spine/{section-registry,section-status,deterministic-check,flags.service}.ts` | Section theo template FPT, status là hàm tính, 11 luật cờ đỏ + 11 cờ vàng |
| `modules/spine/{impact,change,reconcile,undo,traceability}.service.ts` | Sửa qua hội thoại: impact query, 3 nhánh, hoà giải, undo, bản đồ truy vết |
| `modules/pipeline/` | Step registry, projection, draft-to-ops, step runner, gate, meter, resume |
| `modules/diagram/` | 5 renderer PlantUML + compile-check + lưu file |
| `modules/render/` | Assemble section → `RenderedDocument` → `.docx` |
| `modules/pipeline/s9/` | Quét cuối, đối chiếu mục tiêu, MoSCoW, ký baseline + snapshot |
| `modules/{notification,billing,credits,admin,project,user,auth,feedback,folder}/` | Nền tảng. `Project` chỉ còn metadata (`name`, `domain`, `status`, `mode` — `import` | `fpt` | `customer_template`, mặc định `fpt`, xem `project.model.ts`; `folderId` — thư mục, `PATCH /projects/:id/folder`). `folder`: CRUD `/folders`, `POST /folders/:id/projects` thêm nhiều dự án, xoá thư mục giữ dự án. `lastOpenedAt` ghi khi `GET /projects/:id`. `feedback`: `POST /feedback` (UC-12), admin đọc qua `GET /admin/feedback` |
| `shared/ai/` | `ActionType`, prompt registry, response parser, provider, context tài liệu upload |
| `assets/skills/` | 32 skill BMAD (`action/`, `content/`, `renderer/`, `output/`), mỗi skill một `SKILL.md` |
| `assets/prompts/` | Prompt phẳng chỉ cho `chat`, `summarize_document` |
| `src/scripts/migrate-sections-to-spine.ts` | Migration dữ liệu section cũ → Spine (op `migrate`) |

Mô hình section markdown cũ (module `specification`/`verification`, rollback chat, các field tiến độ trên
`Project`, prompt `generate_section`…) **đã xoá ở T21**. Sơ đồ module, luồng step và luồng change:
`docs/architecture.md`.
| `fixtures/` | Spine mẫu 19 màn + minimal, các lô op mẫu để test |

## Skill (prompt)

Prompt sống trong `assets/skills/<kind>/<id>/SKILL.md`: frontmatter là hợp đồng (provider, model,
`reads`, `writes`, `output_schema`, `stub`), thân là hướng dẫn cho model. **Không có DB override** —
registry chỉ đọc đĩa.

- `draftOps` **không nạp** `references/*.md`, nên mọi luật cần thiết phải nằm trong chính `SKILL.md`,
  và `SKILL.md` bị khoá **≤ 150 dòng** (`src/shared/ai/prompt-assets.test.ts`). `references/` chỉ là tài
  liệu cho người đọc.
- `fallbackModels` (tuỳ chọn, hiện chỉ provider `gemini`): model dự phòng cùng provider, thử lần lượt khi model chính
  quá tải (503 / 429 không phải hết tiền / timeout). Log AI ghi model thật sự trả lời.
- Skill chưa viết mang `stub: true`; viết thật rồi thì bỏ `stub` **và** thêm thư mục vào
  `WRITTEN_NON_ACTION` trong `prompt-assets.test.ts`.
- `writes` trong frontmatter phải nằm trong `writes` của step tương ứng ở `assets/step-registry.json`.

## Test

Ba project vitest (`vitest.config.ts`), `npm test` chạy cả ba:

- **`unit`** — colocate `src/**/*.test.ts`; không `setupFiles`, **không nối Mongo**. Test cần DB thì mock model
  Mongoose bằng store trong bộ nhớ — mẫu `src/modules/spine/op-engine.test.ts` (`vi.hoisted` +
  `vi.mock("./spine.model.js")`). `npm run test:unit`.
- **`integration`** — `test/integration/**`; Mongo in-memory replica set (`mongodb-memory-server`, dựng một lần ở
  `test/global-setup.ts`, mỗi worker một database) + supertest qua `app` thật. `test/setup.ts` trỏ `MONGO_URI`
  trước khi import `app`, xoá dữ liệu trước mỗi test, có helper `seedFixture(kind)`, `authAs(user)`, `resetDb()`.
  `npm run test:integration`.
- **`e2e-ai`** — `test/e2e-ai/**`, cùng khung Mongo in-memory, gọi **provider thật**; chỉ chạy khi `E2E_AI=1`
  (`npm run test:e2e-ai`), kết quả ghi `test/e2e-ai/results/`. Đo token trọn pipeline:
  `npm run measure:tokens -- --mode real-draft|real`.

- Provider AI **mặc định là mock** trong test; `AI_PROVIDER_OVERRIDE=mock` (env) ép mọi skill dùng mock cho lượt
  chạy không ra mạng (CI, smoke). Nhánh `E2E_AI=1` còn lại trong `modules/pipeline/skills/*.e2e.test.ts`
  (T14/T18) thuộc project `unit` nên **không chạy được** (`executeAiAction` cần Mongo để reserve credit) —
  đo thật thì dùng hai lệnh trên, không dùng nhánh đó.
- Test cần PlantUML (`src/shared/diagram/plantuml.test.ts`, `diagram.plantuml.test.ts`) tự skip khi không có server;
  có server ở cổng khác thì đặt `PLANTUML_BASE_URL`.
- `npm run typecheck:test` kiểm kiểu cho `test/**`. CI chạy `typecheck`, `typecheck:test`, `test:coverage`.
- File mới phải có ít nhất một test đi kèm. Không xoá test đang xanh của người khác để PR mình pass.
- Snapshot bị vitest ghi lại chỉ vì CRLF trên Windows: `git checkout -- <snapshot>` trước khi commit.

## Tài liệu phải cập nhật khi làm việc

- `docs/spec-gaps.md` — tài liệu thiếu/mâu thuẫn phát hiện khi implement. **Ai cũng được thêm dòng**, không
  sửa dòng người khác.
- `docs/measurements.md` — số token/chi phí đo được. Thêm mục, không xoá mục người khác.
- `docs/api/pipeline-contract.md` — chỉ đổi cùng PR `contract-change`.
- `claude_output/plan-overview.md` mục 8 + file task tương ứng + báo cáo theo `task-report-template.md`.

## Git

- `develop` là gốc; mỗi task một nhánh `feat/FLF-<số>-<slug>`. PR tiêu đề `[TXX][Wave N] <tên task>`,
  mô tả là báo cáo theo mẫu, cần 1 reviewer khác người và CI xanh.
- Commit nhỏ, message dạng `tXX: <việc làm>`. Không gộp nhiều task vào một commit.
- **Khi tạo commit message, không thêm `Co-Authored-By: Claude <noreply@anthropic.com>`** — cũng không
  nhắc Claude/AI ở bất kỳ đâu trong message.
- **Gộp commit hợp lý, tránh commit vụn vặt** (`coding-rules.md` §7). Chỉ commit khi xong một đơn vị việc
  có nghĩa: một bước trong DoD, hoặc một module hoàn chỉnh kèm test. Mục tiêu **3–5 commit cho một task**,
  không phải 8–10. Không tạo commit riêng cho: sửa typo, format lại, chạy lại test, hay sửa lỗi do chính
  commit ngay trước gây ra — gộp vào commit đó (`git commit --amend`) khi nhánh chưa push.
- Không format lại toàn file; diff chỉ chứa dòng thực sự đổi.

## Quy ước ngôn ngữ

Tiếng Anh cho: tên field Spine (snake_case đúng như tài liệu), nội dung render vào SRS, nhãn `.puml`.
Tiếng Việt cho: nhãn UI, thông báo lỗi cho user, comment nội bộ.
