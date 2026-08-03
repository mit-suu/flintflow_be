# CLAUDESCHEMA.md — Hướng dẫn Agent & Sơ đồ ERD Database Mongoose

> File này dành cho AI coding agent đọc trước khi làm việc với Database/Model.
> Mục tiêu: sinh đủ các schema cần thiết, đặt đúng vị trí theo cấu trúc feature-based đã có, tuân thủ convention đặt tên và quan hệ dữ liệu đã chốt.

---

## 0. Sơ đồ Entity Relationship Diagram (Mermaid ERD)

```mermaid
erDiagram
    User ||--o{ Session : "has multiple sessions"
    User ||--o{ Project : "owns projects"
    User ||--|| CreditWallet : "has one wallet"
    User ||--o{ CreditTransaction : "makes transactions"
    User ||--|| Subscription : "has active subscription"
    User ||--o{ PromptTemplate : "manages templates"
    User ||--o{ PricingConfig : "manages pricing"
    User ||--o{ AiActionLog : "executes actions"

    Project ||--o{ ChatSession : "contains chat sessions"
    Project ||--o{ Section : "contains specification sections"
    Project ||--|| VerificationContext : "has one verification context"
    Project ||--o{ CreditTransaction : "incurs transactions"
    Project ||--o{ AiActionLog : "logs AI actions"

    Section ||--o{ SectionVersion : "has version history"

    AiActionLog ||--o| AiActionLog : "retries previous log"

    User {
        ObjectId _id PK
        string email UK
        string passwordHash
        string authProvider
        string googleId UK
        string name
        string role
        boolean isActive
        Date createdAt
    }

    Session {
        ObjectId _id PK
        ObjectId userId FK
        string tokenHash UK
        Date expiresAt
        boolean isRevoked
        string userAgent
        string ip
        Date createdAt
    }

    Project {
        ObjectId _id PK
        ObjectId userId FK
        string name
        string domain
        string status
        string currentStep
        number progressPercent
        Date createdAt
    }

    ChatSession {
        ObjectId _id PK
        ObjectId projectId FK
        Array messages
        boolean isActive
        Date createdAt
    }

    Section {
        ObjectId _id PK
        ObjectId projectId FK
        string type
        Mixed content
        string status
        string sourceType
        number order
        Date createdAt
    }

    SectionVersion {
        ObjectId _id PK
        ObjectId sectionId FK
        number versionNumber
        Mixed content
        string diffSummary
        Array changedFields
        Array factVsAssumption
        string createdBy
        Date createdAt
    }

    VerificationContext {
        ObjectId _id PK
        ObjectId projectId FK_UK
        Array hiddenAssumptions
        Array missingInfo
        Array conflicts
        Array ambiguities
        Array followUpQuestions
        number readinessScore
        string readinessStatus
        Date lastComputedAt
    }

    CreditWallet {
        ObjectId _id PK
        ObjectId userId FK_UK
        number balance
        number reserved
        Date createdAt
    }

    CreditTransaction {
        ObjectId _id PK
        ObjectId userId FK
        ObjectId projectId FK
        string actionType
        number amount
        string type
        number balanceAfter
        Date createdAt
    }

    Subscription {
        ObjectId _id PK
        ObjectId userId FK_UK
        string plan
        string status
        number monthlyCreditsAllotment
        Date currentPeriodStart
        Date currentPeriodEnd
    }

    PromptTemplate {
        ObjectId _id PK
        string actionType UK
        string template
        number version
        boolean isActive
        ObjectId updatedBy FK
        Date createdAt
    }

    AiActionLog {
        ObjectId _id PK
        ObjectId projectId FK
        ObjectId userId FK
        string actionType
        string provider
        string aiModel
        string status
        string errorMessage
        number promptTokens
        number completionTokens
        number latencyMs
        ObjectId retryOfLogId FK
        Date createdAt
    }

    PricingConfig {
        ObjectId _id PK
        Record actionCosts
        Record planLimits
        boolean isActive
        ObjectId updatedBy FK
        Date createdAt
    }
```

---

## 1. Nguyên tắc bắt buộc

1. **Mỗi model đặt trong `modules/<feature>/`** tương ứng, đúng theo cấu trúc feature-based đã dựng (VD: `Project` → `modules/project/project.model.ts`).
2. **Model dùng chung nhiều feature** (VD: `Session` đã có ở `shared/auth/`, `User` có thể được nhiều module tham chiếu) → đặt ở `shared/models/` nếu agent thấy có từ 3 module trở lên tham chiếu trực tiếp, còn lại giữ nguyên tại module gốc và các module khác chỉ lưu `ObjectId` tham chiếu (KHÔNG duplicate schema).
3. **TypeScript strict** — mỗi model có interface `I<TenModel>` riêng, export cả `interface` và `Schema` và `Model`.
4. Naming convention: **PascalCase cho tên Model/Interface, camelCase cho field**, tên collection để Mongoose tự pluralize (không hardcode `collection:` trừ khi cần thiết).
5. Timestamps: mọi schema đều bật `{ timestamps: true }` trừ khi có lý do rõ ràng để tắt.
6. Index: agent tự thêm index cho field hay dùng để query/filter, **ưu tiên compound index** khi query luôn đi kèm 2 field trở lên (VD: `projectId + type`).

---

## 2. Danh sách model chi tiết

### 2.1 `modules/user/user.model.ts`
- Fields: `email` (unique), `passwordHash`, `authProvider` (`local`|`google`), `googleId` (sparse), `name`, `role` (`user`|`admin`), `isActive`.
- Virtual: `password`.

### 2.2 `shared/auth/session.model.ts`
- Fields: `userId` (ref User), `tokenHash` (unique, SHA-256), `expiresAt`, `isRevoked`, `userAgent`, `ip`.

### 2.3 `modules/project/project.model.ts`
- Fields: `userId` (ref User), `name`, `domain`, `status` (`active`|`archived`), `currentStep`, `progressPercent`.
- Compound Index: `{ userId: 1, status: 1 }`.

### 2.4 `modules/project/chat-session.model.ts`
- Fields: `projectId` (ref Project), `messages` array (`role`, `content`, `createdAt`), `isActive`.
- Compound Index: `{ projectId: 1, isActive: 1 }`.

### 2.5 `modules/specification/section.model.ts`
- Fields: `projectId` (ref Project), `type` (15 SectionType values), `content` (`Schema.Types.Mixed`), `status` (`draft`|`accepted`|`edited_manually`|`regenerated`), `sourceType` (`ai_generated`|`user_edited`), `order`.
- Unique Index: `{ projectId: 1, type: 1 }`.

### 2.6 `modules/specification/section-version.model.ts`
- Fields: `sectionId` (ref Section), `versionNumber`, `content`, `diffSummary`, `changedFields`, `factVsAssumption` array, `createdBy` (`ai`|`user`).
- Unique Index: `{ sectionId: 1, versionNumber: 1 }`.

### 2.7 `modules/verification/verification-context.model.ts`
- Fields: `projectId` (ref Project, unique), `hiddenAssumptions`, `missingInfo`, `conflicts`, `ambiguities`, `followUpQuestions`, `readinessScore`, `readinessStatus` (`BLOCKED`|`NEEDS_CLARIFICATION`|`READY_TO_BUILD`), `lastComputedAt`.

### 2.8 `modules/credits/credit-wallet.model.ts`
- Fields: `userId` (ref User, unique), `balance`, `reserved`.

### 2.9 `modules/credits/credit-transaction.model.ts`
- Fields: `userId` (ref User), `projectId` (ref Project, optional), `actionType`, `amount`, `type` (`reserve`|`deduct`|`release`|`monthly_reset`|`purchase`), `balanceAfter`.
- Index: `{ userId: 1, createdAt: -1 }`.

### 2.10 `modules/credits/subscription.model.ts`
- Fields: `userId` (ref User, unique), `plan` (`free`|`pro`), `status` (`active`|`canceled`|`expired`), `monthlyCreditsAllotment`, `currentPeriodStart`, `currentPeriodEnd`.

### 2.11 `modules/admin/prompt-template.model.ts`
- Fields: `actionType` (unique), `template`, `version`, `isActive`, `updatedBy` (ref User).
- Compound Index: `{ actionType: 1, isActive: 1 }`.

### 2.12 `modules/admin/ai-action-log.model.ts`
- Fields: `projectId`, `userId`, `actionType`, `provider`, `aiModel`, `status` (`success`|`failed`|`retried`), `errorMessage`, `promptTokens`, `completionTokens`, `latencyMs`, `retryOfLogId` (ref AiActionLog).
- Indexes: `{ projectId: 1, createdAt: -1 }`, `{ userId: 1, createdAt: -1 }`.

### 2.13 `modules/admin/pricing-config.model.ts`
- Fields: `actionCosts`, `planLimits`, `isActive`, `updatedBy` (ref User).
