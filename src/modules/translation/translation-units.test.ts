import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { runDeterministicCheck } from "../spine/deterministic-check.js"
import { PROJECT_TEXT_FIELDS, SRS_TEXT_FIELDS } from "../spine/srs-text-fields.js"
import { fitTranslation, hashSource, translatableValue, translationUnits, unitsOfValue, type TranslationUnit } from "./translation-units.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const variant = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}

const UNITS = translationUnits(FIXTURE)
const unit = (key: string): TranslationUnit | undefined => UNITS.find((u) => u.key === key)

describe("translationUnits — bảng §2.1 trên fixture 19 màn", () => {
  it("khoá theo id, không trùng key, đủ mọi nhóm của bảng", () => {
    expect(new Set(UNITS.map((u) => u.key)).size).toBe(UNITS.length)
    expect(new Set(UNITS.map((u) => u.ref.group))).toEqual(new Set(["project", ...Object.keys(SRS_TEXT_FIELDS)]))
    for (const u of UNITS) {
      if (u.ref.group === "project") expect(u.key).toMatch(/^project\.(vision|goals|release_scope\.(in|out))$/)
      else expect(u.key).toMatch(/^[a-z_]+\[id=[^\]]+\]\.(validations\[id=[^\]]+\]\.)?[a-z_]+$/)
    }
    const fn = FIXTURE.functions[0]
    expect(unit(`functions[id=${fn.id}].normal`)).toMatchObject({ value: fn.normal, ref: { group: "functions", id: fn.id, field: "normal" } })
    expect(unit(`functions[id=${fn.id}].validations[id=${fn.validations[0].id}].statement`)).toMatchObject({
      value: fn.validations[0].statement,
      ref: { group: "functions", id: fn.id, field: "statement", validation_id: fn.validations[0].id }
    })
    expect(unit("project.release_scope.in")?.value).toEqual(FIXTURE.project.release_scope.in)
    expect(unit("project.goals")?.value).toEqual(FIXTURE.project.goals)
  })

  it("không có id, mã, enum, relation_verbs, addendum, assumptions, *_vi", () => {
    const fields = new Set(UNITS.map((u) => u.ref.field))
    for (const banned of ["id", "kind", "priority", "category", "tier", "code", "relation_verbs", "statement_vi", "term_native", "name_vi"]) {
      expect(fields.has(banned), banned).toBe(false)
    }
    expect(UNITS.some((u) => /^(addendum|assumptions|custom_sections|diagrams|permissions)/.test(u.key))).toBe(false)
    expect(unit("project.name")).toBeUndefined()
    expect(unit("project.system_name")).toBeUndefined()
  })

  it("giá trị rỗng / không có chữ cái ⇒ không phải đơn vị", () => {
    expect(translatableValue("")).toBeNull()
    expect(translatableValue("200 ms")).toBe("200 ms")
    expect(translatableValue("≤ 2")).toBeNull()
    expect(translatableValue([])).toBeNull()
    expect(translatableValue(null)).toBeNull()
    const units = translationUnits(variant((s) => {
      s.project.vision = null
      s.screens[0].tabs = []
    }))
    expect(units.find((u) => u.key === "project.vision")).toBeUndefined()
    expect(units.find((u) => u.key === `screens[id=${FIXTURE.screens[0].id}].tabs`)).toBeUndefined()
  })

  it("sửa description không đổi hash của name; hash bền khi đảo thứ tự key", () => {
    const a = FIXTURE.actors[0]
    const edited = translationUnits(variant((s) => (s.actors[0].description = "Something else entirely")))
    const nameKey = `actors[id=${a.id}].name`
    const descKey = `actors[id=${a.id}].description`
    const hashOf = (units: TranslationUnit[], key: string) => hashSource(units.find((u) => u.key === key)!.value)
    expect(hashOf(edited, nameKey)).toBe(hashOf(UNITS, nameKey))
    expect(hashOf(edited, descKey)).not.toBe(hashOf(UNITS, descKey))

    expect(hashSource({ a: 1, b: ["x"] })).toBe(hashSource({ b: ["x"], a: 1 }))
    expect(hashSource("Log in")).toHaveLength(16)
    expect(hashSource(["a", "b"])).not.toBe(hashSource(["b", "a"]))
  })

  it("chữ giống nhau ở hai chỗ ⇒ cùng hash (dùng chung bản dịch)", () => {
    const hashes = new Map<string, number>()
    for (const u of UNITS) hashes.set(hashSource(u.value), (hashes.get(hashSource(u.value)) ?? 0) + 1)
    expect(hashes.size).toBeLessThan(UNITS.length)
    expect([...hashes.values()].some((n) => n > 1)).toBe(true)
  })
})

describe("danh sách field trùng phạm vi non_english_content", () => {
  const vietnameseAt = (s: Spine, u: TranslationUnit) => {
    const vi = Array.isArray(u.value) ? u.value.map(() => "Người dùng đăng nhập") : "Người dùng đăng nhập"
    if (u.ref.group === "project") {
      const [field, sub] = u.ref.field.split(".") as [string, string | undefined]
      const project = s.project as unknown as Record<string, Record<string, unknown>>
      if (sub) project[field][sub] = vi
      else (s.project as unknown as Record<string, unknown>)[field] = vi
      return
    }
    const element = (s[u.ref.group] as unknown as Record<string, unknown>[]).find((e) => e.id === u.ref.id)!
    if (u.ref.validation_id) {
      const validation = (element.validations as Record<string, unknown>[]).find((v) => v.id === u.ref.validation_id)!
      validation[u.ref.field] = vi
    } else element[u.ref.field] = vi
  }
  const nonEnglish = (s: Spine) => runDeterministicCheck(s).filter((f) => f.rule_id === "non_english_content").map((f) => f.message)

  it("mỗi loại đơn vị (nhóm × field) chèn tiếng Việt ⇒ luật bắt được", () => {
    // Một đơn vị đại diện cho mỗi (nhóm, field) — chạy luật trên cả fixture cho mọi đơn vị thì quá chậm
    const samples = new Map<string, TranslationUnit>()
    for (const u of UNITS) {
      const kind = `${u.ref.group}.${u.ref.validation_id ? "validations." : ""}${u.ref.field}`
      if (!samples.has(kind)) samples.set(kind, u)
    }
    const before = new Set(nonEnglish(FIXTURE))
    for (const [kind, u] of samples) {
      const after = nonEnglish(variant((s) => vietnameseAt(s, u)))
      expect(after.some((m) => !before.has(m)), kind).toBe(true)
    }
    // Mọi field của danh sách dùng chung đều có mặt trong fixture (không có nhóm nào kiểm "chay")
    const expected = [
      ...PROJECT_TEXT_FIELDS.flatMap((f) => (f === "release_scope" ? ["project.release_scope.in", "project.release_scope.out"] : [`project.${f}`])),
      ...Object.entries(SRS_TEXT_FIELDS).flatMap(([group, fields]) => fields.map((f) => `${group}.${f}`)),
      "functions.validations.statement"
    ]
    expect([...samples.keys()].sort()).toEqual(expected.sort())
  })
})

describe("unitsOfValue — cặp (hash câu Anh, câu dịch) của một op", () => {
  const fn = FIXTURE.functions[0]

  it("add functions[] cả object ⇒ mọi field chữ + validation lồng theo id", () => {
    const localized = {
      ...fn,
      name: "Gửi thông tin đăng nhập",
      trigger: "Người dùng bấm nút Đăng nhập.",
      description: "Xác thực người dùng.",
      normal: fn.normal.map((s, i) => `Bước ${i + 1}`),
      abnormal: ["Sai thông tin: báo lỗi."],
      validations: [...fn.validations].reverse().map((v) => ({ ...v, statement: `Kiểm ${v.id}` }))
    }
    const pairs = unitsOfValue("functions[]", fn, localized)
    expect(pairs.map((p) => p.key).sort()).toEqual(
      [
        `functions[id=${fn.id}].name`,
        `functions[id=${fn.id}].trigger`,
        `functions[id=${fn.id}].description`,
        `functions[id=${fn.id}].normal`,
        `functions[id=${fn.id}].abnormal`,
        ...fn.validations.map((v) => `functions[id=${fn.id}].validations[id=${v.id}].statement`)
      ].sort()
    )
    expect(pairs.find((p) => p.key.endsWith(".name"))).toMatchObject({ sourceHash: hashSource(fn.name), text: "Gửi thông tin đăng nhập", source: fn.name })
    // Ghép validation theo id, không theo vị trí
    const v0 = pairs.find((p) => p.key.includes(fn.validations[0].id))
    expect(v0).toMatchObject({ sourceHash: hashSource(fn.validations[0].statement), text: `Kiểm ${fn.validations[0].id}` })
  })

  it("set functions[id=FN].normal ⇒ một đơn vị mảng; khác độ dài ⇒ bỏ", () => {
    const vi = fn.normal.map((_, i) => `Bước ${i + 1}`)
    expect(unitsOfValue(`functions[id=${fn.id}].normal`, fn.normal, vi)).toEqual([
      { key: `functions[id=${fn.id}].normal`, sourceHash: hashSource(fn.normal), source: fn.normal, text: vi }
    ])
    expect(unitsOfValue(`functions[id=${fn.id}].normal`, fn.normal, vi.slice(1))).toEqual([])
    expect(unitsOfValue(`functions[id=${fn.id}].normal`, fn.normal, "một chuỗi")).toEqual([])
    // Mảng toàn chuỗi rỗng / trắng cùng độ dài ⇒ rác, bỏ
    expect(unitsOfValue(`functions[id=${fn.id}].normal`, fn.normal, fn.normal.map(() => ""))).toEqual([])
    expect(unitsOfValue(`functions[id=${fn.id}].normal`, fn.normal, fn.normal.map(() => "  "))).toEqual([])
  })

  it("fitTranslation: trim; phần tử gốc có chữ không được dịch thành rỗng; phần tử gốc rỗng được giữ rỗng", () => {
    expect(fitTranslation("Log in", "  Đăng nhập ")).toBe("Đăng nhập")
    expect(fitTranslation("Log in", "   ")).toBeNull()
    expect(fitTranslation("Log in", ["Đăng nhập"])).toBeNull()
    expect(fitTranslation(["A step.", "B step."], [" Bước A. ", "Bước B."])).toEqual(["Bước A.", "Bước B."])
    expect(fitTranslation(["A step.", "B step."], ["", ""])).toBeNull()
    expect(fitTranslation(["A step.", "B step."], ["Bước A.", " "])).toBeNull()
    expect(fitTranslation(["A step.", ""], ["Bước A.", ""])).toEqual(["Bước A.", ""])
    expect(fitTranslation(["A step."], ["Bước A.", "thừa"])).toBeNull()
    expect(fitTranslation(["A step."], [1])).toBeNull()
  })

  it("validation: add validations[], set validations[id=V].statement, set cả validation", () => {
    const v = fn.validations[1]
    expect(unitsOfValue(`functions[id=${fn.id}].validations[]`, v, { ...v, statement: "Mật khẩu không được rỗng." })).toMatchObject([
      { key: `functions[id=${fn.id}].validations[id=${v.id}].statement`, text: "Mật khẩu không được rỗng." }
    ])
    expect(unitsOfValue(`functions[id=${fn.id}].validations[id=${v.id}].statement`, v.statement, "Mật khẩu bắt buộc.")).toMatchObject([
      { sourceHash: hashSource(v.statement), text: "Mật khẩu bắt buộc." }
    ])
    expect(unitsOfValue(`functions[id=${fn.id}].validations[id=${v.id}]`, { kind: v.kind, statement: v.statement }, { statement: "Bắt buộc." })).toMatchObject([
      { key: `functions[id=${fn.id}].validations[id=${v.id}].statement`, text: "Bắt buộc." }
    ])
    expect(unitsOfValue(`functions[id=${fn.id}].validations[id=${v.id}].kind`, "required", "bắt buộc")).toEqual([])
  })

  it("project: field, release_scope cả object, release_scope.in", () => {
    const rs = FIXTURE.project.release_scope
    const viRs = { in: rs.in.map(() => "trong"), out: rs.out.map(() => "ngoài") }
    expect(unitsOfValue("project.vision", "Make SRS fast", "Làm SRS nhanh")).toMatchObject([{ key: "project.vision", text: "Làm SRS nhanh" }])
    expect(unitsOfValue("project.release_scope", rs, viRs).map((p) => p.key)).toEqual(["project.release_scope.in", "project.release_scope.out"])
    expect(unitsOfValue("project.release_scope.in", rs.in, viRs.in)).toMatchObject([{ key: "project.release_scope.in", text: viRs.in }])
    expect(unitsOfValue("project.name", "Lumen", "Lumen vi")).toEqual([])
  })

  it("set phần tử theo id, mảng phần tử ghép theo id; id lệch ⇒ bỏ", () => {
    const [a, b] = FIXTURE.actors
    expect(unitsOfValue(`actors[id=${a.id}]`, { name: a.name, description: a.description }, { name: "Khách", description: "Mô tả" }).map((p) => p.key)).toEqual([
      `actors[id=${a.id}].name`,
      `actors[id=${a.id}].description`
    ])
    expect(unitsOfValue(`actors[id=${a.id}].name`, a.name, "Khách")).toMatchObject([{ text: "Khách" }])
    const pairs = unitsOfValue("actors[]", [a, b], [{ ...b, name: "B vi" }, { ...a, name: "A vi" }])
    expect(pairs.find((p) => p.key === `actors[id=${a.id}].name`)?.text).toBe("A vi")
    expect(unitsOfValue("actors[]", a, { ...a, id: "A99", name: "Khác" })).toEqual([])
  })

  it("op add chưa có id (server cấp — apply-change-op) ⇒ vẫn ra cặp theo vị trí; hash không phụ thuộc id", () => {
    const uc = { name: "Send Reminder", description: "Sends a reminder to the patient." }
    const pairs = unitsOfValue("use_cases[]", uc, { name: "Gửi nhắc", description: "Gửi nhắc cho bệnh nhân." })
    expect(pairs.map((p) => [p.sourceHash, p.text])).toEqual([
      [hashSource(uc.name), "Gửi nhắc"],
      [hashSource(uc.description), "Gửi nhắc cho bệnh nhân."]
    ])
    // Tên actor mới vẫn nhận diện được là tên (glossary NAME_KEY)
    expect(unitsOfValue("actors[]", { name: "Nurse", kind: "human" }, { name: "Y tá" })[0].key).toMatch(/^actors\[id=[^\]]+\]\.name$/)

    // Validation mới không id: add vào validations[], và lồng trong function mới không id
    expect(unitsOfValue(`functions[id=${fn.id}].validations[]`, { statement: "Email must be valid." }, { statement: "Email phải hợp lệ." })).toMatchObject([
      { sourceHash: hashSource("Email must be valid."), text: "Email phải hợp lệ." }
    ])
    const newFn = { name: "Export report", validations: [{ kind: "required", statement: "Date range is required." }, { statement: "End after start." }] }
    const viFn = { name: "Xuất báo cáo", validations: [{ statement: "Khoảng ngày là bắt buộc." }, { statement: "Ngày kết thúc sau ngày bắt đầu." }] }
    expect(unitsOfValue("functions[]", newFn, viFn).map((p) => p.text)).toEqual(["Xuất báo cáo", "Khoảng ngày là bắt buộc.", "Ngày kết thúc sau ngày bắt đầu."])

    // Glossary mới không id
    expect(unitsOfValue("glossary[]", { term: "Reminder", definition: "A message sent before an appointment." }, { definition: "Tin nhắn gửi trước lịch hẹn." }))
      .toMatchObject([{ text: "Tin nhắn gửi trước lịch hẹn." }])
  })

  it("mảng phần tử không id: ghép theo vị trí khi cùng độ dài; khác độ dài / bản dịch tự thêm id ⇒ bỏ", () => {
    const en = [{ name: "Nurse" }, { name: "Doctor" }]
    expect(unitsOfValue("actors[]", en, [{ name: "Y tá" }, { name: "Bác sĩ" }]).map((p) => [p.source, p.text])).toEqual([
      ["Nurse", "Y tá"],
      ["Doctor", "Bác sĩ"]
    ])
    expect(unitsOfValue("actors[]", en, [{ name: "Bác sĩ" }])).toEqual([])
    expect(unitsOfValue("actors[]", en, [{ id: "A01", name: "Y tá" }, { name: "Bác sĩ" }]).map((p) => p.text)).toEqual(["Bác sĩ"])
  })

  it("path lạ, field không phải chữ SRS, selector vô hướng, hình dạng lệch ⇒ rỗng", () => {
    expect(unitsOfValue("không phải path", "x", "y")).toEqual([])
    expect(unitsOfValue("addendum[]", { id: "AD1", content: "x" }, { id: "AD1", content: "y" })).toEqual([])
    expect(unitsOfValue(`screens[id=${FIXTURE.screens[0].id}].tabs[=Main]`, "Main", "Chính")).toEqual([])
    expect(unitsOfValue(`screens[id=${FIXTURE.screens[0].id}].flow_to`, ["S02"], ["S02"])).toEqual([])
    expect(unitsOfValue(`actors[id=${FIXTURE.actors[0].id}].name`, FIXTURE.actors[0].name, ["mảng"])).toEqual([])
    expect(unitsOfValue(`actors[id=${FIXTURE.actors[0].id}].name`, FIXTURE.actors[0].name, "   ")).toEqual([])
    expect(unitsOfValue("permissions[screen_id=S1,role_id=R1,action=view]", {}, {})).toEqual([])
  })
})
