import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearRecommendation,
  isRecommended,
  logRecommendationDropped,
  modelOptionAnalysisSchema,
  modelOptionSetSchema,
  normalizeRecommendation,
  optionSetSchema,
  recommendedSuffixFor,
  withoutRecommendedSuffix
} from "./option-analysis.js"

afterEach(() => vi.restoreAllMocks())

describe("FLF-449 N1: modelOptionAnalysisSchema", () => {
  it("giữ ưu / nhược / rủi ro; bỏ mảng rỗng, mục rỗng, mục không phải chuỗi", () => {
    const out = modelOptionAnalysisSchema.parse({
      label: "Duyệt hai cấp",
      description: "Trưởng khoa rồi phòng Tài chính",
      pros: ["Ít sai sót", "  ", 3],
      cons: "Chậm hơn một ngày",
      risks: null,
      preview: ""
    })
    expect(out).toEqual({ label: "Duyệt hai cấp", description: "Trưởng khoa rồi phòng Tài chính", pros: ["Ít sai sót"], cons: ["Chậm hơn một ngày"] })
  })

  it("tối đa 4 mục mỗi danh sách", () => {
    const out = modelOptionAnalysisSchema.parse({ label: "A", pros: ["1", "2", "3", "4", "5"] })
    expect(out.pros).toEqual(["1", "2", "3", "4"])
  })

  it("chuỗi trơn (prompt cũ) vẫn đọc được; đuôi khuyến nghị hoặc recommended: true ⇒ cờ", () => {
    expect(modelOptionAnalysisSchema.parse("Web")).toEqual({ label: "Web" })
    expect(modelOptionAnalysisSchema.parse("Web (Khuyến nghị)")).toEqual({ label: "Web (Khuyến nghị)", recommended: true })
    expect(modelOptionAnalysisSchema.parse({ label: "Mobile", recommended: true })).toEqual({ label: "Mobile", recommended: true })
    expect(modelOptionAnalysisSchema.parse({ label: "Mobile", recommended: false })).toEqual({ label: "Mobile" })
  })
})

describe("FLF-449 03 #3: normalizeRecommendation", () => {
  const options = [{ label: "Web (Khuyến nghị)", recommended: true as const, pros: ["Không cần cài"] }, { label: "Mobile" }]

  it("có khuyến nghị + lý do ⇒ giữ cờ, đuôi và lý do", () => {
    const out = normalizeRecommendation(options, " Bạn nói khách đặt lịch trên máy tính ở quầy ")
    expect(out.options).toEqual(options)
    expect(out.recommendation_reason).toBe("Bạn nói khách đặt lịch trên máy tính ở quầy")
    expect(out.dropped).toBeUndefined()
  })

  it("khuyến nghị thiếu lý do ⇒ bỏ cờ + đuôi, giữ thẻ và các trường khác", () => {
    const out = normalizeRecommendation(options, undefined)
    expect(out.options).toEqual([{ label: "Web", pros: ["Không cần cài"] }, { label: "Mobile" }])
    expect(out.recommendation_reason).toBeUndefined()
    expect(out.dropped).toBe("missing_reason")
  })

  it("chỉ có cờ recommended (không đuôi) ⇒ gắn đuôi theo ngôn ngữ của câu hỏi", () => {
    const vi = normalizeRecommendation([{ label: "Một máy chủ", recommended: true as const }, { label: "Hai máy chủ" }], "Lý do", "Cần bao nhiêu máy chủ?")
    expect(vi.options[0]).toEqual({ label: "Một máy chủ (Khuyến nghị)", recommended: true })
    const en = normalizeRecommendation([{ label: "One server", recommended: true as const }, { label: "Two servers" }], "Reason", "How many servers?")
    expect(en.options[0].label).toBe("One server (Recommended)")
  })

  it("không có khuyến nghị ⇒ bỏ lý do (không trỏ vào phương án nào), không báo bỏ", () => {
    const out = normalizeRecommendation([{ label: "A" }, { label: "B" }], "Lý do lạc")
    expect(out).toEqual({ options: [{ label: "A" }, { label: "B" }] })
  })

  it("helper đuôi / cờ", () => {
    expect(withoutRecommendedSuffix("99% (Recommended)")).toBe("99%")
    expect(isRecommended({ label: "99% (Khuyến nghị)" })).toBe(true)
    expect(clearRecommendation({ label: "99% (Khuyến nghị)", recommended: true as const, cons: ["x"] })).toEqual({ label: "99%", cons: ["x"] })
    expect(recommendedSuffixFor("Nền tảng nào?")).toBe(" (Khuyến nghị)")
    expect(recommendedSuffixFor("Which platform?")).toBe(" (Recommended)")
  })

  it("log bỏ khuyến nghị có nhãn cố định để đếm; không có gì thì không ghi", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    logRecommendationDropped("elicit", "missing_reason", [])
    expect(info).not.toHaveBeenCalled()
    logRecommendationDropped("elicit", "missing_reason", ["uptime"])
    expect(info).toHaveBeenCalledWith(expect.stringContaining("[option-analysis] recommendation_dropped scope=elicit reason=missing_reason count=1 topics=uptime"))
  })
})

describe("FLF-449 N1: OptionSet", () => {
  it("modelOptionSetSchema áp luật khuyến nghị; evidence chỉ giữ khi còn khuyến nghị", () => {
    const evidence = { quote: "khách đặt qua điện thoại", source: "document" as const }
    const kept = modelOptionSetSchema.parse({
      options: [{ label: "Gọi lại (Khuyến nghị)" }, { label: "Tự đặt online" }],
      recommendation_reason: "Biên bản họp ghi khách đặt qua điện thoại",
      evidence
    })
    expect(kept).toMatchObject({ recommendation_reason: "Biên bản họp ghi khách đặt qua điện thoại", evidence })
    const dropped = modelOptionSetSchema.parse({ options: [{ label: "Gọi lại (Khuyến nghị)" }, { label: "Tự đặt online" }], evidence })
    expect(dropped).toEqual({ options: [{ label: "Gọi lại" }, { label: "Tự đặt online" }], dropped: "missing_reason" })
  })

  it("2–4 phương án; recommended là tuỳ chọn", () => {
    expect(modelOptionSetSchema.safeParse({ options: [{ label: "A" }] }).success).toBe(false)
    expect(optionSetSchema.safeParse({ options: [{ label: "A" }, { label: "B", pros: ["x"] }] }).success).toBe(true)
    expect(optionSetSchema.safeParse({ options: [{ label: "A", recommended: true }, { label: "B" }], recommendation_reason: "r" }).success).toBe(true)
    expect(optionSetSchema.safeParse({ options: [{ label: "" }, { label: "B" }] }).success).toBe(false)
  })
})
