# 🤖 FlintFlow AI Action Framework (`src/shared/ai/`)

> **Entrypoint duy nhất** bọc toàn bộ các tương tác với LLM trong toàn hệ thống FlintFlow.
> Mọi module (Specification, Clarification, Verification, etc.) đều bắt buộc gọi AI qua `executeAiAction()`. KHÔNG tự gọi API của OpenAI / Anthropic / Gemini trực tiếp.

---

## 🚀 Cách sử dụng trong code nghiệp vụ

```typescript
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"

// Ví dụ 1: Tóm tắt văn bản
const result = await executeAiAction(
  ActionType.SUMMARIZE,
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

2. Build Prompt
   ↳ Lấy PromptTemplate từ DB (hoặc fallback mặc định)
   ↳ Interpolate các biến {{variable_name}}

3. Call LLM (Multi-provider Router)
   ↳ Tự động chuyển qua OpenAI / Anthropic / Gemini tùy config của PromptTemplate

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

## ➕ Cách thêm 1 `ActionType` mới cho hệ thống

Nếu bạn phát triển tính năng mới cần dùng AI:

1. **Khai báo Enum**: Thêm giá trị mới vào `ActionType` trong [ai-action.types.ts](file:///d:/Learning/Capstone/FlintFlow/flintflow_be/src/shared/ai/ai-action.types.ts).
2. **Viết Zod Schema**: Thêm Schema validate output tương ứng vào [response-parser.ts](file:///d:/Learning/Capstone/FlintFlow/flintflow_be/src/shared/ai/response-parser.ts).
3. **Khai báo Fallback Prompt**: Bổ sung template mặc định vào `DEFAULT_TEMPLATES` trong [prompt-registry.service.ts](file:///d:/Learning/Capstone/FlintFlow/flintflow_be/src/shared/ai/prompt-registry.service.ts).
4. **Gọi trong Service**: Gọi `executeAiAction(ActionType.MY_NEW_ACTION, input, projectId, userId)` ở module của bạn.
