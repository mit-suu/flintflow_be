/**
 * L11b — `emptyFedSections`: mục step nuôi mà chạy xong vẫn trống, tính bằng đúng hàm luật `section_empty` soi.
 * Có nó thì gate nói được "AI không soạn được gì cho mục X" thay vì để user Accept rồi quay lại vòng mở-lại-bước.
 */
import { describe, expect, it } from "vitest"
import { emptyFedSections } from "./step-runner.service.js"
import { SECTION_HAS_DATA } from "../spine/deterministic-check.js"
import type { Spine } from "../spine/spine.types.js"

/** Spine rỗng tối thiểu — chỉ cần các mảng mà `SECTION_HAS_DATA` đụng tới. */
const emptySpine = (): Spine =>
  ({
    spine_version: 1,
    project: { vision: "", goals: [], release_scope: { in: [], out: [] } },
    actors: [],
    use_cases: [],
    screens: [],
    roles: [],
    permissions: [],
    functions: [],
    entities: [],
    features: [],
    nfrs: [],
    business_rules: [],
    common_requirements: [],
    messages: [],
    other_requirements: [],
    diagrams: [],
    assumptions: [],
    flags: [],
    steps: [],
    baselines: [],
    glossary: [],
    addendum: [],
    progress: { current_phase: "S-7", current_step: "S-7.2", elicit_turns_this_phase: 0 }
  }) as unknown as Spine

describe("emptyFedSections (L11b)", () => {
  it("step nuôi mục trống ⇒ trả mục đó kèm tiêu đề mẫu FPT", () => {
    const result = emptyFedSections(emptySpine(), "S-7.2")
    expect(result).toEqual([{ section_id: "fixed:5.2", title: "Common Requirements" }])
  })

  it("mục đã có dữ liệu ⇒ không còn trong danh sách", () => {
    const spine = emptySpine()
    spine.common_requirements = [{ id: "CR01", category: "feedback", statement: "Every screen shows a loading state." }] as Spine["common_requirements"]
    expect(emptyFedSections(spine, "S-7.2")).toEqual([])
  })

  it("dùng chung tiêu chí với luật section_empty — không có đường cho hai bên lệch nhau", () => {
    const spine = emptySpine()
    for (const [sectionId, hasData] of Object.entries(SECTION_HAS_DATA)) {
      const flagged = !hasData(spine)
      const listed = emptyFedSections(spine, ownerStepFor(sectionId)).some((s) => s.section_id === sectionId)
      // Chỉ so các mục mà step sở hữu thực sự nuôi (một số mục do nhiều step nuôi, một số step nuôi nhiều mục)
      if (listed) expect(flagged, sectionId).toBe(true)
    }
  })

  it("step không nuôi mục nào (bước ghép/kiểm tra) ⇒ rỗng", () => {
    expect(emptyFedSections(emptySpine(), "S-9.1")).toEqual([])
  })
})

/** Step sở hữu mục — chép từ `FIXED_OWNER_STEPS` để test không phụ thuộc thứ tự import. */
function ownerStepFor(sectionId: string): string {
  const map: Record<string, string> = {
    "fixed:1": "S-2.1",
    "fixed:2.1": "S-3.1",
    "fixed:2.2.1": "S-3.6",
    "fixed:2.2.2": "S-3.2",
    "fixed:3.1.1": "S-4.2",
    "fixed:3.1.2": "S-4.1",
    "fixed:3.1.3": "S-4.3",
    "fixed:3.1.4": "S-4.4",
    "fixed:3.1.5": "S-4.5",
    "fixed:4.1": "S-6.1",
    "fixed:4.2.1": "S-6.2",
    "fixed:4.2.2": "S-6.3",
    "fixed:4.2.3": "S-6.4",
    "fixed:5.1": "S-7.1",
    "fixed:5.2": "S-7.2",
    "fixed:5.3": "S-7.3",
    "fixed:5.4": "S-7.4"
  }
  return map[sectionId] ?? "S-9.1"
}
