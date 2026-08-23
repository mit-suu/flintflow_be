# CLAUDECONTEXT.md — FlintFlow Backend Context Snapshot

> **Purpose**: High-density, token-efficient architecture context for AI Coding Agents & team members.
> **Last Updated**: Giai đoạn 1 Hoàn Tất (Task A, Task B, Task C, Task D).

---

## 1. Project Overview & Rules

- **Platform**: FlintFlow Backend — AI-powered Software Specification Platform (SRS Automation).
- **Node Environment**: Node v22, ES Modules (`"type": "module"` in `package.json`).
- **ES Module Import Rule**: ALL relative imports in TypeScript files MUST include `.js` extension (e.g., `import { env } from "./config/env.js"`).
- **TypeScript**: Strict mode enabled.
- **Type Checking Command**: `npx tsc --noEmit`.

---

## 2. System Architecture & Directory Map

```
src/
├── config/
│   ├── env.ts                   # Type-safe env vars (JWT secrets, Mongo URI, SMTP, AI Keys, Cloudinary)
│   ├── database.ts              # Mongoose DB connection
│   └── swagger.ts               # Swagger OpenAPI scanner
├── shared/
│   ├── ai/                      # AI Action Framework (Single entrypoint executeAiAction)
│   │   ├── ai-action.types.ts   # ActionType enum (14 types)
│   │   ├── ai-action.service.ts # executeAiAction() — core orchestrator with logging
│   │   ├── document-context.service.ts # Context Builder theo SectionType & ActionType
│   │   ├── prompt-registry.service.ts  # Prompt templates with TTL cache & {{documentContext}}
│   │   ├── response-parser.ts   # Zod schema validation & sourceLinks extraction
│   │   ├── credit-reservation.service.ts # Credit reserve/deduct/release transactions
│   │   ├── retry.service.ts     # In-request automatic retry for 429/503
│   │   └── providers/           # LLM adapters (openai, anthropic, gemini)
│   ├── constants/
│   │   ├── section-types.ts     # 25 SectionTypes, SECTION_METADATA (phase 2/3/4, mappedToTemplate)
│   │   └── http-status.ts       # HTTP_STATUS object constants
│   ├── auth/                    # JWT & session management
│   └── utils/                   # ApiError, ApiResponse, Cloudinary upload helper
└── modules/
    ├── project/                 # Project (currentPhase: 2|3|4, progressPercent: 0..100), ChatSession, ProjectDocument
    ├── specification/
    │   ├── section.model.ts     # Section (25 types, status: draft|accepted|edited_manually|regenerated)
    │   ├── phase-gate.service.ts # ⭐ canAccessPhase, canModifySection, checkAndAdvancePhase, calculateProgress, getProjectProgressBreakdown
    │   ├── traceability.service.ts # Traceability validator & RequirementSourceLink
    │   ├── specification.service.ts # Core spec generation, Phase Gate enforcement, acceptSection
    │   ├── specification.controller.ts # generate, update, acceptSection, getProgress
    │   └── specification.route.ts # REST routes & swagger specs
    ├── verification/            # ⭐ Verification Context (computeBasicReadiness & getVerificationContext)
    │   ├── verification-context.model.ts # VerificationContext (readinessScore, readinessStatus, conflicts, assumptions...)
    │   ├── verification-context.service.ts # computeBasicReadiness (progressPercent proxy) & getVerificationContext
    │   ├── verification-context.controller.ts # getVerificationContext & recomputeReadiness handlers
    │   └── verification-context.route.ts # GET /api/v1/verification/projects/:projectId & POST recompute
    ├── credits/                 # UserCredit, CreditTransaction, Subscription
    ├── user/                    # User authentication & profile
    └── admin/                   # PromptTemplate, AiActionLog, PricingConfig
```

---

## 3. Giai đoạn 1: Core Mechanisms Summary

### Task A — 25 SectionTypes Structure (Capstone Report 3)
- **Phase 2 (7 types - 100% mapped)**: `vision_problem`, `business_goals`, `value_proposition`, `high_level_business_rules`, `stakeholders`, `user_journey`, `use_case_spec`.
- **Phase 3 (10 types - 8 mapped, 2 internal-only)**: `screen_flow`, `screen_description`, `rbac`, `non_screen_functions`, `erd`, `functional_requirements`, `user_story`, `acceptance_criteria`, `priority_ranking` (false), `scope_out_of_scope` (false).
- **Phase 4 (8 types - 7 mapped, 1 internal-only)**: `external_interfaces`, `non_functional_requirements`, `common_business_rules`, `common_requirements`, `application_messages`, `assumptions_risks`, `glossary`, `success_metrics` (false).
- **Total Mapped Sections**: 22.

### Task B — Phase Gate State Machine
- `canAccessPhase(projectId, targetPhase)`: Chỉ mở khóa Phase $N+1$ khi tất cả section `mappedToTemplate: true` của Phase $N$ đã `accepted`. Ngăn chặn nhảy cóc nhiều phase.
- `canModifySection(projectId, sectionType)`: Khóa baseline các section đã `accepted` ở các phase đã qua (`phase < currentPhase`).
- `checkAndAdvancePhase(projectId)`: Tự động tăng `currentPhase` khi đủ điều kiện nghiệm thu.

### Task C — Automatic Progress Percent & Breakdown
- $\text{progressPercent} = \lfloor (\text{acceptedMappedCount} / 22) \times 100 \rfloor$.
- `GET /api/v1/specifications/projects/:projectId/progress`: Phân rã tiến độ chi tiết theo từng phase và từng section.

### Task D — Verification Context Service (Readiness Proxy)
- Khởi tạo tầng Service / Controller / Route cho `VerificationContext`.
- Tạm dùng `progressPercent` làm proxy cho `readinessScore`.
- `readinessStatus`:
  - $= 100\% \rightarrow \text{"READY\_TO\_BUILD"}$
  - $= 0\% \rightarrow \text{"BLOCKED"}$
  - $0\% < x < 100\% \rightarrow \text{"NEEDS\_CLARIFICATION"}$
- Các trường AI (`conflicts`, `hiddenAssumptions`, `missingInfo`, `ambiguities`, `followUpQuestions`) để mảng rỗng `[]`, không gọi AI, sẵn sàng cho Giai đoạn 2.
- `GET /api/v1/verification/projects/:projectId`: Trả về `VerificationContext` của dự án.
