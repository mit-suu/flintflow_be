# CLAUDECONTEXTWINDOW.md — FlintFlow Backend Context Snapshot

> **Purpose**: High-density, token-efficient architecture context for AI Coding Agents.
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
│   ├── env.ts                   # Type-safe env vars (JWT secrets, expiry, Mongo URI)
│   ├── database.ts              # Mongoose DB connection
│   └── swagger.ts               # Swagger OpenAPI scanner (scans ./src/modules/**/*.ts)
├── shared/
│   ├── ai/                      # AI Action Framework placeholder (.gitkeep)
│   ├── auth/                    # Core Auth Infrastructure (DO NOT duplicate in modules)
│   │   ├── jwt.util.ts          # Sign/verify access & refresh tokens, SHA-256 hash helper
│   │   ├── session.model.ts     # MongoDB Session collection (hashed refresh tokens)
│   │   ├── session.service.ts   # Session creation, rotation, revocation & reuse detection
│   │   └── auth.middleware.ts   # Bearer access token verification middleware
│   ├── constants/
│   │   └── http-status.ts       # HTTP_STATUS object constants
│   ├── middlewares/
│   │   ├── error-handler.ts     # Global error handler returning standard response format
│   │   └── rate-limit.ts        # Rate limit middleware placeholder
│   ├── types/
│   │   ├── api-response.ts      # ApiResponse<T> interface & helper functions
│   │   └── express.d.ts         # Express Request declaration extension (req.user)
│   └── utils/
│       ├── api-error.ts         # ApiError class (statusCode, message, code)
│       └── catch-async.ts       # Controller async wrapper
├── modules/
│   ├── auth/                    # Auth HTTP handlers (/register, /login, /refresh, /logout, /logout-all)
│   ├── user/                    # User profile queries (/me, /:id) & User model
│   ├── project/                 # Projects & chat sessions (Project, ChatSession)
│   ├── specification/           # Specification sections & version history (Section, SectionVersion)
│   ├── verification/            # Aggregated project verification context (VerificationContext)
│   ├── credits/                 # Credit wallet, transactions & subscriptions (CreditWallet, CreditTransaction, Subscription)
│   └── admin/                   # Prompt templates, AI action logs & pricing configs (PromptTemplate, AiActionLog, PricingConfig)
├── app.ts                       # Express app setup, middleware, base routes & error handler
└── server.ts                    # HTTP server listener
```

---

## 3. Database Schema Models (Mongoose)

| Model Name | Module Location | Key Fields & Indexes |
|---|---|---|
| **User** | `modules/user/user.model.ts` | `email` (unique), `passwordHash`, `authProvider` (`local`\|`google`), `googleId` (sparse), `name`, `role` (`user`\|`admin`), `isActive`. Virtual `password`. |
| **Session** | `shared/auth/session.model.ts` | `userId` (ref User), `tokenHash` (unique, SHA-256), `expiresAt`, `isRevoked`, `userAgent`, `ip`. |
| **Project** | `modules/project/project.model.ts` | `userId` (ref User), `name`, `domain`, `status` (`active`\|`archived`), `currentStep`, `progressPercent`. Compound Index: `{ userId: 1, status: 1 }`. |
| **ChatSession** | `modules/project/chat-session.model.ts` | `projectId` (ref Project), `messages` array (`role`, `content`, `createdAt`), `isActive`. Compound Index: `{ projectId: 1, isActive: 1 }`. |
| **Section** | `modules/specification/section.model.ts` | `projectId` (ref Project), `type` (15 section types), `content` (`Schema.Types.Mixed`), `status`, `sourceType`, `order`. Unique Index: `{ projectId: 1, type: 1 }`. |
| **SectionVersion** | `modules/specification/section-version.model.ts` | `sectionId` (ref Section), `versionNumber`, `content`, `diffSummary`, `changedFields`, `factVsAssumption`, `createdBy`. Unique Index: `{ sectionId: 1, versionNumber: 1 }`. |
| **VerificationContext** | `modules/verification/verification-context.model.ts` | `projectId` (ref Project, unique), `hiddenAssumptions`, `missingInfo`, `conflicts`, `ambiguities`, `readinessScore`, `readinessStatus`, `lastComputedAt`. |
| **CreditWallet** | `modules/credits/credit-wallet.model.ts` | `userId` (ref User, unique), `balance`, `reserved`. |
| **CreditTransaction** | `modules/credits/credit-transaction.model.ts` | `userId` (ref User), `projectId`, `actionType`, `amount`, `type` (`reserve`\|`deduct`\|`release`\|`monthly_reset`\|`purchase`), `balanceAfter`. Index: `{ userId: 1, createdAt: -1 }`. |
| **Subscription** | `modules/credits/subscription.model.ts` | `userId` (ref User, unique), `plan` (`free`\|`pro`), `status`, `monthlyCreditsAllotment`, `currentPeriodStart`, `currentPeriodEnd`. |
| **PromptTemplate** | `modules/admin/prompt-template.model.ts` | `actionType` (unique), `template`, `version`, `isActive`, `updatedBy` (ref User). Compound Index: `{ actionType: 1, isActive: 1 }`. |
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
