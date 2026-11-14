/**
 * FLF-418: `functions[].component_interactions[]` — message của sơ đồ tuần tự mức thành phần (actor → boundary → control
 * → entity). Kiểm schema, op engine (khoá 5 trường, mảng tuỳ chọn), tham chiếu "lifeline" (actor / màn / entity), cascade
 * và validator của model.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { planTransaction } from "./op-engine.js"
import { findDeadReferences } from "./reference-fields.js"
import { spineSchema } from "./spine.schema.js"
import type { ComponentInteraction, Spine, SpineFunction } from "./spine.types.js"
import { componentInteractionErrors } from "../pipeline/op-validator.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const txn = (ops: unknown[]) => ({ ops, by: "u", txn: "t" }) as unknown as Parameters<typeof planTransaction>[1]
const plan = (ops: unknown[], spine: Spine = FIXTURE) => planTransaction(spine, txn(ops), { startSeq: 1 })
const fnOf = (spine: Spine, id: string): SpineFunction => spine.functions.find((f) => f.id === id)!

/** FN001 "Submit Credentials": màn S01 Login, feature F1 (entity E01 User), actor use case A01. */
const LOGIN: ComponentInteraction[] = [
  { from: "A01", to: "S01", message: "Submit email and password", kind: "request", flow: "normal" },
  { from: "S01", to: "control", message: "Authenticate credentials", kind: "request", flow: "normal" },
  { from: "control", to: "E01", message: "Find user by email", kind: "request", flow: "normal" },
  { from: "E01", to: "control", message: "User record", kind: "response", flow: "normal" },
  { from: "control", to: "S01", message: "Credentials rejected", kind: "response", flow: "abnormal", guard: "credentials do not match" },
  { from: "control", to: "S01", message: "Session created", kind: "response", flow: "normal" },
  { from: "S01", to: "A01", message: "Open project dashboard", kind: "response", flow: "normal" }
]
const withLogin = (list: ComponentInteraction[] = LOGIN): Spine => plan([{ op: "set", path: "functions[id=FN001].component_interactions", value: list }]).spine

describe("component_interactions - schema + op engine", () => {
  it("Spine cũ thiếu field vẫn hợp lệ; set cả mảng qua op", () => {
    expect(fnOf(FIXTURE, "FN001").component_interactions).toBeUndefined()
    expect(fnOf(withLogin(), "FN001").component_interactions).toHaveLength(LOGIN.length)
  })

  it("strict: key lạ / message chứa dấu phẩy bị từ chối", () => {
    expect(() => withLogin([{ ...LOGIN[0], message: "a, b" }])).toThrow()
    expect(() => withLogin([{ ...LOGIN[0], note: "x" } as ComponentInteraction])).toThrow()
  })

  it("add vào mảng chưa có tạo mảng trước; sửa guard qua path 5 khoá", () => {
    const added = plan([{ op: "add", path: "functions[id=FN002].component_interactions[]", value: { from: "A01", to: "S01", message: "Click Google", kind: "request", flow: "normal" } }]).spine
    expect(fnOf(added, "FN002").component_interactions).toHaveLength(1)
    const key = "functions[id=FN001].component_interactions[from=control,to=S01,message=Credentials rejected,kind=response,flow=abnormal]"
    const next = plan([{ op: "set", path: `${key}.guard`, value: "password is wrong" }], withLogin()).spine
    expect(fnOf(next, "FN001").component_interactions![4].guard).toBe("password is wrong")
  })
})

describe("component_interactions - tham chiếu + cascade", () => {
  it("đầu actor / màn / entity còn sống; control không phải tham chiếu", () => {
    expect(findDeadReferences(withLogin()).filter((h) => h.field.path.includes("component_interactions"))).toEqual([])
  })

  it("đầu trỏ id không có ⇒ khoá chết (bất biến 3 từ chối lô)", () => {
    expect(() => withLogin([{ ...LOGIN[0], to: "S999" }])).toThrow()
  })

  it("xoá entity / màn ⇒ xoá message trỏ tới nó, message khác giữ nguyên", () => {
    const base = withLogin()
    const noEntity = plan([{ op: "remove", path: "entities[id=E01]" }], base).spine
    expect(fnOf(noEntity, "FN001").component_interactions!.some((i) => i.from === "E01" || i.to === "E01")).toBe(false)
    expect(fnOf(noEntity, "FN001").component_interactions!.length).toBe(LOGIN.length - 2)
  })
})

describe("componentInteractionErrors (op-validator)", () => {
  const rules = (list: ComponentInteraction[], fnId = "FN001") => {
    const spine = structuredClone(FIXTURE)
    fnOf(spine, fnId).component_interactions = list
    return componentInteractionErrors(spine, [fnId]).map((e) => e.rule)
  }

  it("luồng hợp lệ đủ 4 loại lifeline ⇒ không lỗi", () => {
    expect(rules(LOGIN)).toEqual([])
  })

  it("control tự gọi được; actor tự gọi / actor ↔ entity / đầu lạ / system ⇒ endpoint_invalid", () => {
    expect(rules([LOGIN[0], { from: "control", to: "control", message: "Validate input", kind: "request", flow: "normal" }])).toEqual([])
    expect(rules([LOGIN[0], { from: "A01", to: "E01", message: "Read user", kind: "request", flow: "normal" }])).toContain("component_endpoint_invalid")
    expect(rules([LOGIN[0], { from: "A01", to: "A01", message: "Think", kind: "request", flow: "normal" }])).toContain("component_endpoint_invalid")
    expect(rules([LOGIN[0], { from: "control", to: "system", message: "Call", kind: "request", flow: "normal" }])).toContain("component_endpoint_invalid")
  })

  it("boundary khác màn của function ⇒ boundary_foreign; function không màn có boundary ⇒ boundary_foreign", () => {
    expect(rules([{ ...LOGIN[0], to: "S02" }])).toContain("component_boundary_foreign")
    expect(rules([{ from: "A09", to: "S01", message: "Trigger reset", kind: "request", flow: "normal" }], "FN084")).toContain("component_boundary_foreign")
    expect(rules([{ from: "A09", to: "control", message: "Trigger reset", kind: "request", flow: "normal" }], "FN084")).toEqual([])
  })

  it("entity ngoài feature ⇒ entity_foreign; thiếu guard / trùng khoá / stimulus sai / actor ngoài use case", () => {
    expect(rules([LOGIN[0], LOGIN[1], { from: "control", to: "E02", message: "Load project", kind: "request", flow: "normal" }])).toContain("component_entity_foreign")
    expect(rules([LOGIN[0], { ...LOGIN[4], guard: undefined }])).toContain("component_guard_missing")
    expect(rules([LOGIN[0], LOGIN[1], LOGIN[1]])).toContain("component_duplicate")
    expect(rules([LOGIN[1]])).toContain("component_stimulus_missing")
    expect(rules([{ ...LOGIN[0], from: "A99" }])).toContain("component_endpoint_invalid")
  })
})
