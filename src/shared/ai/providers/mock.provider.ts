import { AiProviderConfig } from "../ai-action.types.js"
import { LLMResponse } from "./provider.types.js"

export const callMockLLM = async (
  prompt: string,
  _providerConfig: AiProviderConfig
): Promise<LLMResponse> => {
  // Simulate network delay 300ms
  await new Promise((resolve) => setTimeout(resolve, 300))

  let mockOutput = ""

  if (prompt.includes("Tóm tắt") || prompt.includes("summarize")) {
    mockOutput = "```json\n{\n  \"summary\": \"[MOCK AI] Bản tóm tắt mẫu hệ thống FlintFlow. Phân tích yêu cầu và quy trình thực thi ngắn gọn.\",\n  \"keyPoints\": [\n    \"Khởi tạo hệ thống quản lý Prompt Template (UC83)\",\n    \"Hỗ trợ Multi-provider: OpenAI, Gemini, Anthropic & Mock AI\",\n    \"Kiểm tra và thử nghiệm biến template real-time\"\n  ]\n}\n```"
  } else if (prompt.includes("Trích xuất") || prompt.includes("extract")) {
    mockOutput = "```json\n{\n  \"entities\": [\n    { \"name\": \"User\", \"type\": \"Actor\", \"description\": \"Người dùng hệ thống\" },\n    { \"name\": \"PromptTemplate\", \"type\": \"Entity\", \"description\": \"Cấu hình mẫu prompt và model AI\" }\n  ],\n  \"requirements\": [\n    \"Đăng nhập qua Email/Mật khẩu hoặc Google\",\n    \"Quản lý phiên bản template và rollback\"\n  ]\n}\n```"
  } else {
    mockOutput = "```json\n{\n  \"status\": \"success\",\n  \"message\": \"[MOCK AI] Phản hồi thử nghiệm thành công cho Prompt Template.\",\n  \"promptSnippet\": \"" + prompt.slice(0, 80).replace(/"/g, "'").replace(/\n/g, " ") + "...\"\n}\n```"
  }

  return {
    text: mockOutput,
    promptTokens: 45,
    completionTokens: 85,
    raw: { mock: true, timestamp: new Date().toISOString() }
  }
}
