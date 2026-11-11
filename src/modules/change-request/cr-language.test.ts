/**
 * QLHS 11/11 bug #17: CR tiếng Việt cho tài liệu tiếng Việt mà C-4 viết bước mới / nhãn luồng bằng tiếng Anh ⇒ luật tất định
 * của C-5 bắt chữ mới khác ngôn ngữ tài liệu; prompt C-4 nêu rõ ngôn ngữ tài liệu.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { documentLanguageText, foreignTexts, guessSpineLanguage, isForeignText, wrongLanguageMessage } from "./cr-language.js"
import { previewAfter } from "./propose.service.js"
import { elementValue, valueText } from "./spine-location.js"
import { checkLocation } from "./verify.service.js"

const EN_STEP = "After GVCN saves attendance, if any student is marked Vắng không phép, the system sends an email to the parent immediately"
const VI_STEP = "Sau khi GVCN lưu điểm danh, nếu có học sinh Vắng không phép, hệ thống gửi email cho phụ huynh ngay"

describe("isForeignText - tài liệu tiếng Việt", () => {
  it("câu tiếng Anh (kể cả chen tên trạng thái tiếng Việt) ⇒ khác ngôn ngữ", () => {
    expect(isForeignText(EN_STEP, "vi")).toBe(true)
    expect(isForeignText("Send absence notification email to parent of student", "vi")).toBe(true)
  })

  it("câu tiếng Việt, câu chêm thuật ngữ, gõ không dấu, nhãn ngắn, mã, trích nguyên văn ⇒ không", () => {
    expect(isForeignText(VI_STEP, "vi")).toBe(false)
    expect(isForeignText("Hệ thống gửi email notification cho phụ huynh", "vi")).toBe(false)
    expect(isForeignText("Gui email cho phu huynh ngay", "vi")).toBe(false)
    expect(isForeignText("Absence Notification", "vi")).toBe(false)
    expect(isForeignText("UC-05, FR-05", "vi")).toBe(false)
    expect(isForeignText("Mở màn “Attendance Report Export Page For Admin”", "vi")).toBe(false)
  })

  it("tài liệu tiếng Anh: câu tiếng Việt ⇒ khác ngôn ngữ; câu Anh có tên riêng Việt ⇒ không", () => {
    expect(isForeignText(VI_STEP, "en")).toBe(true)
    expect(isForeignText("The homeroom teacher of Trường Nguyễn Du saves attendance", "en")).toBe(false)
  })
})

describe("foreignTexts", () => {
  const before = { id: "FR-05", normal: ["GVCN chọn lớp và buổi học", "GVCN đánh dấu trạng thái từng học sinh"] }

  it("chỉ chuỗi MỚI khác ngôn ngữ; chuỗi cũ giữ nguyên không tính", () => {
    expect(foreignTexts("vi", before, { ...before, normal: [...before.normal, EN_STEP] })).toEqual([EN_STEP])
    expect(foreignTexts("vi", before, { ...before, normal: [...before.normal, VI_STEP] })).toEqual([])
  })

  it("phần tử vốn viết ngôn ngữ khác tài liệu ⇒ theo phần tử, không phán", () => {
    const english = { id: "FR-09", normal: ["The teacher picks a class"] }
    expect(foreignTexts("vi", english, { ...english, normal: [...english.normal, EN_STEP] })).toEqual([])
  })

  it("mục rỗng ⇒ theo ngôn ngữ tài liệu", () => {
    expect(foreignTexts("vi", [], [{ id: "BR-20", statement: EN_STEP }])).toEqual([EN_STEP])
  })
})

describe("thông điệp + prompt", () => {
  it("câu người dùng tiếng Việt, không mã nội bộ", () => {
    const m = wrongLanguageMessage("chức năng Điểm danh", "vi", [EN_STEP, "x"])
    expect(m).toContain("viết bằng tiếng Anh trong khi tài liệu viết bằng tiếng Việt")
    expect(m).toContain("(và 1 đoạn khác)")
    expect(m).not.toMatch(/functions\[|L\d{3}/)
  })

  it("dòng Document language của C-4 nêu tên ngôn ngữ + giữ thuật ngữ", () => {
    expect(documentLanguageText("vi")).toMatch(/^Vietnamese \(tiếng Việt\)\. Every new or changed text value/)
    expect(documentLanguageText("vi")).toContain("flows_in / flows_out")
  })

  it("đoán ngôn ngữ từ chữ của Spine", () => {
    const s = createEmptySpine({ name: "QLHS" })
    expect(guessSpineLanguage(s)).toBeNull()
    s.functions.push({ id: "FR-05", name: "Điểm danh", description: "Giáo viên chủ nhiệm điểm danh học sinh theo buổi học", normal: [] } as never)
    expect(guessSpineLanguage(s)).toBe("vi")
  })
})

describe("C-5 checkLocation - wrong_language", () => {
  const PATH = "functions[id=FR-05]"
  const cr = { cr_id: "CR-001" } as IChangeRequest
  const spine = (): Spine => {
    const s = createEmptySpine({ name: "QLHS" })
    s.functions.push({
      id: "FR-05",
      screen_id: null,
      feature_id: "F01",
      order: 1,
      name: "Điểm danh",
      trigger: "",
      description: "Giáo viên chủ nhiệm điểm danh học sinh",
      normal: ["GVCN chọn lớp và buổi học"],
      abnormal: [],
      validations: [],
      business_rule_ids: [],
      priority: null
    })
    return s
  }
  const loc = (step: string): IChangeLocation => {
    const ops = [{ op: "set", path: `${PATH}.normal`, value: ["GVCN chọn lớp và buổi học", step] }]
    return {
      location_id: "L001",
      path: PATH,
      conclusion: "edit",
      proposal: { old_text: valueText(elementValue(spine(), PATH)), new_text: previewAfter(spine(), PATH, ops), comment_text: null, spine_ops: ops }
    } as unknown as IChangeLocation
  }
  const locks = new Map([[PATH, "CR-001"]])

  it("bước mới tiếng Anh trong tài liệu tiếng Việt ⇒ wrong_language; tiếng Việt ⇒ đạt; không truyền ngôn ngữ ⇒ không kiểm", () => {
    const vs = checkLocation(cr, loc(EN_STEP), spine(), locks, "vi")
    expect(vs.map((v) => v.rule)).toEqual(["wrong_language"])
    expect(vs[0].message).toContain("After GVCN saves attendance")
    expect(checkLocation(cr, loc(VI_STEP), spine(), locks, "vi")).toEqual([])
    expect(checkLocation(cr, loc(EN_STEP), spine(), locks)).toEqual([])
  })
})
