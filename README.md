# FlintFlow Backend API

> **FlintFlow** là nền tảng AI hỗ trợ soạn SRS theo template FPT. Người dùng đi theo một quy trình có hướng
> dẫn (12 phase, `51 + 5 × N` step); model chỉ phát **op**, code áp op vào **Spine** — cấu trúc dữ liệu duy
> nhất của SRS — rồi render ra tài liệu Word.

---

## ⚡ Tech Stack

- **Runtime & Framework**: Node.js 22, Express 5, TypeScript 5 (ESM — import nội bộ có đuôi `.js`)
- **Database**: MongoDB (replica set để dùng transaction), Mongoose 9, GridFS cho file sơ đồ
- **AI**: Vercel AI SDK, provider GLM / OpenAI / Anthropic / Gemini; prompt là skill trên đĩa
- **Sơ đồ**: PlantUML server (compile-check + render SVG/PNG)
- **Xuất tài liệu**: `docx`
- **Auth**: JWT hai token (access header + refresh cookie `httpOnly` xoay vòng, session trong DB), Google OAuth
- **Validation**: Zod · **Test**: Vitest · **Docs**: Swagger UI

---

## 📁 Kiến trúc

Chi tiết luồng step, luồng change và sơ đồ module: [`docs/architecture.md`](docs/architecture.md).
Hợp đồng HTTP/SSE của Spine, pipeline, change, flags, export: [`docs/api/pipeline-contract.md`](docs/api/pipeline-contract.md).

```
src/
├── config/                 # env (validate bằng Zod), database, swagger, startup checks
├── modules/
│   ├── spine/              # Spine schema/model/repository, op engine, cascade, 8 bất biến,
│   │                       # section registry + status, deterministic check, flags,
│   │                       # impact/change/reconcile/undo/traceability
│   ├── pipeline/           # step registry, context projection, draft-to-ops, step runner (SSE),
│   │                       # gate, meter, resume; s9/ (quét cuối, MoSCoW, baseline snapshot)
│   ├── diagram/            # 5 renderer PlantUML (context, usecase, screen_flow, erd, screen_layout)
│   ├── render/             # assemble section → RenderedDocument → .docx (watermark DRAFT)
│   ├── project/            # metadata project, chat session (is_pipeline), tài liệu upload
│   ├── notification/       # thông báo in-app
│   ├── billing/            # gói, checkout qua payment_service, callback
│   ├── credits/            # ví credit, giao dịch, subscription
│   ├── admin/              # chỉ đọc: users, metrics, chi phí AI; AiActionLog, PricingConfig
│   ├── auth/ · user/
├── shared/
│   ├── ai/                 # executeAiAction, ActionType, prompt/skill registry, response parser,
│   │                       # giữ/trừ credit, context tài liệu upload, provider
│   ├── diagram/            # PlantUML client + compile-check
│   ├── auth/ · email/ · middlewares/ · utils/ · types/ · db/
├── scripts/                # seed-fixture, export-schema, migrate-sections-to-spine, audit-ai-db
├── app.ts                  # mount route
└── server.ts
assets/
├── skills/                 # 32 skill BMAD: action/ content/ renderer/ output/ (SKILL.md + references/)
├── prompts/                # prompt phẳng cho action ngoài pipeline (chat, summarize_document)
├── schema/                 # JSON Schema của Spine (npm run schema:export)
└── step-registry.json      # 51 step + 5 × N — hợp đồng đóng băng
fixtures/                   # Spine mẫu 19 màn + minimal, các lô op mẫu
docs/                       # architecture, pipeline-contract, measurements, spec-gaps, migration-report
```

Luồng ghi duy nhất:

```
model → op[] → op-engine.applyTransaction() → Spine mới + changes[] → render/assemble → .docx
```

---

## 🚀 Chạy local

```bash
cp .env.example .env
npm ci
npm run dev            # tsx watch src/server.ts — cổng 5000
npm run typecheck
npm test               # vitest, provider AI mặc định là mock
npm run seed:fixture   # nạp Spine mẫu 19 màn cho một user
```

Swagger: `http://localhost:5000/api-docs`.

### Migration dữ liệu cũ (T21)

Project tạo trước refactor lưu nội dung ở collection `sections` (markdown theo section). Chuyển sang Spine:

```bash
npm run migrate:sections -- --dry-run                # chỉ đọc, ghi báo cáo docs/migration-report.md
npm run migrate:sections -- --project <projectId>    # một project
npm run migrate:sections                             # chạy thật
```

Best-effort: mọi section cũ thành `addendum[]` trỏ section FPT tương ứng; thêm vào đó `vision`, `goals[]` và
bảng use case parse được thành cấu trúc. Project mở lại ở B-0.1 và đi lại pipeline với addendum làm đầu vào. Script không
xoá collection cũ; chỉ migrate Spine chưa từng ghi nên chạy lại an toàn.

---

## 🐳 Docker

```bash
docker build -t flintflow-backend .
docker run -p 5000:5000 --env-file .env flintflow-backend
```
