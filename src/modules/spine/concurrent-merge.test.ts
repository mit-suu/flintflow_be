/** P12 — bảng 4 trường hợp "Hai người sửa cùng lúc" (BF §3.2), phần dùng chung cho sửa qua chat và CR (hàm thuần). */
import { describe, expect, it } from "vitest"
import { classifyPlace, conflictFields, merge3, placeOfPath, placeValue, readableValue, rebaseOps } from "./concurrent-merge.js"

const term = { id: "G01", term: "SRS", definition: "Software Requirements Specification." }

describe("classifyPlace - bảng 4 trường hợp", () => {
  it("không ai đụng ⇒ unchanged", () => {
    expect(classifyPlace(term, { ...term, definition: "Mới" }, term).kind).toBe("unchanged")
  })

  it("người kia sửa giống đề xuất ⇒ same", () => {
    const mine = { ...term, definition: "Mới" }
    expect(classifyPlace(term, mine, { ...mine }).kind).toBe("same")
  })

  it("người kia sửa phần khác cùng chỗ ⇒ rebased, giữ cả hai", () => {
    const out = classifyPlace(term, { ...term, definition: "Mới" }, { ...term, term: "Đặc tả" })
    expect(out).toEqual({ kind: "rebased", value: { id: "G01", term: "Đặc tả", definition: "Mới" } })
  })

  it("người kia sửa đúng chữ đề xuất định đổi ⇒ conflict, chỉ ra field", () => {
    const out = classifyPlace(term, { ...term, definition: "Của tôi" }, { ...term, definition: "Của Bình" })
    expect(out).toEqual({ kind: "conflict", at: ["definition"] })
  })

  it("đề xuất xoá phần tử mà người kia vừa sửa ⇒ conflict; người kia cũng xoá ⇒ same", () => {
    expect(classifyPlace(term, undefined, { ...term, definition: "Của Bình" }).kind).toBe("conflict")
    expect(classifyPlace(term, undefined, undefined).kind).toBe("same")
  })
})

describe("merge3 - mảng", () => {
  it("mảng chuỗi cùng độ dài: dòng khác nhau ⇒ ghép theo vị trí; cùng dòng ⇒ đụng goals[0]", () => {
    expect(merge3({ goals: ["a", "b"] }, { goals: ["A", "b"] }, { goals: ["a", "B"] })).toEqual({ ok: true, value: { goals: ["A", "B"] } })
    const clash = merge3({ goals: ["a", "b"] }, { goals: ["A", "b"] }, { goals: ["X", "b"] })
    expect(clash).toEqual({ ok: false, at: ["goals[0]"] })
    expect(conflictFields(clash.ok ? [] : clash.at)).toEqual(["goals"])
  })

  it("mảng phần tử có id: ghép theo id (người kia thêm dòng, mình sửa dòng khác)", () => {
    const base = { normal: [{ id: "n1", text: "a" }, { id: "n2", text: "b" }] }
    const mine = { normal: [{ id: "n1", text: "A" }, { id: "n2", text: "b" }] }
    const theirs = { normal: [{ id: "n1", text: "a" }, { id: "n2", text: "b" }, { id: "n3", text: "c" }] }
    expect(merge3(base, mine, theirs)).toEqual({ ok: true, value: { normal: [{ id: "n1", text: "A" }, { id: "n2", text: "b" }, { id: "n3", text: "c" }] } })
  })
})

describe("chỗ của lô op", () => {
  it("placeOfPath: phần tử theo id / project; id tạm $new và khoá ghép ⇒ null", () => {
    expect(placeOfPath("glossary[id=G01].definition")).toBe("glossary[id=G01]")
    expect(placeOfPath("project.goals")).toBe("project")
    expect(placeOfPath("functions[id=$newFn].name")).toBeNull()
    expect(placeOfPath("permissions[screen_id=S1,role_id=R1,action=view]")).toBeNull()
    expect(placeValue({ glossary: [term] }, "glossary[id=G01]")).toEqual(term)
  })

  it("rebaseOps: same ⇒ bỏ op, rebased ⇒ set từng field lệch, unchanged ⇒ giữ", () => {
    const current = { glossary: [{ ...term, term: "Đặc tả" }], actors: [{ id: "A01", name: "Founder" }] }
    const ops = [
      { op: "set", path: "glossary[id=G01].definition", value: "Mới", reason: "r" },
      { op: "set", path: "actors[id=A01].name", value: "Owner" },
      { op: "set", path: "messages[id=M1].text", value: "x" }
    ]
    const out = rebaseOps(
      ops,
      current,
      new Map([
        ["glossary[id=G01]", { kind: "rebased", value: { id: "G01", term: "Đặc tả", definition: "Mới" } }],
        ["actors[id=A01]", { kind: "same" }]
      ] as const)
    )
    expect(out).toEqual([
      { op: "set", path: "glossary[id=G01].definition", value: "Mới", reason: "r" },
      { op: "set", path: "messages[id=M1].text", value: "x" }
    ])
  })

  it("readableValue: chuỗi giữ nguyên, mảng chuỗi mỗi dòng một ý", () => {
    expect(readableValue("abc")).toBe("abc")
    expect(readableValue(["a", "b"])).toBe("- a\n- b")
  })
})
