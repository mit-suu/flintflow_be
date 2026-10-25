import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Op } from "./op.types.js"
import type { Spine } from "./spine.types.js"
import { expandIndexSelectors } from "./index-selector-fix.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const fn = FIXTURE.functions.find((f) => f.normal.length >= 3)!

describe("expandIndexSelectors — op chỉ số trên mảng chuỗi (e2e FAP 21/10: 'Viết lại' chết vì normal[2])", () => {
  it("set một dòng theo chỉ số ⇒ set cả mảng, chỉ đổi đúng vị trí, giữ reason", () => {
    const ops: Op[] = [{ op: "set", path: `functions[id=${fn.id}].normal[2]`, value: "New third step.", reason: "hoà giải" }]
    const expected = [...fn.normal]
    expected[2] = "New third step."
    expect(expandIndexSelectors(FIXTURE, ops)).toEqual([{ op: "set", path: `functions[id=${fn.id}].normal`, value: expected, reason: "hoà giải" }])
  })

  it("nhiều op cùng mảng cộng dồn theo thứ tự; remove theo chỉ số; set ngay sau phần tử cuối ⇒ thêm vào cuối", () => {
    const base = `functions[id=${fn.id}].normal`
    const ops: Op[] = [
      { op: "set", path: `${base}[0]`, value: "First." },
      { op: "remove", path: `${base}[1]` },
      { op: "set", path: `${base}[${fn.normal.length - 1}]`, value: "Appended." }
    ]
    const out = expandIndexSelectors(FIXTURE, ops)
    expect(out).toHaveLength(3)
    const final = out[2].value as string[]
    expect(final[0]).toBe("First.")
    expect(final).toHaveLength(fn.normal.length)
    expect(final[final.length - 1]).toBe("Appended.")
    expect(out.every((o) => o.op === "set" && o.path === base)).toBe(true)
  })

  it("giữ nguyên: op không có chỉ số, mảng object (chọn bằng khoá), chỉ số quá xa, path không phân giải", () => {
    const ops: Op[] = [
      { op: "set", path: `functions[id=${fn.id}].name`, value: "X" },
      { op: "set", path: `functions[id=${fn.id}].validations[0]`, value: {} },
      { op: "set", path: `functions[id=${fn.id}].normal[99]`, value: "far" },
      { op: "set", path: "functions[id=FN999].normal[0]", value: "ghost" }
    ]
    expect(expandIndexSelectors(FIXTURE, ops)).toEqual(ops)
  })
})
