import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { runDeterministicCheck } from "../spine/deterministic-check.js"
import { PROJECT_TEXT_FIELDS, SRS_TEXT_FIELDS } from "../spine/srs-text-fields.js"
import { renderKind } from "../diagram/renderers/index.js"
import {
  DIAGRAM_TEXT_FIELDS,
  fitTranslation,
  hashSource,
  readUnitField,
  translatableValue,
  translationUnits,
  unitsOfValue,
  writeUnitField,
  type TranslationUnit
} from "./translation-units.js"

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

/** N1: chữ chỉ vẽ lên sơ đồ — mũi tên sơ đồ ngữ cảnh, động từ ERD, nhãn wireframe. */
const isDiagramOnly = (u: TranslationUnit): boolean =>
  u.ref.group === "diagrams" || (u.ref.group !== "project" && (DIAGRAM_TEXT_FIELDS[u.ref.group] ?? []).includes(u.ref.field))

describe("translationUnits — bảng §2.1 trên fixture 19 màn", () => {
  it("khoá theo id, không trùng key, đủ mọi nhóm của bảng", () => {
    expect(new Set(UNITS.map((u) => u.key)).size).toBe(UNITS.length)
    // N1: + nhãn wireframe (`diagrams`) — fixture có một wireframe salt (D05)
    expect(new Set(UNITS.map((u) => u.ref.group))).toEqual(new Set(["project", ...Object.keys(SRS_TEXT_FIELDS), "diagrams"]))
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

  it("không có id, mã, enum, addendum, assumptions, *_vi; sơ đồ chỉ có nhãn wireframe", () => {
    const fields = new Set(UNITS.map((u) => u.ref.field))
    for (const banned of ["id", "kind", "priority", "category", "tier", "code", "statement_vi", "term_native", "name_vi", "puml"]) {
      expect(fields.has(banned), banned).toBe(false)
    }
    expect(UNITS.some((u) => /^(addendum|assumptions|custom_sections|permissions)/.test(u.key))).toBe(false)
    expect(UNITS.filter((u) => u.ref.group === "diagrams").every((u) => /^diagrams\[id=[^\]]+\]\.labels$/.test(u.key))).toBe(true)
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
    // Một đơn vị đại diện cho mỗi (nhóm, field) — chạy luật trên cả fixture cho mọi đơn vị thì quá chậm. Chữ chỉ vẽ lên
    // sơ đồ (N1) không thuộc danh sách dùng chung — test riêng bên dưới
    const samples = new Map<string, TranslationUnit>()
    for (const u of UNITS.filter((x) => !isDiagramOnly(x))) {
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

  it("N1: chữ chỉ vẽ lên sơ đồ là đơn vị dịch nhưng luật không quét (phạm vi luật giữ nguyên)", () => {
    const spine = variant((s) => {
      s.entities[0].relation_verbs = { E02: "contains" }
      s.entities[0].attributes = [{ name: "email", kind: "key", required: true }]
    })
    const units = translationUnits(spine).filter(isDiagramOnly)
    expect(new Set(units.map((u) => `${u.ref.group}.${u.ref.field}`))).toEqual(
      new Set(["actors.flows_in", "actors.flows_out", "entities.relation_verbs", "entities.attributes", "screens.flow_to", "diagrams.labels"])
    )
    const before = new Set(nonEnglish(spine))
    const withVietnamese = variant((s) => {
      s.actors[0].flows_in = ["Người dùng đăng nhập"]
      s.actors[0].flows_out = ["Kết quả đăng nhập"]
    })
    expect(nonEnglish(withVietnamese).filter((m) => !before.has(m))).toEqual([])
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

describe("N1 — chữ trên sơ đồ: mũi tên, động từ ERD, nhãn wireframe", () => {
  const A = FIXTURE.actors[0]
  const E = FIXTURE.entities[0]

  it("flows_in / flows_out là đơn vị mảng của actor; relation_verbs là mảng động từ theo id đích đã sắp", () => {
    expect(unit(`actors[id=${A.id}].flows_in`)).toMatchObject({ value: A.flows_in, ref: { group: "actors", id: A.id, field: "flows_in" } })
    const units = translationUnits(variant((s) => (s.entities[0].relation_verbs = { E09: "places", E02: "belongs to" })))
    expect(units.find((u) => u.key === `entities[id=${E.id}].relation_verbs`)?.value).toEqual(["belongs to", "places"])
    // Không có động từ ⇒ không có đơn vị (renderer in "has" / nhãn máy)
    expect(unit(`entities[id=${E.id}].relation_verbs`)).toBeUndefined()
  })

  it("attributes là một đơn vị mảng chữ (tên rồi mô tả); ghi lại giữ kind / required", () => {
    const attributes = [
      { name: "email", kind: "key", required: true, description: "Sign-in address" },
      { name: "avatar", kind: "plain", required: false }
    ]
    const units = translationUnits(variant((s) => (s.entities[0].attributes = attributes as never)))
    expect(units.find((u) => u.key === `entities[id=${E.id}].attributes`)?.value).toEqual(["email", "Sign-in address", "avatar"])
    const owner: Record<string, unknown> = { attributes: structuredClone(attributes) }
    expect(readUnitField(owner, "attributes")).toEqual(["email", "Sign-in address", "avatar"])
    writeUnitField(owner, "attributes", ["thư điện tử", "Địa chỉ đăng nhập", "ảnh đại diện"])
    expect(owner.attributes).toEqual([
      { name: "thư điện tử", kind: "key", required: true, description: "Địa chỉ đăng nhập" },
      { name: "ảnh đại diện", kind: "plain", required: false }
    ])
  })

  it("đọc / ghi field bảng giữ khoá, thay chữ theo thứ tự khoá đã sắp", () => {
    const owner: Record<string, unknown> = { relation_verbs: { E09: "places", E02: "belongs to" }, flows_in: ["order"] }
    expect(readUnitField(owner, "relation_verbs")).toEqual(["belongs to", "places"])
    writeUnitField(owner, "relation_verbs", ["thuộc về", "đặt"])
    expect(owner.relation_verbs).toEqual({ E02: "thuộc về", E09: "đặt" })
    writeUnitField(owner, "flows_in", ["đơn hàng"])
    expect(owner.flows_in).toEqual(["đơn hàng"])
    expect(readUnitField({ relation_verbs: {} }, "relation_verbs")).toBeNull()
  })

  it("nhãn wireframe: một đơn vị mảng mỗi hình screen_layout đã vẽ; bảng function / hình lỗi / hình khác ⇒ không có", () => {
    const wireframe = FIXTURE.diagrams.find((d) => d.kind === "screen_layout")!
    const labels = unit(`diagrams[id=${wireframe.id}].labels`)
    expect(labels?.ref).toEqual({ group: "diagrams", id: wireframe.id, field: "labels" })
    expect(labels?.value).toEqual(expect.arrayContaining(["Chat", "Document", "Accept", "Type a message..."]))
    // Tên hệ thống / tên dự án không dịch
    expect(labels?.value).not.toContain("FlintFlow")

    const table = renderKind(FIXTURE, "screen_layout", wireframe.owner_id)[0]
    const withTable = translationUnits(variant((s) => (s.diagrams.find((d) => d.id === wireframe.id)!.source = table.source)))
    expect(withTable.some((u) => u.ref.group === "diagrams")).toBe(false)
    const errored = translationUnits(variant((s) => (s.diagrams.find((d) => d.id === wireframe.id)!.render_status = "error")))
    expect(errored.some((u) => u.ref.group === "diagrams")).toBe(false)
  })

  it("unitsOfValue: op actor / entity cả object ghép mũi tên và động từ (bản dịch lệch thứ tự khoá vẫn đúng chỗ)", () => {
    const en = { id: "E01", name: "Order", description: "A purchase", relations: ["E02", "E09"], relation_verbs: { E09: "places", E02: "belongs to" } }
    const loc = { id: "E01", name: "Đơn hàng", description: "Một lần mua", relation_verbs: { E02: "thuộc về", E09: "đặt" } }
    const pairs = unitsOfValue("entities[]", [en], [loc])
    expect(pairs.find((p) => p.key === "entities[id=E01].relation_verbs")).toMatchObject({
      source: ["belongs to", "places"],
      text: ["thuộc về", "đặt"],
      sourceHash: hashSource(["belongs to", "places"])
    })
    // Thiếu một động từ ⇒ bỏ đơn vị đó, phần còn lại vẫn ghép
    const partial = unitsOfValue("entities[id=E01]", en, { ...loc, relation_verbs: { E02: "thuộc về" } })
    expect(partial.map((p) => p.key)).toEqual(["entities[id=E01].name", "entities[id=E01].description"])

    expect(unitsOfValue("entities[id=E01].relation_verbs", en.relation_verbs, loc.relation_verbs)).toEqual([
      { key: "entities[id=E01].relation_verbs", sourceHash: hashSource(["belongs to", "places"]), source: ["belongs to", "places"], text: ["thuộc về", "đặt"] }
    ])
    expect(unitsOfValue(`actors[id=${A.id}].flows_out`, ["order status"], ["trạng thái đơn"])).toEqual([
      { key: `actors[id=${A.id}].flows_out`, sourceHash: hashSource(["order status"]), source: ["order status"], text: ["trạng thái đơn"] }
    ])
    const actor = { id: "A09", name: "Payment Gateway", description: "Takes payments", kind: "system", flows_in: ["payment result"], flows_out: ["payment request"] }
    const actorPairs = unitsOfValue("actors[]", [actor], [{ id: "A09", name: "Cổng thanh toán", description: "Nhận thanh toán", flows_in: ["kết quả thanh toán"], flows_out: ["yêu cầu thanh toán"] }])
    expect(actorPairs.map((p) => p.key)).toEqual(["actors[id=A09].name", "actors[id=A09].description", "actors[id=A09].flows_in", "actors[id=A09].flows_out"])
  })
})

describe("nhãn cạnh luồng màn (flow_to trigger / guard)", () => {
  const edges = [
    { to: "S03", trigger: "Click Forgot password" },
    { to: "S02", trigger: "Submit", guard: "OTP valid" },
    { to: "S04" }
  ]

  it("đơn vị là mảng chữ theo thứ tự `to`: trigger rồi guard của từng cạnh; cạnh trơn không có chữ", () => {
    const screens = [{ id: "S01", name: "Login", description: "", flow_to: edges }] as unknown as Spine["screens"]
    const [unit] = translationUnits({ screens }).filter((u) => u.ref.field === "flow_to")
    expect(unit.value).toEqual(["Submit", "OTP valid", "Click Forgot password"])
  })

  it("ghi chữ dịch lại đúng trigger / guard, giữ thứ tự và `to` của cạnh", () => {
    const owner: Record<string, unknown> = { flow_to: structuredClone(edges) }
    writeUnitField(owner, "flow_to", ["Gửi", "OTP hợp lệ", "Bấm Quên mật khẩu"])
    expect(owner.flow_to).toEqual([
      { to: "S03", trigger: "Bấm Quên mật khẩu" },
      { to: "S02", trigger: "Gửi", guard: "OTP hợp lệ" },
      { to: "S04" }
    ])
  })
})
