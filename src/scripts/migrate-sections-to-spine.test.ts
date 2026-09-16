import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../modules/spine/spine.repository.js"
import { planTransaction } from "../modules/spine/op-engine.js"
import { spineSchema } from "../modules/spine/spine.schema.js"
import {
  LEGACY_SECTION_TARGETS,
  MIGRATION_REASON,
  buildMigratedSpine,
  buildMigrationTransaction,
  contentToText,
  extractBullets,
  extractGoals,
  parseMarkdownTables,
  parseUseCaseTable,
  renderReport,
  skipReasonOf,
  type LegacySection
} from "./migrate-sections-to-spine.js"

const NOW = new Date("2026-09-16T08:00:00.000Z")

const USE_CASE_TABLE = `## Use cases

| UC ID | Use Case Name | Actor | Description |
|---|---|---|---|
| UC-01 | **Đăng ký tài khoản** | Khách | Tạo tài khoản mới |
| UC-02 | Tạo dự án | Người dùng, Admin | Tạo dự án SRS |
| UC-03 | Xem báo cáo | Admin<br>Người dùng | |
`

const LEGACY: LegacySection[] = [
  { type: "business_goals", content: "Mục tiêu:\n- Giảm 50% thời gian viết SRS\n* **Chuẩn hoá** template FPT\n1. Tăng tỉ lệ chuyển đổi", updatedAt: "2026-01-02T00:00:00.000Z" },
  { type: "vision_problem", content: "FlintFlow giúp founder viết SRS.", status: "accepted" },
  { type: "use_case_spec", content: USE_CASE_TABLE },
  { type: "user_story", content: { content: "As a founder I want…" } },
  { type: "erd", content: { entities: ["User", "Project"] } },
  { type: "glossary", content: "   " },
  { type: "something_new", content: "Nội dung lạ" }
]

describe("chuyển nội dung section cũ", () => {
  it("contentToText nhận chuỗi, {content} và JSON bất kỳ", () => {
    expect(contentToText("  abc \n")).toBe("abc")
    expect(contentToText({ content: " x " })).toBe("x")
    expect(contentToText({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(contentToText(null)).toBe("")
  })

  it("extractBullets chỉ lấy dòng bullet, bỏ markdown inline", () => {
    expect(extractBullets("Mở đầu\n- Một\n  * **Hai**\n3) Ba\nkết")).toEqual(["Một", "Hai", "Ba"])
    expect(extractBullets("Đoạn văn không có bullet")).toEqual([])
  })

  it("parseUseCaseTable đọc id/tên/actor/mô tả, tách nhiều actor", () => {
    expect(parseUseCaseTable(USE_CASE_TABLE)).toEqual([
      { id: "UC-01", name: "Đăng ký tài khoản", actorNames: ["Khách"], description: "Tạo tài khoản mới" },
      { id: "UC-02", name: "Tạo dự án", actorNames: ["Người dùng", "Admin"], description: "Tạo dự án SRS" },
      { id: "UC-03", name: "Xem báo cáo", actorNames: ["Admin", "Người dùng"], description: "" }
    ])
  })

  it("bảng thiếu dòng |---| vẫn đọc được; ô actor kiểu include không thành actor; bảng lặp giữ dòng đầu", () => {
    // Dạng thật trên dữ liệu dev: model cũ viết bảng nháp không có dòng phân cách rồi viết lại bảng
    const text = [
      "| ID | Tên | Actor chính | Mức ưu tiên |",
      "| UC-01 | Tìm kiếm sản phẩm | Khách hàng | Must |",
      "| UC-05 | Thanh toán trực tuyến (include) | - (include từ UC-03, UC-04) | Must |",
      "",
      "| ID | Tên | Actor chính |",
      "|----|-----|-----|",
      "| UC-01 | Tìm kiếm sản phẩm | Khách vãng lai |"
    ].join("\n")
    expect(parseMarkdownTables(text).map((t) => t.rows.length)).toEqual([2, 1])
    expect(parseUseCaseTable(text)).toEqual([
      { id: "UC-01", name: "Tìm kiếm sản phẩm", actorNames: ["Khách hàng"], description: "" },
      { id: "UC-05", name: "Thanh toán trực tuyến (include)", actorNames: [], description: "" }
    ])
  })

  it("extractGoals ưu tiên dòng mã BG-xx (bảng hoặc heading), không có thì lấy bullet", () => {
    const table = "## Mục tiêu\n\n| Mã | Mục tiêu | Mô tả |\n|----|----|----|\n| BG-01 | Mở rộng kênh phân phối | … |\n| BG-02 | **Tạo doanh thu** | … |\n\n- KPI phụ"
    expect(extractGoals(table)).toEqual(["Mở rộng kênh phân phối", "Tạo doanh thu"])
    expect(extractGoals("### BG-01 — Thiết lập kênh bán hàng\nMô tả\n### BG-02: Tăng doanh thu")).toEqual([
      "Thiết lập kênh bán hàng",
      "Tăng doanh thu"
    ])
    expect(extractGoals("- Một\n- Hai")).toEqual(["Một", "Hai"])
    expect(extractGoals("Tăng doanh số 200%. Giảm gian lận.")).toEqual([])
  })

  it("parseUseCaseTable trả null khi không có bảng có cột use case + actor", () => {
    expect(parseUseCaseTable("UC01: Đăng nhập — actor Khách")).toBeNull()
    expect(parseUseCaseTable("| Screen | Mô tả |\n|---|---|\n| S1 | Home |")).toBeNull()
    expect(parseUseCaseTable("| Use case | Actor |\n|---|---|\n")).toBeNull()
  })
})

describe("buildMigratedSpine", () => {
  const base = createEmptySpine({ name: "Legacy", domain: "edu" })
  const { spine, summary } = buildMigratedSpine(base, LEGACY, NOW)

  it("vision, goals[] từ section đầu pha 2", () => {
    expect(spine.project.vision).toBe("FlintFlow giúp founder viết SRS.")
    expect(spine.project.goals).toEqual(["Giảm 50% thời gian viết SRS", "Chuẩn hoá template FPT", "Tăng tỉ lệ chuyển đổi"])
  })

  it("bảng use case thành actors[] + use_cases[] (id mới), văn bản gốc vẫn giữ ở addendum 2.2.2", () => {
    expect(spine.actors.map((a) => [a.id, a.name, a.kind])).toEqual([
      ["A01", "Khách", "human"],
      ["A02", "Người dùng", "human"],
      ["A03", "Admin", "human"]
    ])
    expect(spine.use_cases.map((uc) => [uc.id, uc.name, uc.actor_ids])).toEqual([
      ["UC01", "Đăng ký tài khoản", ["A01"]],
      ["UC02", "Tạo dự án", ["A02", "A03"]],
      ["UC03", "Xem báo cáo", ["A03", "A02"]]
    ])
    expect(spine.addendum.filter((a) => a.target_section === "fixed:2.2.2")).toHaveLength(1)
    expect(summary.use_case_table_parsed).toBe(true)
  })

  it("mọi section có nội dung còn lại thành addendum đúng đích, theo thứ tự bảng ánh xạ", () => {
    expect(spine.addendum.map((a) => [a.id, a.target_section, a.topic])).toEqual([
      ["AD01", "fixed:1", "Vision and problem"],
      ["AD02", "fixed:1", "Business goals"],
      ["AD03", "fixed:2.2.2", "Use case specification"],
      ["AD04", "fixed:3.1.2", "User stories"],
      ["AD05", "fixed:3.1.5", "Entity relationship model"],
      ["AD06", "fixed:5.4", "Legacy section: something_new"]
    ])
    expect(spine.addendum[1].captured_at).toBe("2026-01-02T00:00:00.000Z")
    expect(spine.addendum[0].captured_at).toBe(NOW.toISOString())
    expect(summary).toMatchObject({ sections: 7, addendum: 6, actors: 3, use_cases: 3, goals: 3, vision: true, unknown_types: ["something_new"], empty_types: ["glossary"] })
  })

  it("giữ nguyên progress B-0, steps rỗng, không đụng input, hợp spineSchema", () => {
    expect(spine.progress.current_step).toBe("B-0.1")
    expect(spine.steps).toEqual([])
    expect(base.addendum).toEqual([])
    expect(spineSchema.safeParse(spine).success).toBe(true)
  })

  it("bảng không parse được ⇒ use_case_spec thành addendum fixed:2.2.2", () => {
    const result = buildMigratedSpine(base, [{ type: "use_case_spec", content: "Danh sách use case viết tự do" }], NOW)
    expect(result.spine.use_cases).toEqual([])
    expect(result.spine.addendum.map((a) => a.target_section)).toEqual(["fixed:2.2.2"])
  })

  it("mọi loại section cũ đều có đích là section FPT", () => {
    for (const target of Object.values(LEGACY_SECTION_TARGETS)) expect(target.target_section).toMatch(/^fixed:\d/)
  })
})

describe("transaction migrate", () => {
  it("chỉ migrate Spine chưa từng ghi", () => {
    const fresh = createEmptySpine()
    expect(skipReasonOf(fresh, LEGACY)).toBeNull()
    expect(skipReasonOf(fresh, [])).toBe("no_sections")
    expect(skipReasonOf({ ...fresh, spine_version: 4 }, LEGACY)).toBe("spine_already_written")
  })

  it("op engine nhận lô: một change op migrate, reason legacy import, revert được về Spine rỗng", () => {
    const base = createEmptySpine({ name: "Legacy" })
    const { spine } = buildMigratedSpine(base, LEGACY, NOW)
    const plan = planTransaction(base, buildMigrationTransaction(base, spine), { startSeq: 1, now: NOW })

    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]).toMatchObject({ seq: 1, op: "migrate", path: "$", reason: MIGRATION_REASON, by: "system", step_id: null })
    expect(plan.spine.addendum).toHaveLength(6)
    expect(plan.spine.use_cases).toHaveLength(3)
    expect(plan.changes[0].before).toMatchObject({ addendum: [], actors: [] })
  })

  it("báo cáo markdown liệt kê số đếm và thoát ký tự |", () => {
    const { summary } = buildMigratedSpine(createEmptySpine(), LEGACY, NOW)
    const md = renderReport(
      [
        { projectId: "p1", name: "A | B", outcome: "would_migrate", detail: "", summary },
        { projectId: "p2", name: "C", outcome: "skipped", detail: "spine_already_written", summary: null }
      ],
      { dryRun: true, at: NOW, totalSections: 8 }
    )
    expect(md).toContain("dry-run")
    expect(md).toContain("Sẽ migrate: **1** · bỏ qua: **1** · lỗi: **0**")
    expect(md).toContain("A \\| B")
  })
})
