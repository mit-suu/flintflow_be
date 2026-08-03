# CLAUDECONTEXTWINDOW.md — FlintFlow Backend Context Snapshot

> **Purpose**: High-density, token-efficient architecture context for AI Coding Agents & team members.
> **Instruction**: Read this file first to gain complete system context before analyzing individual files.

---

## 1. Project Overview & Rules

- **Platform**: FlintFlow Backend — AI-powered Software Specification Platform.
- **Node Environment**: Node v22, ES Modules (`"type": "module"` in `package.json`).
- **ES Module Import Rule**: ALL relative imports in TypeScript files MUST include `.js` extension (e.g., `import { env } from "./config/env.js"`).
- **TypeScript**: Strict mode enabled. No `any` without explicit rationale.
- **Type Checking Command**: `npx tsc --noEmit`.

---

## 2. System Architecture & Directory Map

```
src/
├── config/
│   ├── env.ts                   # Type-safe env vars (JWT secrets/expiry, Mongo URI, SMTP, Google OAuth, APP_URL)
│   ├── database.ts              # Mongoose DB connection
│   └── swagger.ts               # Swagger OpenAPI scanner (scans ./src/modules/**/*.ts)
├── shared/
│   ├── ai/                      # AI Action Framework (Single entrypoint executeAiAction)
│   │   ├── ai-action.types.ts   # ActionType enum (7 types), AiActionResult, AiActionError
│   │   ├── ai-action.service.ts # executeAiAction() — core orchestrator
│   │   ├── ai-action.controller.ts # HTTP handlers (/estimate-cost, /execute, /retry/:logId)
│   │   ├── ai-action.route.ts   # Express router & Swagger OpenAPI specs
│   │   ├── prompt-registry.service.ts # DB template lookup, in-memory TTL caching & {{var}} interpolation
│   │   ├── response-parser.ts   # Zod schema validation & markdown JSON extraction per ActionType
│   │   ├── credit-reservation.service.ts # Reserve → Deduct / Release transactions & wallet auto-creation
│   │   ├── retry.service.ts     # Transient error detection & in-request automatic backoff retry
│   │   └── providers/           # Multi-provider LLM adapters
│   │       ├── provider.types.ts# Unified LLMResponse interface
│   │       ├── llm.router.ts    # Provider router (openai | anthropic | gemini)
│   │       ├── openai.provider.ts # OpenAI Chat Completions adapter
│   │       ├── anthropic.provider.ts # Anthropic Messages adapter
│   │       └── gemini.provider.ts  # Google Gemini adapter (JSON mode bật sẵn — xem mục 7)
│   ├── auth/                    # Core Auth Infrastructure (DO NOT duplicate in modules)
│   │   ├── jwt.util.ts          # Sign/verify access & refresh tokens, SHA-256 hash helper
│   │   ├── session.model.ts     # MongoDB Session collection (hashed refresh tokens)
│   │   ├── session.service.ts   # Session creation, rotation, revocation & reuse detection
│   │   └── auth.middleware.ts   # Bearer access token verification middleware
│   ├── constants/
│   │   └── http-status.ts       # HTTP_STATUS object constants
│   ├── email/
│   │   ├── email.service.ts     # Nodemailer SMTP sender (console fallback if SMTP creds missing)
│   │   └── templates.ts         # HTML email templates (verify email, reset password)
│   ├── middlewares/
│   │   ├── error-handler.ts     # Global error handler returning standard response format
│   │   └── rate-limit.ts        # In-memory rate limiter factory + authEmailRateLimiter (3 req/15min/IP)
│   ├── types/
│   │   ├── api-response.ts      # ApiResponse<T> interface & helper functions
│   │   └── express.d.ts         # Express Request declaration extension (req.user)
│   └── utils/
│       ├── api-error.ts         # ApiError class (statusCode, message, code)
│       └── catch-async.ts       # Controller async wrapper
├── modules/
│   ├── auth/                    # Auth HTTP handlers (register, login, refresh, logout, logout-all, verify-email, forgot/reset-password, google) + auth-token.model.ts
│   ├── user/                    # User profile queries (/me, /:id) & User model
│   ├── project/                 # Projects & chat sessions (Project, ChatSession)
│   ├── specification/           # Specification sections & version history (Section, SectionVersion)
│   ├── verification/            # Aggregated project verification context (VerificationContext)
│   ├── credits/                 # Credit wallet, transactions & subscriptions (CreditWallet, CreditTransaction, Subscription)
│   └── admin/                   # Prompt templates, AI action logs & pricing configs (PromptTemplate, AiActionLog, PricingConfig)
├── scripts/
│   ├── prompts/                 # ⭐ MD-based prompt templates (xem mục 7 bên dưới)
│   │   ├── README.md            # Hướng dẫn sử dụng & format file .md
│   │   ├── summarize.md
│   │   ├── extract.md
│   │   ├── analysis.md
│   │   ├── clarification.md
│   │   ├── generate_section.md
│   │   ├── verification.md
│   │   └── rewrite.md
│   ├── seed-from-md.ts          # ⭐ Script chính: đọc .md → upsert MongoDB (xem mục 7)
│   ├── seed-prompt-templates.ts # Script cũ (legacy, không dùng nữa — dùng seed-from-md.ts)
│   └── cleanup-duplicate-users.ts
├── app.ts                       # Express app setup, middleware, base routes & error handler
└── server.ts                    # HTTP server listener
```

---

## 3. Database Schema Models (Mongoose)

| Model Name | Module Location | Key Fields & Indexes |
|---|---|---|
| **User** | `modules/user/user.model.ts` | `email` (unique), `passwordHash`, `authProvider` (`local`\|`google`), `googleId` (sparse), `name`, `role` (`user`\|`admin`), `isActive`, `emailVerified`, `emailVerifiedAt`. Virtual `password`. |
| **AuthToken** | `modules/auth/auth-token.model.ts` | `userId` (ref User), `type` (`verify_email`\|`reset_password`), `tokenHash` (unique, SHA-256), `expiresAt` (TTL index), `usedAt`. One-time use. TTL: verify=24h, reset=15m. |
| **Session** | `shared/auth/session.model.ts` | `userId` (ref User), `tokenHash` (unique, SHA-256), `expiresAt`, `isRevoked`, `userAgent`, `ip`. |
| **Project** | `modules/project/project.model.ts` | `userId` (ref User), `name`, `domain`, `status` (`active`\|`archived`), `currentStep`, `progressPercent`. Compound Index: `{ userId: 1, status: 1 }`. |
| **ChatSession** | `modules/project/chat-session.model.ts` | `projectId` (ref Project), `messages` array (`role`, `content`, `createdAt`), `isActive`. Compound Index: `{ projectId: 1, isActive: 1 }`. |
| **Section** | `modules/specification/section.model.ts` | `projectId` (ref Project), `type` (15 section types), `content` (`Schema.Types.Mixed`), `status`, `sourceType`, `order`. Unique Index: `{ projectId: 1, type: 1 }`. |
| **SectionVersion** | `modules/specification/section-version.model.ts` | `sectionId` (ref Section), `versionNumber`, `content`, `diffSummary`, `changedFields`, `factVsAssumption`, `createdBy`. Unique Index: `{ sectionId: 1, versionNumber: 1 }`. |
| **VerificationContext** | `modules/verification/verification-context.model.ts` | `projectId` (ref Project, unique), `hiddenAssumptions`, `missingInfo`, `conflicts`, `ambiguities`, `readinessScore`, `readinessStatus`, `lastComputedAt`. |
| **CreditWallet** | `modules/credits/credit-wallet.model.ts` | `userId` (ref User, unique), `balance`, `reserved`. |
| **CreditTransaction** | `modules/credits/credit-transaction.model.ts` | `userId` (ref User), `projectId`, `actionType`, `amount`, `type` (`reserve`\|`deduct`\|`release`\|`monthly_reset`\|`purchase`), `balanceAfter`. Index: `{ userId: 1, createdAt: -1 }`. |
| **Subscription** | `modules/credits/subscription.model.ts` | `userId` (ref User, unique), `plan` (`free`\|`pro`), `status`, `monthlyCreditsAllotment`, `currentPeriodStart`, `currentPeriodEnd`. |
| **PromptTemplate** | `modules/admin/prompt-template.model.ts` | `actionType`, `template`, `provider`, `aiModel`, `maxTokens`, `temperature`, `version`, `isActive`, `updatedBy` (ref User). Compound Indexes: `{ actionType: 1, version: 1 }` (unique), `{ actionType: 1, isActive: 1 }`. |
| **AiActionLog** | `modules/admin/ai-action-log.model.ts` | `projectId`, `userId`, `actionType`, `provider`, `aiModel`, `status`, `promptTokens`, `completionTokens`, `latencyMs`, `retryOfLogId`. Indexes: `{ projectId: 1, createdAt: -1 }`, `{ userId: 1, createdAt: -1 }`. |
| **PricingConfig** | `modules/admin/pricing-config.model.ts` | `actionCosts`, `planLimits`, `isActive`, `updatedBy` (ref User). Index: `isActive`. |

---

## 4. API Standard Contract

All Express controllers return responses adhering to this schema:

```typescript
type ApiResponse<T> = {
  data: T | null;
  meta?: Record<string, unknown>;
  error: { code: string; message: string } | null;
};
```

- **Success Helper**: `sendSuccess(res, statusCode, data, meta?)` -> `{ data: T, meta?: ..., error: null }`
- **Error Helper**: `sendError(res, statusCode, code, message, meta?)` -> `{ data: null, error: { code, message } }`

---

## 5. Security & Authentication Flow

1. **Access Token**: Short-lived (`15m`), passed via `Authorization: Bearer <token>` header. Decoded by `authMiddleware` into `req.user`.
2. **Refresh Token**: Long-lived (`3d`), stored in `httpOnly`, `sameSite: 'strict'`, `secure` cookie.
3. **Rotation & Session**: Every `/auth/refresh` call revokes old session in DB, signs new token pair, and sets new cookie.
4. **Reuse Detection**: Presenting a revoked refresh token revokes **all active sessions** for that user immediately.
5. **Email Verification**: Local users start `emailVerified=false`; login blocked with `403 EMAIL_NOT_VERIFIED` until magic-link confirmed. Google users auto-verified.
6. **Email Magic Links** (`AuthToken`): raw random token only in email URL; DB stores SHA-256 hash. One-time use, TTL expiry (verify 24h / reset 15m). `reset-password` revokes ALL sessions after password change.
7. **Email Service**: `shared/email/` via Gmail SMTP; if `SMTP_USER`/`SMTP_PASS` unset → magic link logged to console (dev fallback).
8. **Rate Limit**: `authEmailRateLimiter` (3 req/15min/IP) on `verify-email/resend`, `forgot-password`, `reset-password`.

---

## 6. AI Action Framework & Credit Reservation Flow

1. **Single Entrypoint**: All AI interactions must pass through `executeAiAction(actionType, input, projectId, userId, options)`. Direct LLM API calls outside `shared/ai/` are prohibited.
2. **7 ActionTypes**: `summarize`, `extract`, `analysis`, `clarification`, `generate_section`, `verification`, `rewrite`.
3. **Execution Pipeline**:
   - **Credit Reserve**: Checks available balance (`balance - reserved >= cost`). If insufficient, throws `402 INSUFFICIENT_CREDIT` (no LLM call). Temporarily reserves credit (`reserved += cost`).
   - **Prompt Interpolation**: Fetches active `PromptTemplate` (with in-memory TTL caching) and replaces `{{variable_name}}` placeholders.
   - **Multi-Provider LLM Call**: Routes request to `openai`, `anthropic`, or `gemini` adapters via `llm.router.ts`.
   - **Zod Response Parsing**: Extracts JSON from Markdown code blocks and validates response against action-specific Zod schema.
   - **Credit Finalization**:
     - **Success**: Deducts credit (`balance -= cost`, `reserved -= cost`), logs `AiActionLog` with `status: "success"`.
     - **Failure**: Releases credit (`reserved -= cost`), logs `AiActionLog` with `status: "failed"`.
4. **2-Tier Retry Logic**:
   - **Tier 1 (In-Request Auto Retry)**: Retries up to 2 times for transient errors (Rate limit 429, network timeout, JSON parse error) with 1s & 3s backoff.
   - **Tier 2 (Manual Retry Endpoint)**: `POST /api/v1/ai-actions/retry/:logId` re-runs action with fresh reservation without corrupting existing stable section content.
5. **API Endpoints**:
   - `POST /api/v1/ai-actions/estimate-cost`
   - `POST /api/v1/ai-actions/execute`
   - `POST /api/v1/ai-actions/retry/:logId`

---

## 7. ⭐ Prompt Template System — MD-Based Seed Workflow

> **Đây là hệ thống quản lý prompt template. Thành viên KHÔNG cần sửa TypeScript để thay đổi nội dung AI prompt.**

### Ý tưởng thiết kế

Mỗi AI action = 1 file `.md` trong `src/scripts/prompts/`. File gồm 2 phần:

```
---
(frontmatter YAML — metadata: provider, model, maxTokens, temperature...)
---
(nội dung bên dưới — chính là prompt template gửi cho LLM)
```

Script `seed-from-md.ts` đọc tất cả `.md`, parse frontmatter bằng `gray-matter`, rồi **upsert vào MongoDB** collection `PromptTemplate` — đúng model mà BE dùng. Script tự tạo **version mới** khi phát hiện thay đổi (giữ lịch sử rollback qua Admin UI).

### Workflow khi muốn sửa prompt

```
1. Mở file .md tương ứng trong src/scripts/prompts/
2. Sửa nội dung prompt hoặc đổi provider/aiModel/maxTokens
3. Chạy: npm run seed:md
   (hoặc xem trước: npm run seed:md:dry)
```

### npm scripts

| Script | Lệnh | Mô tả |
|--------|------|-------|
| `npm run seed:md` | `tsx src/scripts/seed-from-md.ts` | Seed thật vào MongoDB |
| `npm run seed:md:dry` | `tsx src/scripts/seed-from-md.ts --dry-run` | Xem parse kết quả, KHÔNG ghi DB |

### Format frontmatter bắt buộc

```yaml
---
actionType: summarize          # PHẢI khớp ActionType enum trong ai-action.types.ts
provider: gemini               # openai | anthropic | gemini
aiModel: gemini-2.5-flash      # Tên model cụ thể
maxTokens: 2048                # Số token tối đa output
temperature: 0.3               # 0.0 (deterministic) → 1.0 (creative)
isActive: true                 # Mặc định true
description: Mô tả ngắn       # Tùy chọn
---
```

### Quy tắc viết nội dung prompt

- Dùng `{{variable_name}}` cho biến — được `prompt-registry.service.ts` thay thế lúc runtime.
- **BẮT BUỘC** phải yêu cầu LLM trả về JSON thuần túy khớp với Zod schema trong `response-parser.ts`.
- Ví dụ dòng bắt buộc cuối prompt: `CHỈ trả về JSON thuần túy, không thêm text ngoài JSON: {"summary": "...", "keyPoints": [...]}`

### Biến placeholder theo action

| Biến | Dùng trong action |
|------|------------------|
| `{{input_text}}` | summarize, extract, analysis, clarification |
| `{{specification}}` | verification |
| `{{content}}` | rewrite |
| `{{context}}` + `{{section_name}}` | generate_section |

### Zod schema mỗi action (response-parser.ts)

| ActionType | Schema output |
|-----------|--------------|
| `summarize` | `{ summary: string, keyPoints?: string[] }` |
| `extract` | `{ title?, entities?, attributes?, requirements? }` |
| `analysis` | `{ businessGoals?, targetUsers?, risks?, constraints?, summary? }` |
| `clarification` | `{ questions: [{ id?, question, reason? }] }` |
| `generate_section` | `{ sectionName?, content: string, subSections? }` |
| `verification` | `{ score?, issues: [{ severity?, description, suggestion? }], overallStatus? }` |
| `rewrite` | `{ rewrittenContent: string, changesSummary? }` |

### Thêm actionType mới

1. Thêm vào `ActionType` enum trong `src/shared/ai/ai-action.types.ts`.
2. Thêm Zod schema vào `src/shared/ai/response-parser.ts`.
3. Tạo file `.md` mới trong `src/scripts/prompts/`.
4. Chạy `npm run seed:md:dry` → `npm run seed:md`.
5. **Không cần sửa `seed-from-md.ts`** — script tự đọc toàn bộ `.md`.

---

## 8. Gemini Provider — JSON Mode (quan trọng)

File: `src/shared/ai/providers/gemini.provider.ts`

Gemini provider đã bật **`responseMimeType: "application/json"`** trong `generationConfig`. Điều này:
- **Ép Gemini luôn trả valid JSON** — không bao giờ trả plain text ngoài ý muốn.
- **Phát hiện sớm JSON bị cắt** — nếu `finishReason === "MAX_TOKENS"`, throw lỗi `RESPONSE_TRUNCATED` ngay thay vì pass text hỏng cho parser.

> ⚠️ **Nếu gặp lỗi `RESPONSE_TRUNCATED`**: Tăng `maxTokens` trong file `.md` tương ứng, rồi `npm run seed:md`.

> ⚠️ **Nếu gặp lỗi `PERMISSION_DENIED 403`**: API key Gemini hết hạn hoặc bị thu hồi. Lấy key mới tại [aistudio.google.com/apikey](https://aistudio.google.com/apikey) và cập nhật `GEMINI_API_KEY` trong `.env`.

---

## 9. Environment Variables (.env)

| Biến | Mô tả |
|------|-------|
| `PORT` | Port backend (default: 5000) |
| `MONGO_URI` | MongoDB URI — local: `mongodb://localhost:27017/flintflow` |
| `JWT_ACCESS_SECRET` | Secret cho access token |
| `JWT_REFRESH_SECRET` | Secret cho refresh token |
| `ACCESS_TOKEN_EXPIRES` | Thời hạn access token (e.g. `15m`) |
| `REFRESH_TOKEN_EXPIRES` | Thời hạn refresh token (e.g. `3d`) |
| `CLIENT_URL` | URL frontend (e.g. `http://localhost:3000`) |
| `APP_URL` | URL app dùng trong email link |
| `SMTP_HOST/PORT/USER/PASS` | Gmail SMTP config |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `OPENAI_API_KEY` | OpenAI API key (hiện hết quota) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GEMINI_API_KEY` | Google Gemini API key (**đang dùng**) |
| `ADMIN_EMAIL/PASSWORD` | Tài khoản admin seed ban đầu |

---

## 10. Dev Quick Start

```bash
# Backend
cd flintflow_be
npm install
npm run dev          # Khởi động server (port 5000, auto-reload)

# Seed prompt templates (lần đầu hoặc sau khi sửa file .md)
npm run seed:md

# Frontend
cd flintflow_fe
npm install
npm run dev          # Khởi động Next.js (port 3000, Webpack mode — Turbopack đã tắt)
```

> **Turbopack**: Đã tắt ở frontend (`next dev --webpack`) do bug "Next.js package not found" panic. Xem `flintflow_fe/package.json`.

---
