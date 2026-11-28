/**
 * UC-90 (BR-12, nguyên tắc 10): cách AI trình bày phân tích kiểu BA senior, chọn trong Hồ sơ và lưu theo tài khoản
 * (`User.explanationStyle`). Chỉ đổi cách trình bày: phát hiện nào, câu hỏi nào, phương án nào, khuyến nghị nào vẫn y nguyên.
 *
 * Đứng riêng, không kéo theo Mongoose (cùng lý do với `shared/i18n/locale.ts`): FE / controller / model dùng chung hằng số.
 *
 * Prompt phân tích = prompt mang block luật chất lượng dùng chung (`ba-quality-block.test.ts`): 9 skill phân tích + chat. Các
 * bước BR-12 (Suy ra, câu hỏi nghiệp vụ, 2 phương án + khuyến nghị, KPI, MoSCoW, cờ phân tích kiểu BA) đều đi qua các prompt
 * đó, nên `buildPrompt` nối khối "Explanation style" theo mốc của block thay vì danh sách ActionType thứ hai dễ lệch.
 */
export const EXPLANATION_STYLES = ["concise", "explained"] as const

export type ExplanationStyle = (typeof EXPLANATION_STYLES)[number]

/** Mặc định của business flow (Hồ sơ, mục 2): *Giải thích*. */
export const DEFAULT_EXPLANATION_STYLE: ExplanationStyle = "explained"

export const isExplanationStyle = (value: unknown): value is ExplanationStyle => EXPLANATION_STYLES.includes(value as ExplanationStyle)

/** Giá trị đọc từ tài khoản ⇒ kiểu hợp lệ; thiếu (tài khoản cũ) hoặc giá trị lạ ⇒ mặc định. */
export const toExplanationStyle = (value: unknown): ExplanationStyle => (isExplanationStyle(value) ? value : DEFAULT_EXPLANATION_STYLE)

/** Mốc mở của block luật chất lượng — chỉ prompt phân tích mới có. */
export const BA_QUALITY_MARKER = "<!-- ba-quality:shared:start -->"

export const isAnalysisPrompt = (prompt: string): boolean => prompt.includes(BA_QUALITY_MARKER)

const SAME_CONTENT =
  "This changes only how you word each point. Keep exactly the same findings, questions, options, recommendation and output format."

const DIRECTIVE: Record<ExplanationStyle, string> = {
  concise: [
    "## Explanation style",
    "The user chose Concise. For every finding, question, option and recommendation you write for the user, state the conclusion and a reason of one line only.",
    "Do not add why a BA should ask the question or choose the option.",
    SAME_CONTENT
  ].join("\n"),
  explained: [
    "## Explanation style",
    "The user chose Explained. For every finding, question, option and recommendation you write for the user, state the conclusion, then add one or two sentences on why a BA should ask this question or choose this option, tied to this project.",
    SAME_CONTENT
  ].join("\n")
}

export const explanationStyleDirective = (style: ExplanationStyle): string => DIRECTIVE[style]

/** Prompt phân tích ⇒ nối khối "Explanation style"; prompt khác giữ nguyên từng byte. */
export const withExplanationStyle = (prompt: string, style: ExplanationStyle): string =>
  isAnalysisPrompt(prompt) ? `${prompt}\n\n${explanationStyleDirective(style)}` : prompt
