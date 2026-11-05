/**
 * FLF-367: CR mâu thuẫn với tài liệu phải hỏi người dùng — phần hàm thuần: ngữ cảnh mở rộng (BR / NFR đủ câu, đoạn văn
 * giữ nguyên liên quan, phần tử section khác cho C-5) và lọc câu hỏi mâu thuẫn đã hỏi. Luồng trên DB ở
 * `test/integration/mode1/clarify.int.test.ts` + `verify.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { parseResponse } from "../../shared/ai/response-parser.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { CONTRADICTION_CHOICES, newContradictions } from "./clarify.service.js"
import { RELATED_PASSAGES_CHARS, crProjection, plainValues, relatedElements, relatedPassages, relatedRules } from "./cr-context.js"
import { scopeText } from "./verify.service.js"

const PASSWORD_RULE = "Khi người dùng tạo tài khoản mới hoặc đổi mật khẩu, mật khẩu phải có ít nhất 8 ký tự."

const paragraph = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.business_rules.push(
    { id: "BR-01", tier: "detail", statement: PASSWORD_RULE, source_validation_ids: [] },
    { id: "BR-02", tier: "detail", statement: "Đơn hàng quá 30 ngày không được hoàn tiền.", source_validation_ids: [] }
  )
  s.nfrs.push({ id: "NFR-01", statement: "The system shall respond within 2 seconds.", category: "performance", kind: "measurable", priority: null, threshold: "2 s" } as unknown as Spine["nfrs"][number])
  s.custom_sections.push(
    { id: "CS01", heading: "Chính sách bảo mật", level: 1, source: "import", blocks: [paragraph("Giới thiệu chung."), paragraph("Tài khoản bị khoá sau 5 lần đăng nhập sai liên tiếp.")] },
    { id: "CS02", heading: "Ghi chú cuộc họp", level: 1, source: "import", blocks: [paragraph("Nhóm thống nhất lịch demo vào thứ Sáu.")] }
  )
  return s
}

/** Tài liệu lớn (BR / NFR quá `ALL_RULES_CHARS`, văn xuôi quá `RELATED_PASSAGES_CHARS`) ⇒ phải lọc theo độ liên quan. */
const big = (s: Spine = spine()): Spine => {
  for (let i = 0; i < 90; i++) s.business_rules.push({ id: `BR-9${String(i).padStart(2, "0")}`, tier: "detail", statement: `Lorem ipsum dolor sit amet consectetur adipiscing elit sed eiusmod tempor incididunt labore magna aliqua number ${i}.`, source_validation_ids: [] })
  s.custom_sections.push({ id: "CS99", heading: "Phụ lục", level: 1, source: "import", blocks: Array.from({ length: 30 }, (_, i) => paragraph(`Lorem ipsum dolor sit amet ${i} ${"q".repeat(180)}`)) })
  return s
}

describe("FLF-367 ngữ cảnh mở rộng cho C-2 / rút yêu cầu", () => {
  it("tài liệu nhỏ ⇒ gửi đủ mọi BR / NFR và đoạn văn giữ nguyên, kể cả khi CR khác ngôn ngữ tài liệu (không có từ chung)", () => {
    const s = spine()
    s.business_rules.push({ id: "BR-05", tier: "detail", statement: "An account is locked temporarily after five consecutive failed login attempts and unlocks automatically after 15 minutes.", source_validation_ids: [] })
    s.custom_sections.push({ id: "CS05", heading: "Security", level: 1, source: "import", blocks: [paragraph("Accounts are locked after 5 failed attempts.")] })
    const p = crProjection(s, "Khoá tài khoản sau 3 lần đăng nhập sai liên tiếp")
    expect(p).toContain("business_rules[id=BR-05] (")
    expect(p).toContain("after five consecutive failed login attempts")
    expect(p).toContain("  - Accounts are locked after 5 failed attempts.")
    expect(p).toContain("không được hoàn tiền")
  })


  it("đoạn văn giữ nguyên liên quan (theo cụm từ của CR) có trong projection; đoạn không liên quan thì không", () => {
    const p = crProjection(big(), "Khoá tài khoản sau 3 lần đăng nhập sai")
    expect(p).toContain('Related passages of the document kept verbatim (not in the structured data above):\ncustom_sections[id=CS01] "Chính sách bảo mật" (custom:CS01):\n  - Tài khoản bị khoá sau 5 lần đăng nhập sai liên tiếp.')
    expect(p).not.toContain("Giới thiệu chung.")
    expect(p).not.toContain("lịch demo")
  })

  it("BR ở section khác, con số sau 40 ký tự đầu ⇒ gửi đủ câu; BR không liên quan thì không", () => {
    expect(PASSWORD_RULE.indexOf("8")).toBeGreaterThan(40)
    const p = crProjection(big(), "Mật khẩu chỉ cần tối thiểu 6 ký tự")
    expect(p).toMatch(/Related business rules \/ non-functional requirements \(full text\):\nbusiness_rules\[id=BR-01\] \([^)]*\): Khi người dùng .* ít nhất 8 ký tự\./)
    expect(p).not.toContain("không được hoàn tiền")
  })

  it("không liên quan ⇒ (none); phần tử đã nêu ở 'Mentioned' không lặp ở phần liên quan; chỉ mục cũ giữ nguyên", () => {
    const none = crProjection(big(), "nothing relevant")
    expect(none).toContain("Related business rules / non-functional requirements (full text):\n(none)")
    expect(none).toContain("Related passages of the document kept verbatim (not in the structured data above):\n(none)")
    expect(none).toContain(`business_rules: BR-01 ${PASSWORD_RULE.slice(0, 40)};`)
    expect(relatedRules(big(), "mật khẩu tối thiểu 6 ký tự", { exclude: ["business_rules[id=BR-01]"] })).toEqual([])
  })

  it("mục được gọi tên ⇒ lấy cả mục dù không trùng chữ; trong ngân sách ký tự", () => {
    expect(relatedPassages(big(), "sửa mục này", { sections: ["custom:CS02"] })).toEqual(['custom_sections[id=CS02] "Ghi chú cuộc họp" (custom:CS02):', "  - Nhóm thống nhất lịch demo vào thứ Sáu."])
    const s = spine()
    s.custom_sections[0].blocks = Array.from({ length: 40 }, (_, i) => paragraph(`Tài khoản bị khoá sau ${i} lần đăng nhập sai. ${"x".repeat(300)}`))
    const out = relatedPassages(s, "khoá tài khoản sau 3 lần đăng nhập sai").join("\n")
    expect(out.length).toBeLessThan(RELATED_PASSAGES_CHARS + 200)
  })

  it("C-5: phần tử liên quan ở section khác chấm theo giá trị, không theo tên khoá JSON", () => {
    expect(plainValues('{"id":"NFR-01","statement":"respond within 1 second","business_rule_ids":[]}')).toBe("NFR-01\nrespond within 1 second")
    const s = spine()
    expect(relatedElements(s, "Mật khẩu tối thiểu 6 ký tự").map((e) => e.path)).toEqual(["business_rules[id=BR-01]"])
    // tên khoá ("business_rule_ids", "source_validation_ids") không làm mọi phần tử thành liên quan
    expect(relatedElements(s, "business_rule_ids source_validation_ids statement")).toEqual([])
  })

  it("C-5 scope: phần tử cùng section + phần tử section khác + đoạn văn giữ nguyên liên quan", () => {
    const s = spine()
    const changed = [{ path: "nfrs[id=NFR-01]", section_id: "fixed:4.2.3", proposal: { new_text: '{"statement":"Khoá tài khoản sau 3 lần đăng nhập sai"}', comment_text: null } }]
    const scope = scopeText(s, changed as never, "Mật khẩu tối thiểu 6 ký tự")
    expect(scope).toContain("[business_rules[id=BR-01]]")
    expect(scope).toContain('Passages kept verbatim:\ncustom_sections[id=CS01] "Chính sách bảo mật" (custom:CS01):')
    expect(scope).not.toContain("[nfrs[id=NFR-01]]")
  })
})

describe("FLF-367 câu hỏi mâu thuẫn", () => {
  it("C-2 schema nhận `contradictions` (mặc định []), không cần ambiguous", () => {
    const out = parseResponse(
      JSON.stringify({ ambiguous: false, contradictions: [{ question: "3 hay 5 lần?" }], targets: { keywords: ["khoá"] } }),
      ActionType.CR_CLARIFY
    ) as { contradictions: unknown }
    expect(out.contradictions).toEqual([{ question: "3 hay 5 lần?", suggestions: [] }])
    expect((parseResponse(JSON.stringify({ ambiguous: false, targets: { keywords: ["x"] } }), ActionType.CR_CLARIFY) as { contradictions: unknown }).contradictions).toEqual([])
  })

  it("bỏ câu đã hỏi ở vòng trước (khác hoa thường / khoảng trắng) và câu trùng; không gợi ý ⇒ lựa chọn mặc định", () => {
    const cr = { clarifications: [{ round: 1, questions: ["CR ghi 3 lần, tài liệu ghi 5 lần?"], answers: ["Giữ như cũ"], suggestions: [] }] }
    const out = newContradictions(cr as never, [
      { question: "  cr ghi 3 lần,   tài liệu ghi 5 lần? ", suggestions: [] },
      { question: "Mật khẩu 6 hay 8 ký tự?", suggestions: [] },
      { question: "Mật khẩu 6 hay 8 ký tự?", suggestions: [] },
      { question: "1 giây hay 2 giây?", suggestions: ["1 giây", " 1 giây ", "2 giây"] }
    ])
    expect(out).toEqual([
      { question: "Mật khẩu 6 hay 8 ký tự?", suggestions: [...CONTRADICTION_CHOICES] },
      { question: "1 giây hay 2 giây?", suggestions: ["1 giây", "2 giây"] }
    ])
  })
})
