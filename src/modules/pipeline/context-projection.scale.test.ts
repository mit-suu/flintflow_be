import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi } from "vitest"

vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return { ...actual, get: vi.fn() }
})
vi.mock("../project/chat-session.model.js", () => ({ ChatSession: { findById: vi.fn() } }))

import { spineSchema } from "../spine/spine.schema.js"
import type { Addendum, Spine } from "../spine/spine.types.js"
import { isScaleNote, projectStep } from "./context-projection.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const note = (id: string, target_section: string, content: string, content_en = ""): Addendum =>
  ({ id, topic: "Phạm vi bản đầu", target_section, content, content_en, captured_at: "2026-11-17T00:00:00.000Z" }) as Addendum

const withNotes = (...notes: Addendum[]): Spine => {
  const s = structuredClone(FIXTURE)
  s.addendum = [...s.addendum, ...notes]
  return s
}

describe("P13 - S-2.2 thấy giới hạn quy mô user đặt cho bản đầu", () => {
  it("ghi chú quy mô bị gán sang 3.1.2 vẫn tới S-2.2 (đứng trước); ghi chú 3.1.2 không nêu số đứng sau như dữ kiện đã chốt", () => {
    const s = withNotes(
      note("AD900", "fixed:3.1.2", "Bản đầu gọn, khoảng 5-8 use case; chưa làm app mobile"),
      note("AD901", "fixed:3.1.2", "Màn đặt lịch có ô chọn giờ lấy đồ")
    )
    const ids = projectStep(s, "S-2.2").addendum.map((a) => a.id)
    expect(ids.indexOf("AD900")).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf("AD900")).toBeLessThan(ids.indexOf("AD901"))
  })

  it("ghi chú đúng mục fixed:1 vẫn tới S-2.2 đúng một lần", () => {
    const s = withNotes(note("AD900", "fixed:1", "Bản đầu gọn, khoảng 5-8 use case"))
    expect(projectStep(s, "S-2.2").addendum.filter((a) => a.id === "AD900")).toHaveLength(1)
  })

  it("FLF-472: S-6 cũng nhận ghi chú quy mô ở 3.1.2, dưới dạng điều đã chốt (không đứng đầu)", () => {
    const s = withNotes(note("AD900", "fixed:3.1.2", "Bản đầu gọn, khoảng 5-8 use case"))
    expect(projectStep(s, "S-6.1").addendum.map((a) => a.id)).toContain("AD900")
  })

  it("isScaleNote nhận các cách nêu quy mô, bỏ qua con số không phải quy mô", () => {
    for (const content of ["khoảng 5-8 use case", "tối đa 10 màn hình", "5 đến 8 chức năng", "about 8 screens", "12 UC"]) {
      expect(isScaleNote({ content, content_en: "" }), content).toBe(true)
    }
    for (const content of ["giao trong bán kính 5km", "60% đơn tự đặt", "dùng chức năng tìm kiếm"]) {
      expect(isScaleNote({ content, content_en: "" }), content).toBe(false)
    }
    expect(isScaleNote({ content: "bản đầu gọn", content_en: "a lean first release of about 6 use cases" })).toBe(true)
  })
})
