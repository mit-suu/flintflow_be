import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { sectionsFedBy } from "./context-projection.js"
import { FIELD_SEARCH_TERMS, mergeStepDocumentQueries, readFieldKeys, stepDocumentQuery } from "./step-document-query.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const queryOf = (stepId: string, tail = "") => stepDocumentQuery(FIXTURE, stepId, sectionsFedBy(FIXTURE, stepId), tail)

describe("stepDocumentQuery (FLF-393)", () => {
  it("step nuôi section cố định ⇒ mọi tên gọi EN / VI của section đó", () => {
    const q = queryOf("S-3.1")
    expect(q.sectionTitles).toEqual(expect.arrayContaining(["Actors", "Tác nhân"]))
    expect(q.sectionTitles).not.toContain("Glossary")
    expect(q.query).toContain("Actors")
    expect(queryOf("S-6.4").sectionTitles).toEqual(expect.arrayContaining(["Performance", "Hiệu năng"]))
  })

  it("vòng S-5 ⇒ tên function của màn + tên màn", () => {
    const screen = FIXTURE.screens[0]!
    const fn = FIXTURE.functions.find((f) => f.screen_id === screen.id)!
    const q = queryOf(`S-5.2@${screen.id}`)
    expect(q.sectionTitles).toContain(fn.name)
    expect(q.query).toContain(screen.name)
  })

  it("step Brief đọc rộng: ghim mục tổng quan, kèm từ khoá của field cần hỏi (nền tảng, tuân thủ) + câu trả lời của user", () => {
    const q = queryOf("B-0.1", "AI: Bạn muốn làm gì?\nUser: Ứng dụng đặt lịch khám cho phòng khám nhỏ")
    expect(q.broad).toBe(true)
    expect(q.sectionTitles).toEqual(expect.arrayContaining(["Product Overview", "Introduction", "Tổng quan"]))
    expect(q.query).toContain("Brain Dump")
    expect(q.query).toContain(FIELD_SEARCH_TERMS["project.form_factor"])
    expect(q.query).toContain(FIELD_SEARCH_TERMS["project.stakes"])
    expect(q.query).toContain("Ứng dụng đặt lịch khám")
    expect(q.query).not.toContain("Bạn muốn làm gì")
  })

  it("step soạn mục cụ thể không đọc rộng; vẫn có từ khoá theo field nó đọc", () => {
    expect(queryOf("S-3.1").broad).toBe(false)
    expect(queryOf("S-6.4").query).toContain(FIELD_SEARCH_TERMS.nfrs)
  })

  it("readFieldKeys: tách field của project, gốc mảng bỏ bộ lọc / cột", () => {
    expect(readFieldKeys(["project:name,form_factor", "actors[kind!=human]:id,name", "documents", "assumptions[status=unconfirmed]"])).toEqual([
      "project.name",
      "project.form_factor",
      "actors",
      "documents",
      "assumptions"
    ])
    expect(readFieldKeys(["project"])).toEqual(expect.arrayContaining(["project.vision", "project.stakes"]))
  })

  it("mergeStepDocumentQueries: gộp không lặp", () => {
    const merged = mergeStepDocumentQueries([queryOf("S-3.1"), queryOf("S-3.2"), queryOf("S-3.1")])
    expect(merged.sectionTitles).toEqual(expect.arrayContaining(["Actors", "Use Case Descriptions"]))
    expect(new Set(merged.sectionTitles).size).toBe(merged.sectionTitles.length)
    const lines = merged.query.split("\n")
    expect(new Set(lines).size).toBe(lines.length)
  })
})
