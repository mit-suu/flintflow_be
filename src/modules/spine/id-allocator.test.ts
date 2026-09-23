import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import { allocateId, allocatesIds, isPlaceholderId, nextIdIn, substituteDeep, substitutePlaceholders } from "./id-allocator.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

describe("nextIdIn", () => {
  it("nối tiếp số lớn nhất, giữ độ rộng lớn nhất đang dùng", () => {
    expect(nextIdIn(["A01", "A02", "A09"], { prefix: "A", width: 2 })).toBe("A10")
    expect(nextIdIn([], { prefix: "UC", width: 2 })).toBe("UC01")
    expect(nextIdIn(["F1", "F2"], { prefix: "F", width: 1 })).toBe("F3")
  })

  it("BUG-35: FN01..FN04 cũ và FN001.. mới cùng tồn tại ⇒ id mới vẫn là FN<3 chữ số>", () => {
    expect(nextIdIn(["FN01", "FN02", "FN003"], { prefix: "FN", width: 3 })).toBe("FN004")
  })

  it("bỏ qua id không đúng khuôn và không cấp trùng", () => {
    expect(nextIdIn(["UC-REMIND", "UC01"], { prefix: "UC", width: 2 })).toBe("UC02")
  })
})

describe("allocateId", () => {
  it("cấp id kế tiếp theo collection của Spine thật", () => {
    expect(allocateId(FIXTURE, "use_cases")).toBe(`UC${String(FIXTURE.use_cases.length + 1).padStart(2, "0")}`)
    expect(allocateId(FIXTURE, "functions")).toMatch(/^FN\d{3}$/)
    expect(FIXTURE.functions.some((f) => f.id === allocateId(FIXTURE, "functions"))).toBe(false)
  })

  it("validations lấy id theo function cha và duy nhất toàn Spine", () => {
    const fn = FIXTURE.functions.find((f) => f.validations.length > 0)!
    const id = allocateId(FIXTURE, "validations", fn.id)!
    expect(id.startsWith(`${fn.id}-V`)).toBe(true)
    expect(FIXTURE.functions.flatMap((f) => f.validations.map((v) => v.id))).not.toContain(id)
  })

  it("collection không đánh số (steps, sections) ⇒ null", () => {
    expect(allocatesIds("steps")).toBe(false)
    expect(allocateId(FIXTURE, "steps")).toBeNull()
    expect(allocateId(FIXTURE, "validations", null)).toBeNull()
  })
})

describe("id tạm", () => {
  it("nhận đúng dạng $new…, không nhận tiền tệ", () => {
    expect(isPlaceholderId("$new1")).toBe(true)
    expect(isPlaceholderId("$newReminder")).toBe(true)
    expect(isPlaceholderId("$50")).toBe(false)
    expect(isPlaceholderId("UC18")).toBe(false)
  })

  it("thay id tạm trong path và trong giá trị lồng nhau", () => {
    const map = new Map([["$new1", "UC18"]])
    expect(substitutePlaceholders("use_cases[id=$new1].name", map)).toBe("use_cases[id=UC18].name")
    expect(substituteDeep({ path: "use_cases[id=$new1]", ids: ["$new1", "$unknown"] }, map)).toEqual({
      path: "use_cases[id=UC18]",
      ids: ["UC18", "$unknown"]
    })
  })
})
