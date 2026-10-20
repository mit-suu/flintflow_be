import { describe, it, expect } from "vitest"
import { newUseCaseGapNote, newUseCaseGaps } from "./new-usecase-gaps.js"
import type { Spine } from "./spine.types.js"

type Parts = Pick<Spine, "use_cases" | "functions">

const uc = (id: string, name: string, function_ids: string[] = []) => ({ id, name, actor_ids: ["A01"], function_ids, description: "", includes: [], extends: [] })
const fn = (id: string, screen_id: string | null) => ({ id, screen_id }) as unknown as Spine["functions"][number]

const before: Parts = { use_cases: [uc("UC01", "Log In", ["FN001"])], functions: [fn("FN001", "S01")] }

describe("newUseCaseGaps — FLF-298", () => {
  it("use case mới không có chức năng ⇒ no_function; use case cũ không bị xét", () => {
    const after: Parts = { ...before, use_cases: [uc("UC01", "Log In"), uc("UC27", "Send Absence Warning")] }
    expect(newUseCaseGaps(before, after)).toEqual([{ use_case_id: "UC27", name: "Send Absence Warning", kind: "no_function" }])
  })

  it("có chức năng nhưng chỉ là chức năng nền ⇒ no_screen; gắn chức năng của màn ⇒ không báo", () => {
    const after: Parts = {
      use_cases: [...before.use_cases, uc("UC27", "Send Absence Warning", ["FN090"]), uc("UC28", "View Warning", ["FN001"])],
      functions: [...before.functions, fn("FN090", null)]
    }
    expect(newUseCaseGaps(before, after)).toEqual([{ use_case_id: "UC27", name: "Send Absence Warning", kind: "no_screen" }])
  })

  it("câu cảnh báo theo ngôn ngữ trả lời; không có gì thiếu ⇒ null", () => {
    expect(newUseCaseGapNote([])).toBeNull()
    const gap = [{ use_case_id: "UC27", name: "Send Absence Warning", kind: "no_function" as const }]
    expect(newUseCaseGapNote(gap)).toMatch(/"Send Absence Warning" chưa gắn chức năng nào.*§3\.1\.3/)
    expect(newUseCaseGapNote(gap, "en")).toMatch(/has no function yet/)
  })
})
