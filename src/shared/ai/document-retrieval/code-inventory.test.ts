import { describe, expect, it } from "vitest"
import { codeInventory, describeFamily, formatInventory, INVENTORY_HEADER } from "./code-inventory.js"

describe("codeInventory (FLF-393)", () => {
  it("đếm mã khác nhau theo loại, mã lặp chỉ tính một lần, giữ cách in số 0 đầu", () => {
    const texts = ["UC-01 Log in", "UC-02 View timetable; see UC-01 again", "UC-03 Pay", "BR-01: rule one", "• BR-02: rule two"]
    const families = codeInventory(texts)
    expect(families.map(describeFamily)).toEqual(["UC: 3 mã (UC-01 → UC-03, liên tục)", "BR: 2 mã (BR-01 → BR-02, liên tục)"])
  })

  it("chỉ đếm mã được định nghĩa (mở đầu dòng); mã chỉ được nhắc trong câu không tính — UC bị bỏ thì báo thiếu", () => {
    const texts = ["Phiên bản 1.2: bỏ UC-03 vì đã thay bằng chatbot", "UC-01 Đăng nhập", "UC-02 Đặt lịch\nUC-04 Huỷ lịch", "Ví dụ: CR-004 is logged, CR-007 too"]
    expect(codeInventory(texts).map(describeFamily)).toEqual(["UC: 3 mã (UC-01 → UC-04, không có UC-03)"])
  })

  it("báo chính xác mã bị thiếu trong khoảng", () => {
    const [scr] = codeInventory(["SCR-01", "SCR-02", "SCR-04", "SCR-07"])
    expect(describeFamily(scr!)).toBe("SCR: 4 mã (SCR-01 → SCR-07, không có SCR-03, SCR-05, SCR-06)")
  })

  it("82 use case liên tục ⇒ đúng 82, không 81 (demo 2026-11-12)", () => {
    const texts = Array.from({ length: 82 }, (_, i) => `UC-${String(i + 1).padStart(2, "0")} Use case ${i + 1}`)
    expect(describeFamily(codeInventory(texts)[0]!)).toBe("UC: 82 mã (UC-01 → UC-82, liên tục)")
  })

  it("bỏ loại chỉ có một mã, chữ thường, mã dính trong từ dài", () => {
    expect(codeInventory(["Theo ISO-29148, uc-01, ABCDEF-12, xUC-03"])).toEqual([])
  })

  it("formatInventory: một dòng mỗi tài liệu có mã, kèm tiêu đề nói rõ là số chính xác; không có mã ⇒ rỗng", () => {
    const text = formatInventory([
      { label: "D1 (srs.docx)", families: codeInventory(["UC-01", "UC-02"]) },
      { label: "D2 (email.txt)", families: [] }
    ])
    expect(text).toBe(`${INVENTORY_HEADER}\n- D1 (srs.docx): UC: 2 mã (UC-01 → UC-02, liên tục)`)
    expect(formatInventory([{ label: "D1", families: [] }])).toBe("")
  })
})
