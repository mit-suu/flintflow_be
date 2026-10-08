/**
 * C-2 làm rõ CR — phần hàm thuần: ngữ cảnh gửi model (`cr-context`) + giới hạn vòng hỏi. FLF-172, plan §8.3.
 * Luồng trên DB (mơ hồ ⇒ câu hỏi, trả lời ⇒ gọi lại, quá 3 vòng đi tiếp, pause) ở
 * `test/integration/mode1/clarify.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { MAX_CLARIFY_ROUNDS, canAskMore } from "./change-request.state.js"
import { CR_MATERIAL_MAX_CHARS, clipMaterialText } from "./change-request.constants.js"
import { MATERIALS_PROMPT_CHARS, answersText, crHeader, crProjection, glossaryText, materialsText, missingInfoText, namedEntities, truncate } from "./cr-context.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "" } as Spine["actors"][number])
  s.use_cases.push({ id: "UC-02", name: "Log in", actor_ids: ["A01"] } as unknown as Spine["use_cases"][number])
  s.nfrs.push({ id: "NFR-01", statement: "The system shall respond within 2 seconds.", category: "performance" } as unknown as Spine["nfrs"][number])
  return s
}

const cr = (over: Partial<IChangeRequest> = {}): IChangeRequest =>
  ({ cr_id: "CR-001", title: "Faster login", description: "Log in must be faster", source: { kind: "verbal", ref: null, note: null }, clarifications: [], ...over }) as IChangeRequest

describe("C-2 giới hạn vòng hỏi", () => {
  it(`hỏi được khi mới qua < ${MAX_CLARIFY_ROUNDS} vòng; đủ ${MAX_CLARIFY_ROUNDS} vòng ⇒ bắt buộc đi tiếp`, () => {
    expect([0, 1, 2, 3, 4].map(canAskMore)).toEqual([true, true, true, false, false])
  })
})

describe("C-2 ngữ cảnh gửi model", () => {
  it("câu hỏi – trả lời trước theo vòng; câu chưa / không trả lời (trống) ghi (no answer — unknown); chưa có ⇒ (none)", () => {
    expect(answersText(cr())).toBe("(none)")
    const text = answersText(
      cr({
        clarifications: [
          { round: 1, questions: ["Which screen?", "Which actor?"], answers: ["Login screen", "Learner"] },
          { round: 2, questions: ["How fast?", "Which devices?"], answers: ["  ", "all"] }
        ]
      })
    )
    expect(text).toBe("Q1.1: Which screen?\nA: Login screen\nQ1.2: Which actor?\nA: Learner\nQ2.1: How fast?\nA: (no answer — unknown)\nQ2.2: Which devices?\nA: all")
  })

  it("phase 7: tài liệu bổ sung ⇒ [id] tên (lúc đính kèm) + nội dung; không có ⇒ (none)", () => {
    const at = new Date()
    expect(materialsText(cr({ materials: [] }))).toBe("(none)")
    const text = materialsText(
      cr({
        materials: [
          { material_id: "M01", kind: "text", name: "Email PM", text: "Response ≤ 2 s", truncated: false, round: 0, added_at: at },
          { material_id: "M02", kind: "image", name: "notes.png", text: "Peak 500 users", truncated: true, round: 2, added_at: at }
        ]
      })
    )
    expect(text).toBe("[M01] Email PM (attached when the CR was logged)\nResponse ≤ 2 s\n\n[M02] notes.png (attached with the answers of round 2; cut at upload)\nPeak 500 users")
  })

  it("phase 7: tổng chữ tài liệu ≤ ngân sách prompt — tài liệu ngắn giữ nguyên, tài liệu dài chia phần còn lại", () => {
    const at = new Date()
    const long = "a".repeat(CR_MATERIAL_MAX_CHARS)
    const text = materialsText(
      cr({
        materials: [
          { material_id: "M01", kind: "file", name: "long-1", text: long, truncated: false, round: 0, added_at: at },
          { material_id: "M02", kind: "text", name: "short", text: "keep me whole", truncated: false, round: 0, added_at: at },
          { material_id: "M03", kind: "file", name: "long-2", text: long, truncated: false, round: 0, added_at: at }
        ]
      })
    )
    expect(text).toContain("keep me whole")
    expect(text.split("…(truncated)").length).toBe(3)
    expect(text.length).toBeLessThan(MATERIALS_PROMPT_CHARS + 400)
    expect(text.indexOf("[M01]")).toBeLessThan(text.indexOf("[M02]"))
  })

  it("phase 7: dữ kiện còn thiếu ⇒ gạch đầu dòng; rỗng ⇒ (none)", () => {
    expect(missingInfoText(cr({ missing_info: [] }))).toBe("(none)")
    expect(missingInfoText(cr({ missing_info: ["Ngưỡng thời gian phản hồi", "Số người dùng đồng thời"] }))).toBe("- Ngưỡng thời gian phản hồi\n- Số người dùng đồng thời")
  })

  it("phase 7: chuẩn hoá chữ tài liệu — xuống dòng Windows, dòng trống thừa, cắt ở giới hạn", () => {
    expect(clipMaterialText("  a\r\nb\n\n\n\nc  ")).toEqual({ text: "a\nb\n\nc", truncated: false })
    const clipped = clipMaterialText("x".repeat(CR_MATERIAL_MAX_CHARS + 5))
    expect(clipped.truncated).toBe(true)
    expect(clipped.text.length).toBe(CR_MATERIAL_MAX_CHARS)
  })

  it("header CR: nguồn kèm ref nếu có", () => {
    expect(crHeader(cr()).source).toBe("verbal")
    expect(crHeader(cr({ source: { kind: "stakeholder_email", ref: "Email PM", note: null } })).source).toBe("stakeholder_email — Email PM")
  })

  it("projection: chỉ mục id + tên theo mảng, chi tiết phần tử được CR nhắc tới (mã hoặc tên)", () => {
    const p = crProjection(spine(), "Log in (UC-02) of the Learner must be faster; NFR-01 too")
    expect(p).toContain("actors: A01 Learner")
    expect(p).toContain("use_cases: UC-02 Log in")
    expect(p).toContain("nfrs: NFR-01 The system shall respond within 2 se")
    expect(p).toContain('use_cases[id=UC-02] = {"id":"UC-02"')
    expect(p).toContain("actors[id=A01] =")
    expect(p).toContain("nfrs[id=NFR-01] =")
    expect(crProjection(spine(), "nothing relevant")).toContain("Mentioned in the CR:\n(none)")
  })

  it("namedEntities gồm actor/entity/feature/screen/use case/function; glossary rỗng ⇒ (empty)", () => {
    expect(namedEntities(spine()).map((e) => `${e.entity}:${e.id}`)).toEqual(["actor:A01", "use_case:UC-02"])
    expect(glossaryText(spine())).toBe("(empty)")
  })

  it("truncate cắt và đánh dấu khi quá dài", () => {
    expect(truncate("abc", 5)).toBe("abc")
    expect(truncate("abcdefgh", 5)).toBe("abcde\n…(truncated)")
  })
})
