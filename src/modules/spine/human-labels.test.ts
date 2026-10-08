/**
 * Nhãn cho người đọc thay mã kỹ thuật (mode 1 — không in `fixed:2.2.1`, `use_cases[id=UC-01].description`, `section_empty`).
 */
import { describe, expect, it } from "vitest"
import {
  capitalize,
  diagramLabel,
  humanizeText,
  nameElementIds,
  pathLabel,
  quotedSectionLabel,
  ruleLabel,
  sectionLabel,
  UNKNOWN_PATH_LABEL
} from "./human-labels.js"

describe("pathLabel", () => {
  it("path theo khoá ⇒ tên thực thể + mã + tên field (khớp FE)", () => {
    expect(pathLabel("use_cases[id=UC-01].description")).toBe("Use case UC-01 — Mô tả")
    expect(pathLabel("actors[]")).toBe("Tác nhân (thêm mới)")
    expect(pathLabel("project.system_name")).toBe("Thông tin dự án — Tên hệ thống")
    expect(pathLabel("use_cases[id=UC-01].actor_ids[=A09]")).toBe("Use case UC-01 › Tác nhân A09")
    expect(pathLabel("functions[id=FR-1].normal[0]")).toBe("Chức năng FR-1 › Luồng chính #1")
  })

  it("có tên phần tử ⇒ ghép sau mã (khớp FE); path không có khoá thì bỏ qua tên", () => {
    expect(pathLabel("actors[id=A01].kind", "Learner")).toBe("Tác nhân A01 (Learner) — Loại")
    expect(pathLabel("project.code", "X")).toBe("Thông tin dự án — Mã")
  })

  it("path không đọc được ⇒ nhãn chung, không trả nguyên path", () => {
    expect(pathLabel("progress.screen_cursor")).toBe(UNKNOWN_PATH_LABEL)
    expect(pathLabel("flags[id=FL01]")).toBe(UNKNOWN_PATH_LABEL)
  })

  it("humanizeText đổi path nằm giữa câu", () => {
    expect(humanizeText("use_cases[id=UC-01] không còn, xem actors[id=A1].name")).toBe("Use case UC-01 không còn, xem Tác nhân A1 — Tên")
  })
})

describe("sectionLabel", () => {
  const spine = {
    features: [{ id: "F1", name: "Auth" }],
    functions: [{ id: "FN1", name: "Log In" }],
    custom_sections: [{ id: "CS07", heading: "Phụ lục A" }]
  } as never
  it("mục cố định theo số + tiêu đề mẫu FPT; feature/function/mục riêng theo tên", () => {
    expect(sectionLabel("fixed:5.5")).toBe("5.5 Glossary")
    expect(quotedSectionLabel("fixed:2.2.1")).toBe('"2.2.1 Use Case Diagram"')
    expect(sectionLabel("feature:F1", spine)).toBe('tính năng "Auth"')
    expect(sectionLabel("function:FN1", spine)).toBe('chức năng "Log In"')
    expect(sectionLabel("custom:CS07", spine)).toBe('mục riêng "Phụ lục A"')
  })
  it("id tạm / lạ ⇒ nhãn chung, không in khoá hay block id", () => {
    for (const id of ["feature:@B0012", "function:@B0040", "custom:CS99", "fixed:9.9", "weird"]) {
      const label = sectionLabel(id, spine)
      expect(label).not.toMatch(/fixed:|custom:|feature:|function:|B00|CS99/)
    }
  })
})

describe("ruleLabel / diagramLabel", () => {
  it("mã luật biết ⇒ nhãn; lạ ⇒ rỗng", () => {
    expect(ruleLabel("section_empty")).toBe("Mục còn trống")
    expect(ruleLabel("new_red_flag")).toBe("Làm phát sinh lỗi đỏ mới")
    expect(ruleLabel("whatever")).toBe("")
  })
  it("sơ đồ theo loại tiếng Việt + mục, không in id hình / mã loại", () => {
    const label = capitalize(diagramLabel({ kind: "usecase", owner_id: null, section: "fixed:2.2.1" }))
    expect(label).toBe('Sơ đồ use case (mục "2.2.1 Use Case Diagram")')
    expect(diagramLabel({ kind: "screen_layout", owner_id: "S1", section: "function:FN1" }, { screens: [{ id: "S1", name: "Login" }] } as never)).toBe(
      'bố cục màn hình "Login"'
    )
  })
})

describe("nameElementIds", () => {
  const spine = {
    screens: [
      { id: "S01", name: "Login" },
      { id: "S02", name: "Reset Password" },
      { id: "S03", name: "Schedule Composer" },
      { id: "S11", name: "Class Schedule" }
    ],
    actors: [{ id: "A03", name: "Teacher" }],
    functions: [{ id: "FN010", name: "Take Attendance" }]
  } as unknown as Parameters<typeof nameElementIds>[1]

  it("mã màn trong câu hỏi làm rõ ⇒ tên; mã trong ngoặc ngay sau chính tên của nó ⇒ bỏ", () => {
    expect(
      nameElementIds(
        "Màn hình 'Login' (S01) hiện có luồng đi ra tới S02, S03, S11 nhưng không có màn hình nào đi tới nó — bạn muốn xử lý thế nào?",
        spine
      )
    ).toBe(
      "Màn hình 'Login' hiện có luồng đi ra tới 'Reset Password', 'Schedule Composer', 'Class Schedule' nhưng không có màn hình nào đi tới nó — bạn muốn xử lý thế nào?"
    )
  })

  it("mã trong ngoặc không đi sau tên ⇒ thay bằng tên; mã đã có nháy không bị nháy kép; mã lạ và mã use case giữ nguyên", () => {
    expect(nameElementIds("Đổi màn (S02) cho actor 'A03' ở FN010?", spine)).toBe("Đổi màn 'Reset Password' cho actor 'Teacher' ở 'Take Attendance'?")
    expect(nameElementIds("UC-01 và S99 không đổi; S011 và S01x cũng vậy", spine)).toBe("UC-01 và S99 không đổi; S011 và S01x cũng vậy")
  })
})
