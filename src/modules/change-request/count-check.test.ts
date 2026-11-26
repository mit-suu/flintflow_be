/**
 * FLF-473 (EduCampus B14) — câu đếm số phần tử ở C-4 (số đúng sau CR trong prompt) và C-5 (kiểm tất định). C-3 đã kiểm
 * ở `impact.test.ts` (`countMentionLocations`); `count-mentions.test.ts` kiểm hàm dò câu đếm thuần.
 */
import { describe, expect, it } from "vitest"
import { countAfterOf, locationPromptText } from "./propose.service.js"
import { checkCountMentions } from "./verify.service.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"

const block = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })

const spineWith10UseCases = (): Spine => {
  const s = createEmptySpine({ name: "EduCampus" })
  s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "..." } as never)
  s.custom_sections.push({ id: "CS07", heading: "", level: 3, source: "import", blocks: [block("Hệ thống có 10 use case cho người học.")] })
  for (let i = 1; i <= 10; i++) s.use_cases.push({ id: `UC-${String(i).padStart(2, "0")}`, name: `Use case ${i}`, actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } as never)
  return s
}

/** CR không phải lô use case đã duyệt (title/description không khớp ý "thêm use case") ⇒ `approvedBatch` ra null, dùng `seed.ops`. */
const crWithSeedOps = (ops: Record<string, unknown>[]): Pick<IChangeRequest, "seed" | "amendments" | "title" | "description" | "clarifications"> => ({
  title: "Sửa đoạn giới thiệu use case",
  description: "Cập nhật lại đoạn văn nối cho đúng số use case hiện có.",
  amendments: [],
  clarifications: [],
  seed: { instruction: null, ops, targets: [] }
})

describe("FLF-473 (B14) - C-4 countAfterOf + locationPromptText: số đúng sau CR vào prompt", () => {
  const addTwoUseCases = [
    { op: "add", path: "use_cases[]", value: { id: "UC-11", name: "Use case 11", actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } },
    { op: "add", path: "use_cases[]", value: { id: "UC-12", name: "Use case 12", actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } }
  ]

  it("CR (seed.ops) thêm 2 use case ⇒ countAfterOf trả use_cases = 12, actors giữ nguyên", () => {
    const spine = spineWith10UseCases()
    const after = countAfterOf(crWithSeedOps(addTwoUseCases), spine)
    expect(after.get("use_cases")).toBe(12)
    expect(after.get("actors")).toBe(spine.actors.length)
  })

  it("vị trí found_by=count, entity_paths=['use_cases'] ⇒ prompt có dòng COUNT CHECK với số đúng (12), luật chỉ thay số", () => {
    const spine = spineWith10UseCases()
    const countAfter = countAfterOf(crWithSeedOps(addTwoUseCases), spine)
    const loc = { location_id: "L001", path: "custom_sections[id=CS07]", section_id: "custom:CS07", found_by: ["count" as const], entity_paths: ["use_cases"], verify: null }
    const text = locationPromptText(spine, loc, [], null, countAfter)
    expect(text).toContain('COUNT CHECK: after this change request, "use_cases" has exactly 12 elements')
    expect(text).toContain("never compute it yourself")
  })

  it("CR không có ops nào đổi số phần tử ⇒ countAfterOf rỗng, locationPromptText không thêm dòng COUNT CHECK", () => {
    const spine = spineWith10UseCases()
    const countAfter = countAfterOf(crWithSeedOps([]), spine)
    expect(countAfter.size).toBe(0)
    const loc = { location_id: "L001", path: "custom_sections[id=CS07]", section_id: "custom:CS07", found_by: ["count" as const], entity_paths: ["use_cases"], verify: null }
    expect(locationPromptText(spine, loc, [], null, countAfter)).not.toContain("COUNT CHECK")
  })

  it("vị trí không mang found_by=count ⇒ không thêm dòng COUNT CHECK dù có countAfter", () => {
    const spine = spineWith10UseCases()
    const countAfter = countAfterOf(crWithSeedOps(addTwoUseCases), spine)
    const loc = { location_id: "L002", path: "actors[id=A01]", section_id: "fixed:2.1", found_by: ["mention" as const], entity_paths: [], verify: null }
    expect(locationPromptText(spine, loc, [], null, countAfter)).not.toContain("COUNT CHECK")
  })
})

describe("FLF-473 (B14) - C-5 checkCountMentions: câu đếm phải khớp số đúng sau khi ghi cả CR", () => {
  const countLocation = (newText: string) => ({
    location_id: "L001",
    path: "custom_sections[id=CS07]",
    conclusion: "edit" as const,
    proposal: { new_text: newText, old_text: "", spine_ops: [], comment_text: null, assumptions: [], proposed_at: null },
    found_by: ["count" as const],
    entity_paths: ["use_cases"]
  })

  it("đề xuất ghi 11 trong khi Spine sau CR có 12 ⇒ vi phạm count_mismatch", () => {
    const after = spineWith10UseCases()
    after.use_cases.push(
      { id: "UC-11", name: "Use case 11", actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } as never,
      { id: "UC-12", name: "Use case 12", actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } as never
    )
    const violations = checkCountMentions(after, [countLocation("Hệ thống có 11 use case cho người học.")])
    expect(violations.get("L001")).toEqual([{ rule: "count_mismatch", message: expect.stringContaining("11") }])
    expect(violations.get("L001")![0].message).toContain("12")
  })

  it("đề xuất ghi đúng số sau CR ⇒ không vi phạm", () => {
    const after = spineWith10UseCases()
    after.use_cases.push(
      { id: "UC-11", name: "Use case 11", actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } as never,
      { id: "UC-12", name: "Use case 12", actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } as never
    )
    const violations = checkCountMentions(after, [countLocation("Hệ thống có 12 use case cho người học.")])
    expect(violations.get("L001")).toBeUndefined()
  })

  it("vị trí không mang found_by=count, hoặc kết luận không phải edit ⇒ bỏ qua", () => {
    const after = spineWith10UseCases()
    const notCount = { ...countLocation("Hệ thống có 11 use case."), found_by: ["mention" as const] }
    const notEdit = { ...countLocation("Hệ thống có 11 use case."), conclusion: "comment" as const }
    expect(checkCountMentions(after, [notCount, notEdit]).size).toBe(0)
  })
})
