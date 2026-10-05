import { describe, expect, it } from "vitest"
import { columnRole, groupOf, headerRowIndex, isMarkMatrix, markActions, tableShape } from "./table-shape.js"

describe("columnRole — vai trò cột theo dữ liệu (FLF-252)", () => {
  it("số thứ tự tăng dần ⇒ row_no; số lặp / không liền mạch ⇒ không phải", () => {
    expect(columnRole(["1", "2", "3", "4"]).role).toBe("row_no")
    expect(columnRole(["1.", "2.", "3."]).role).toBe("row_no")
    expect(columnRole(["1", "1", "2", "3"]).role).not.toBe("row_no")
  })

  it("mã ⇒ code kèm tiền tố chiếm đa số; phiên bản không bị nhận là mã", () => {
    expect(columnRole(["UC-01", "UC-02", "UC03"])).toEqual({ role: "code", prefix: "UC" })
    expect(columnRole(["MSG01", "MSG02", "AUTH-001"])).toEqual({ role: "code", prefix: "MSG" })
    expect(columnRole(["NFR-P01", "NFR-R02"])).toEqual({ role: "code", prefix: "NFR" })
    expect(columnRole(["v0.1", "v0.2", "1.0"]).role).toBe("version")
  })

  it("ngày, loại thay đổi A/M/D, ô đánh dấu, chữ dài / tên, cột trống", () => {
    expect(columnRole(["29/07/2026", "29/7/2026", "2026-09-28"]).role).toBe("date")
    expect(columnRole(["A", "M", "D", "A"]).role).toBe("change_type")
    expect(columnRole(["X", "X", "✓"]).role).toBe("mark")
    expect(columnRole(["view", "view, create", "update/delete"]).role).toBe("mark")
    expect(columnRole(["An unauthenticated user who can view public content and register"]).role).toBe("text")
    expect(columnRole(["Guest", "Admin"]).role).toBe("name")
    expect(columnRole([]).role).toBe("empty")
  })
})

describe("tableShape", () => {
  it("hàng tên bảng gộp cả bảng bị bỏ ⇒ tiêu đề là hàng đủ ô đầu tiên", () => {
    const rows = [["Table 3: Actors"], ["#", "Actor", "Description"], ["1", "Guest", "Visitor"]]
    expect(headerRowIndex(rows)).toBe(1)
    expect(tableShape(rows)).toMatchObject({ header: 1, headers: ["#", "Actor", "Description"], body: [2] })
  })

  it("hàng nhóm (ô gộp, ít chữ) không phải hàng dữ liệu; nhãn nhóm cho hàng bên dưới", () => {
    // bảng use case của SRS thật: "1 | Account & Organization" gộp ngang trước các UC của nhóm
    const rows = [
      ["ID", "Use Case", "Actors", "Use Case Description"],
      ["1", "Account & Organization"],
      ["UC-01", "Register Account", "Guest", "Create an account"],
      ["UC-02", "Verify Email", "Guest", ""],
      ["2", "Project Workspace"],
      ["UC-16", "Create SRS project", "SRS Author", "Create a project"]
    ]
    const shape = tableShape(rows)
    expect(shape.body).toEqual([2, 3, 5])
    expect(shape.groups).toEqual([
      { row: 1, label: "Account & Organization" },
      { row: 4, label: "Project Workspace" }
    ])
    expect(groupOf(shape, 3)).toBe("Account & Organization")
    expect(groupOf(shape, 5)).toBe("Project Workspace")
    // cột ID chỉ tính hàng dữ liệu ⇒ mã UC, không lẫn số nhóm
    expect(shape.columns[0]).toMatchObject({ role: "code", prefix: "UC", samples: ["UC-01", "UC-02", "UC-16"] })
  })

  it("hàng dữ liệu đủ ô nhưng thưa chữ vẫn là dữ liệu (không có ô gộp)", () => {
    const shape = tableShape([["Actor", "Kind", "Description"], ["Guest", "", ""]])
    expect(shape.body).toEqual([1])
    expect(shape.groups).toEqual([])
  })

  it("ma trận màn hình × vai trò; ô đánh dấu ⇒ thao tác", () => {
    const matrix = tableShape([
      ["Screen", "Guest", "User", "Admin"],
      ["PUBLIC SCREENS"],
      ["Landing Page", "X", "X", "X"],
      ["Sign Up", "X", "", ""]
    ])
    expect(matrix.body).toEqual([2, 3])
    expect(isMarkMatrix(matrix)).toBe(true)
    expect(isMarkMatrix(tableShape([["Screen", "Description"], ["Login", "Sign in to the system"]]))).toBe(false)
    expect(markActions("X")).toEqual(["access"])
    expect(markActions("view, create")).toEqual(["view", "create"])
    expect(markActions(" ")).toEqual([])
    expect(markActions("—")).toEqual([])
  })

  it("ma trận FlintFlow xuất ra: ô '—' là không có quyền, không làm hỏng nhận dạng cột", () => {
    const shape = tableShape([
      ["Screen", "Exam Manager", "Lecturer", "Student"],
      ["Login", "view", "view", "view"],
      ["Exam Management", "view, create, update, delete", "—", "—"],
      ["Paper Submission", "view", "view, create, update", "—"]
    ])
    expect(shape.columns.map((c) => c.role)).toEqual(["name", "mark", "mark", "mark"])
    expect(isMarkMatrix(shape)).toBe(true)
  })
})
