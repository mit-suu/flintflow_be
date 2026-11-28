import { describe, it, expect } from "vitest"
import {
  BA_QUALITY_MARKER,
  DEFAULT_EXPLANATION_STYLE,
  explanationStyleDirective,
  isAnalysisPrompt,
  toExplanationStyle,
  withExplanationStyle
} from "./explanation-style.js"
import { getPromptTemplate, getSkill, skillPromptText } from "./prompt-registry.service.js"
import { ActionType } from "./ai-action.types.js"

describe("UC-90 cách AI trình bày phân tích", () => {
  it("mặc định Giải thích; tài khoản cũ chưa có field hoặc giá trị lạ ⇒ Giải thích", () => {
    expect(DEFAULT_EXPLANATION_STYLE).toBe("explained")
    expect(toExplanationStyle(undefined)).toBe("explained")
    expect(toExplanationStyle("verbose")).toBe("explained")
    expect(toExplanationStyle("concise")).toBe("concise")
  })

  it("prompt phân tích ⇒ nối khối Explanation style cuối prompt; prompt khác giữ nguyên từng byte", () => {
    const analysis = `Analyse.\n${BA_QUALITY_MARKER}\nrules`
    expect(withExplanationStyle(analysis, "concise")).toBe(`${analysis}\n\n${explanationStyleDirective("concise")}`)
    expect(withExplanationStyle(analysis, "explained")).toBe(`${analysis}\n\n${explanationStyleDirective("explained")}`)
    expect(withExplanationStyle("Translate this.", "concise")).toBe("Translate this.")
  })

  it("Ngắn gọn: kết luận + lý do một dòng, cấm thêm vì sao; Giải thích: thêm vì sao BA nên hỏi / nên chọn", () => {
    const concise = explanationStyleDirective("concise")
    const explained = explanationStyleDirective("explained")
    expect(concise).toContain("reason of one line only")
    expect(concise).toContain("Do not add why a BA should ask")
    expect(explained).toContain("why a BA should ask this question or choose this option")
  })

  it("hai kiểu chỉ đổi cách trình bày: cùng giữ nguyên phát hiện, câu hỏi, phương án, khuyến nghị và định dạng đầu ra", () => {
    for (const style of ["concise", "explained"] as const) {
      expect(explanationStyleDirective(style)).toContain("Keep exactly the same findings, questions, options, recommendation and output format")
      expect(explanationStyleDirective(style)).not.toContain("—")
    }
  })

  it("prompt của các bước BR-12 là prompt phân tích; dịch và tóm tắt tài liệu thì không", async () => {
    // Suy ra / rút yêu cầu, câu hỏi nghiệp vụ, 2 phương án + khuyến nghị (CR, nghi sai nghiệp vụ lúc import), cờ phân tích, chat
    const analysis = [
      ActionType.EXTRACT_REQUIREMENTS,
      ActionType.ELICIT,
      ActionType.CHANGE_INSTRUCTION,
      ActionType.IMPORT_SEMANTIC_CHECK,
      ActionType.IMPORT_CROSS_CHECK,
      ActionType.REVIEW,
      ActionType.CHAT
    ]
    for (const actionType of analysis) expect(isAnalysisPrompt((await getPromptTemplate(actionType)).template), String(actionType)).toBe(true)
    for (const actionType of [ActionType.SUMMARIZE_DOCUMENT, ActionType.TRANSLATE_DOCUMENT]) {
      expect(isAnalysisPrompt((await getPromptTemplate(actionType)).template), String(actionType)).toBe(false)
    }
  })

  it("draft của KPI (Brief, soát mục tiêu) và MoSCoW cũng là prompt phân tích: thân skill nội dung mang block vào content_guidance", () => {
    for (const skill of ["product-brief", "brief-analysis", "prioritization"]) expect(isAnalysisPrompt(skillPromptText(getSkill(skill))), skill).toBe(true)
  })
})
