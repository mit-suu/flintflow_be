/**
 * mock.provider.ts
 * ─────────────────────────────────────────────────────────────────
 * Provider không gọi mạng. Dùng cho CI, smoke test và phát triển UI khi không muốn tốn credit.
 *
 * **T24 — output phải hợp schema.** Bản trước luôn trả `{status, message, promptSnippet}`, không khớp
 * `opTransactionSchema` / `elicitSchema` / `reviewSchema`, nên bật mock thì step chết ở bước parse chứ
 * không đi được tới gate (ghi trong `docs/spec-gaps.md`, chặn e2e phủ bước AI — T23). Giờ mỗi
 * `ActionType` nhận đúng hình đầu ra mà `response-parser.ts` chờ đợi:
 *
 * | ActionType | Trả về |
 * | --- | --- |
 * | `draft` `regenerate` `revision` `glossary_scan` `reconcile` | `{ ops: [], notes }` |
 * | `change_instruction` | `{ clarification_needed }` — lô op rỗng bị schema từ chối |
 * | `elicit` `discovery_step` | `{ reply, questions: [] }` |
 * | `review` `consistency_pass` | `{ flags: [] }` |
 * | `render_fix` | `{ puml }` |
 * | còn lại (`chat`, `summarize_document`) | văn bản tự do như cũ |
 *
 * **Lô op rỗng là cố ý.** Mock không biết gì về Spine nên không thể sinh op hợp bất biến; `ops: []`
 * hợp lệ (`draft-to-ops` coi là "Spine đã đủ cho step này"), đi qua đúng op engine và cho step chạy
 * tới gate. Nó chứng minh **đường đi**, không chứng minh nội dung — muốn kiểm nội dung thì dùng
 * fixture op-case (`fixtures/op-cases/`) hoặc provider thật với `E2E_AI=1`.
 */
import { AiProviderConfig } from "../ai-action.types.js"
import { LLMResponse } from "./provider.types.js"

const OP_TRANSACTION_ACTIONS = new Set(["draft", "regenerate", "revision", "glossary_scan", "reconcile"])
const ELICIT_ACTIONS = new Set(["elicit", "discovery_step"])
const REVIEW_ACTIONS = new Set(["review", "consistency_pass"])

const MOCK_PUML = "@startuml\ntitle Mock diagram\nactor User\n@enduml"

const fenced = (value: unknown): string => "```json\n" + JSON.stringify(value, null, 2) + "\n```"

/** Đầu ra hợp schema của `response-parser.ts` cho từng `call_kind`; `null` ⇒ dùng nhánh văn bản tự do. */
export const mockOutputFor = (actionType: string | undefined, prompt: string): string | null => {
  if (!actionType) return null
  if (OP_TRANSACTION_ACTIONS.has(actionType)) {
    return fenced({ ops: [], notes: "[MOCK AI] Không sinh op: provider mock không đọc được Spine." })
  }
  if (actionType === "change_instruction") {
    // `changeInstructionSchema` đòi `clarification_needed` HOẶC ít nhất một op — mock chỉ có vế đầu.
    return fenced({ clarification_needed: "[MOCK AI] Provider mock không diễn giải được yêu cầu sửa." })
  }
  if (ELICIT_ACTIONS.has(actionType)) {
    return fenced({ reply: "[MOCK AI] Đã ghi nhận, không có câu hỏi thêm.", questions: [] })
  }
  if (REVIEW_ACTIONS.has(actionType)) {
    return fenced({ flags: [] })
  }
  if (actionType === "render_fix") {
    return fenced({ puml: MOCK_PUML, notes: `[MOCK AI] ${prompt.slice(0, 40).replace(/\s+/g, " ")}` })
  }
  return null
}

const freeText = (prompt: string): string => {
  if (prompt.includes("Tóm tắt") || prompt.includes("summarize")) {
    return fenced({
      summary: "[MOCK AI] Bản tóm tắt mẫu hệ thống FlintFlow. Phân tích yêu cầu và quy trình thực thi ngắn gọn.",
      keyPoints: [
        "Khởi tạo hệ thống quản lý Prompt Template (UC83)",
        "Hỗ trợ Multi-provider: OpenAI, Gemini, Anthropic & Mock AI",
        "Kiểm tra và thử nghiệm biến template real-time"
      ]
    })
  }
  if (prompt.includes("Trích xuất") || prompt.includes("extract")) {
    return fenced({
      entities: [
        { name: "User", type: "Actor", description: "Người dùng hệ thống" },
        { name: "PromptTemplate", type: "Entity", description: "Cấu hình mẫu prompt và model AI" }
      ],
      requirements: ["Đăng nhập qua Email/Mật khẩu hoặc Google", "Quản lý phiên bản template và rollback"]
    })
  }
  return fenced({
    status: "success",
    message: "[MOCK AI] Phản hồi thử nghiệm thành công cho Prompt Template.",
    promptSnippet: `${prompt.slice(0, 80).replace(/"/g, "'").replace(/\n/g, " ")}...`
  })
}

export const callMockLLM = async (prompt: string, providerConfig: AiProviderConfig): Promise<LLMResponse> => {
  // Giữ một chút độ trễ: code gọi model đều là bất đồng bộ, mock trả ngay dễ giấu lỗi thứ tự.
  await new Promise((resolve) => setTimeout(resolve, 50))

  const text = mockOutputFor(providerConfig.actionType, prompt) ?? freeText(prompt)

  return {
    text,
    promptTokens: Math.ceil(prompt.length / 4),
    completionTokens: Math.ceil(text.length / 4),
    raw: { mock: true, actionType: providerConfig.actionType ?? null, timestamp: new Date().toISOString() }
  }
}
