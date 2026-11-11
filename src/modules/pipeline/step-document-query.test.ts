import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { sectionsFedBy } from "./context-projection.js"
import { mergeStepDocumentQueries, stepDocumentQuery } from "./step-document-query.js"

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

  it("step Brief không nuôi section nào ⇒ chỉ có câu hỏi BM25 (nhãn step + câu trả lời của user)", () => {
    const q = queryOf("B-0.1", "AI: Bạn muốn làm gì?\nUser: Ứng dụng đặt lịch khám cho phòng khám nhỏ")
    expect(q.sectionTitles).toEqual([])
    expect(q.query).toContain("Brain Dump")
    expect(q.query).toContain("Ứng dụng đặt lịch khám")
    expect(q.query).not.toContain("Bạn muốn làm gì")
  })

  it("mergeStepDocumentQueries: gộp không lặp", () => {
    const merged = mergeStepDocumentQueries([queryOf("S-3.1"), queryOf("S-3.2"), queryOf("S-3.1")])
    expect(merged.sectionTitles).toEqual(expect.arrayContaining(["Actors", "Use Case Descriptions"]))
    expect(new Set(merged.sectionTitles).size).toBe(merged.sectionTitles.length)
    const lines = merged.query.split("\n")
    expect(new Set(lines).size).toBe(lines.length)
  })
})
