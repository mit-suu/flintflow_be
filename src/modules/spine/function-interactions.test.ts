import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { planTransaction } from "./op-engine.js"
import { resolve, selectorFor } from "./path-resolver.js"
import { findDeadReferences } from "./reference-fields.js"
import { renderedDiagramHash } from "./source-hash.js"
import { spineSchema } from "./spine.schema.js"
import type { FunctionInteraction, Spine, SpineFunction } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const txn = (ops: unknown[]) => ({ ops, by: "u", txn: "t" }) as unknown as Parameters<typeof planTransaction>[1]
const plan = (ops: unknown[], spine: Spine = FIXTURE) => planTransaction(spine, txn(ops), { startSeq: 1 })
const fnOf = (spine: Spine, id: string): SpineFunction => spine.functions.find((f) => f.id === id)!
const KEY = "functions[id=FN010].interactions[from=A01,to=system,message=Submit email address,kind=request,flow=normal]"
const reply: FunctionInteraction = { from: "system", to: "A01", message: "Show quota notice", kind: "response", flow: "abnormal", guard: "quota is used up" }

describe("functions[].interactions — schema", () => {
  it("fixture có interactions cho vài function; Spine cũ thiếu field vẫn hợp lệ", () => {
    expect(fnOf(FIXTURE, "FN001").interactions).toHaveLength(4)
    const old = structuredClone(FIXTURE) as unknown as { functions: Record<string, unknown>[] }
    for (const f of old.functions) delete f.interactions
    expect(fnOf(spineSchema.parse(old), "FN001").interactions).toBeUndefined()
  })

  it("strict: key lạ, kind / flow sai, message rỗng hoặc chứa , [ ] bị từ chối", () => {
    const bad = (patch: (i: Record<string, unknown>) => void) => {
      const s = structuredClone(FIXTURE) as unknown as { functions: { interactions: Record<string, unknown>[] }[] }
      patch(s.functions[0].interactions[0])
      return spineSchema.safeParse(s).success
    }
    expect(bad(() => undefined)).toBe(true)
    expect(bad((i) => (i.note = "x"))).toBe(false)
    expect(bad((i) => (i.kind = "signal"))).toBe(false)
    expect(bad((i) => (i.flow = "error"))).toBe(false)
    expect(bad((i) => (i.message = "  "))).toBe(false)
    for (const message of ["a, b", "a [b]", "a]"]) expect(bad((i) => (i.message = message)), message).toBe(false)
  })

  it("diagrams[].kind nhận sequence", () => {
    const s = structuredClone(FIXTURE)
    s.diagrams = [{ id: "D99", kind: "sequence", format: "puml", source: "@startuml\n@enduml\n", section: "function:FN001", owner_kind: "function", owner_id: "FN001", render_status: "ok", source_hash: "x", rendered_at: null }]
    expect(spineSchema.safeParse(s).success).toBe(true)
  })
})

describe("op engine — interactions", () => {
  it("selectorFor: message chọn theo from + to + message + kind + flow (không rơi vào khoá `to` của flow_to)", () => {
    const i = fnOf(FIXTURE, "FN010").interactions![0]
    expect(selectorFor(i)).toEqual({ kind: "match", pairs: [["from", "A01"], ["to", "system"], ["message", "Submit email address"], ["kind", "request"], ["flow", "normal"]] })
    expect(resolve(FIXTURE, KEY)).toMatchObject({ kind: "element", value: { message: "Submit email address" } })
  })

  it("sửa guard qua path; không đổi được khoá", () => {
    const next = plan([{ op: "set", path: `${KEY}.guard`, value: "email is registered" }]).spine
    expect(fnOf(next, "FN010").interactions![0].guard).toBe("email is registered")
    expect(() => plan([{ op: "set", path: `${KEY}.message`, value: "other" }])).toThrow()
  })

  it("add vào function thiếu mảng tạo [] trước; message trùng khoá bị từ chối", () => {
    const next = plan([{ op: "add", path: "functions[id=FN002].interactions[]", value: reply }]).spine
    expect(fnOf(next, "FN002").interactions).toEqual([reply])
    expect(() => plan([{ op: "add", path: "functions[id=FN001].interactions[]", value: fnOf(FIXTURE, "FN001").interactions![0] }])).toThrow()
  })

  it("set cả mảng thay toàn bộ, giữ thứ tự; hai message cùng khoá giữ cái đầu", () => {
    const first = fnOf(FIXTURE, "FN001").interactions![0]
    const next = plan([{ op: "set", path: "functions[id=FN002].interactions", value: [first, reply, { ...reply, guard: "other guard" }] }]).spine
    expect(fnOf(next, "FN002").interactions).toEqual([first, reply])
  })

  it("xoá message theo khoá", () => {
    const next = plan([{ op: "remove", path: KEY }]).spine
    expect(fnOf(next, "FN010").interactions!.map((i) => i.message)).toEqual(["Send password reset link", "Confirm reset email sent"])
  })
})

describe("cascade và tham chiếu", () => {
  it("đầu `system` không phải tham chiếu; id actor chết ⇒ dead reference", () => {
    expect(findDeadReferences(FIXTURE)).toEqual([])
    const broken = structuredClone(FIXTURE)
    fnOf(broken, "FN001").interactions![0].from = "A77"
    expect(findDeadReferences(broken).map((h) => h.refPath)).toEqual([
      "functions[id=FN001].interactions[from=A77,to=system,message=Submit email and password,kind=request,flow=normal].from"
    ])
  })

  it("xoá actor ⇒ gỡ các message có from / to là actor đó, message khác còn nguyên", () => {
    const result = plan([{ op: "remove", path: "actors[id=A08]" }])
    expect(fnOf(result.spine, "FN010").interactions!.map((i) => i.message)).toEqual(["Submit email address", "Confirm reset email sent"])
    expect(fnOf(result.spine, "FN084").interactions!.map((i) => i.message)).toEqual(["Trigger monthly quota reset"])
    expect(fnOf(result.spine, "FN001").interactions).toHaveLength(4)
    expect(findDeadReferences(result.spine)).toEqual([])
  })
})

describe("source_hash của sơ đồ tuần tự", () => {
  const hash = (spine: Spine, id = "FN001") => renderedDiagramHash(spine, { kind: "sequence", owner_id: id })
  const edit = (fn: (s: Spine) => void): Spine => {
    const s = structuredClone(FIXTURE)
    fn(s)
    return s
  }

  it("đổi message, guard, thứ tự, tên actor ở đầu message hoặc tên function ⇒ hình cũ", () => {
    const base = hash(FIXTURE)
    expect(hash(edit((s) => (fnOf(s, "FN001").interactions![0].message = "Submit login")))).not.toBe(base)
    expect(hash(edit((s) => (fnOf(s, "FN001").interactions![1].guard = "wrong password")))).not.toBe(base)
    expect(hash(edit((s) => fnOf(s, "FN001").interactions!.reverse()))).not.toBe(base)
    expect(hash(edit((s) => (s.actors.find((a) => a.id === "A01")!.name = "Owner")))).not.toBe(base)
    expect(hash(edit((s) => (fnOf(s, "FN001").name = "Sign In")))).not.toBe(base)
  })

  it("đổi mô tả, luồng chữ, tên actor không tham gia hoặc function khác ⇒ hash giữ nguyên", () => {
    const base = hash(FIXTURE)
    expect(hash(edit((s) => (fnOf(s, "FN001").description = "other")))).toBe(base)
    expect(hash(edit((s) => fnOf(s, "FN001").normal.push("another step")))).toBe(base)
    expect(hash(edit((s) => (s.actors.find((a) => a.id === "A09")!.name = "Cron")))).toBe(base)
    expect(hash(edit((s) => fnOf(s, "FN010").interactions!.pop()))).toBe(base)
  })
})
