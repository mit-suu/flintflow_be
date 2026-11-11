# 🤖 FlintFlow AI Action Framework (`src/shared/ai/`)

> **Entrypoint duy nhất** bọc toàn bộ các tương tác với LLM trong toàn hệ thống FlintFlow.
> Mọi module (pipeline step runner, draft-to-ops, change/reconcile, chat, tài liệu upload…) đều bắt buộc gọi AI qua `executeAiAction()`. KHÔNG tự gọi API của GLM / Anthropic / Gemini trực tiếp.

---

## 🚀 Cách sử dụng trong code nghiệp vụ

```typescript
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"

// Ví dụ: tóm tắt tài liệu upload (action ngoài pipeline)
const result = await executeAiAction(
  ActionType.SUMMARIZE_DOCUMENT,
  { promptVariables: { input_text: "Yêu cầu phần mềm..." } },
  projectId,
  userId
)

console.log(result.data) // Trả về object đã được Zod parse & validate
console.log(result.cost) // Số credit đã trừ
console.log(result.logId) // Log ID lưu trên DB
```

---

## 🔄 Luồng hoạt động tự động bên trong `executeAiAction()`

```
1. Check & Reserve Credit (Mongoose Transaction: Wallet.reserved += cost)
   ↳ Nếu thiếu credit: Ném lỗi 402 INSUFFICIENT_CREDIT (Không gọi LLM)

2. Build Prompt — CHỈ đọc đĩa (không DB override, T03)
   ↳ assets/prompts/<actionType>.md, hoặc skill hành động theo SKILL_BY_ACTION_TYPE
     (assets/skills/action/<skill_id>/SKILL.md)
   ↳ Interpolate các biến {{variable_name}}

3. Call LLM (Multi-provider Router)
   ↳ Provider/model/maxTokens/temperature lấy từ frontmatter của asset

4. Parse & Validate Response (Zod Schema)
   ↳ Bóc tách JSON block từ Markdown
   ↳ Validate theo Zod Schema của ActionType tương ứng

5. Deduct / Release Credit & Logging
   ↳ Thành công: Deduct credit (Wallet.balance -= cost, Wallet.reserved -= cost), lưu AiActionLog status=success
   ↳ Thất bại: Release credit (Wallet.reserved -= cost), lưu AiActionLog status=failed

6. In-Request Auto Retry (Tầng 1)
   ↳ Tự động thử lại tối đa 2 lần với các lỗi transient (Rate limit 429, Network timeout, Parse fail)
```

---

## 🏷️ `ActionType` hiện có

| Nhóm | Giá trị | Prompt |
|---|---|---|
| Khung pipeline | `elicit`, `discovery_step`, `draft`, `regenerate`, `revision`, `glossary_scan`, `render_fix`, `review`, `consistency_pass`, `reconcile`, `change_instruction` | skill hành động theo `SKILL_BY_ACTION_TYPE` |
| Ngoài pipeline | `chat`, `summarize_document` | `assets/prompts/<actionType>.md` |

Các action section-based cũ (`generate_section`, `priority_ranking`, `scope_out_of_scope`, `chat_discovery`, `diagram_*`) đã gỡ ở T21. `AiActionLog` cũ vẫn có thể mang các tên này — trang chi phí AI của admin chỉ nhóm theo chuỗi.

Context tài liệu upload (`document-context.service.ts`): step pipeline nạp tài liệu khi `reads` của step có token `documents`; action ngoài pipeline theo bảng `ACTION_NEEDS_SOURCE_DOCUMENTS` (chỉ còn `chat`).

FLF-393 — ngân sách là trần token cố định theo loại lượt gọi (`DOC_CONTEXT_CHAT_TOKENS`, `DOC_CONTEXT_DRAFT_TOKENS`), không phải context window của model:
- Tổng tài liệu ≤ trần ⇒ gửi nguyên văn (`mode = "full"`), như trước.
- Vượt trần ⇒ `mode = "retrieved"`: chỉ chunk liên quan. Chunk cắt theo cây section lúc upload (`document-retrieval/chunker.ts`; heading thật của .docx qua `docx-outline.ts`, file khác dò heading trên chữ), lưu ở `project_document_chunks`, dựng bù khi thiếu. Step ghim chunk có tiêu đề khớp section nó nuôi (`modules/pipeline/step-document-query.ts`), phần còn lại lấp bằng BM25 (`document-retrieval/bm25.ts`, tokenizer tiếng Việt `vi-tokenizer.ts`: NFC, có dấu + bỏ dấu, bigram, giữ mã `UC-12`). Câu hỏi toàn cục / không khớp gì ⇒ kèm `summary`.
- Mã đoạn `D<n>-P<m>` giữ nguyên ở mọi chế độ. Đo chất lượng: `npm run eval:doc-retrieval`.

---

## ➕ Cách thêm 1 `ActionType` mới cho hệ thống

Nếu bạn phát triển tính năng mới cần dùng AI:

1. **Khai báo Enum**: Thêm giá trị mới vào `ActionType` trong `ai-action.types.ts`.
2. **Viết Zod Schema**: Thêm schema vào `SCHEMAS` trong `response-parser.ts`; thêm giá vào `credit-reservation.service.ts`.
3. **Asset trên đĩa** (không có fallback trong code):
   - Action pipeline → skill ở `assets/skills/action/` + dòng trong `SKILL_BY_ACTION_TYPE` và `OUTPUT_SCHEMA_BY_ACTION_TYPE`.
   - Action ngoài pipeline → `assets/prompts/<actionType>.md`.
4. **Gọi trong Service**: `executeAiAction(ActionType.MY_NEW_ACTION, input, projectId, userId)`.

## 🧩 Skill (T03)

```typescript
import { getSkill } from "./prompt-registry.service.js"

const skill = getSkill("draft-to-ops", { references: ["op-grammar"] })
skill.template          // thân SKILL.md
skill.references        // { "op-grammar": "..." } — chỉ reference đã yêu cầu
skill.providerConfig    // từ frontmatter
skill.asset_version     // sha256 SKILL.md + references → sections[].asset_version
```

Quy ước frontmatter: `assets/skills/README.md`.
