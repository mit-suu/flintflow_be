/**
 * I-4 phần hàm thuần (plan §8.2 `extract.service.test.ts`). FLF-172 P4.
 * Phần cần Mongo + provider giả (không gọi AI khi bảng đủ cột, retry sai schema, độ tin < 0.7, hết credit,
 * resume, release hold) ở `test/integration/mode1/extract.service.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { parseDocument } from "./parse.service.js"
import { matchProfile } from "./profile-match.service.js"
import { makeSrsDocx } from "./testing/srs-fixture.js"
import { AI_BATCH_CHARS, AI_BLOCK_CHARS, captionOf, chunkBlocks, deterministicTableItems, extractionPlan, itemsFromAi, tableGrid, visionItems } from "./extract.service.js"
import { IdAllocator, flattenItem, type EntityItem } from "./extracted-entities.js"
import type { ITemplateProfile, TableMapEntry } from "./template-profile.model.js"
import { FIELD_CONFIDENCE_THRESHOLD } from "./import.constants.js"

type Lite = Parameters<typeof tableGrid>[0]

const block = (block_id: string, kind: Lite["kind"], text: string, xml_path: string, section_id: string | null = null): Lite => ({
  block_id,
  kind,
  text,
  section_id,
  anchor: { bookmark: null, para_id: null, xml_path, ordinal: Number(block_id.slice(1)) }
})

/** Bảng 3 hàng × 3 cột dạng block như parse sinh ra. */
const ucTable = (): Lite[] => {
  const rows = [
    ["Use Case ID", "Use Case Name", "Actor"],
    ["UC01", "Register account", "Learner, Admin"],
    ["UC-02", "Log in", "Learner"]
  ]
  const out: Lite[] = [block("B0010", "table", rows.map((r) => r.join(" | ")).join("\n"), "body/tbl[0]", "fixed:2.2.2")]
  let n = 11
  rows.forEach((r, ri) => r.forEach((c, ci) => out.push(block(`B00${n++}`, "table_cell", c, `body/tbl[0]/tr[${ri}]/tc[${ci}]/p[0]`, "fixed:2.2.2"))))
  return out
}

const col = (column_index: number, field_path: string | null, confidence = 0.95, confirmed = false): TableMapEntry => ({
  block_id: "B0010",
  column_index,
  header: `c${column_index}`,
  field_path,
  confidence,
  confirmed
})
const profileOf = (table_map: TableMapEntry[]) => ({ table_map }) as unknown as ITemplateProfile

describe("extractionPlan", () => {
  it("section cần trích theo thứ tự tài liệu, không lặp; bỏ Record of Changes, nhóm, unmapped, feature không mục tiêu vẫn giữ", () => {
    const blocks = [
      block("B0001", "paragraph", "rev", "p", "fixed:I"),
      block("B0002", "paragraph", "a", "p", "fixed:1"),
      block("B0003", "paragraph", "b", "p", "fixed:1"),
      block("B0004", "paragraph", "c", "p", null),
      block("B0005", "paragraph", "d", "p", "unmapped"),
      block("B0006", "paragraph", "e", "p", "function:@B0006"),
      block("B0007", "paragraph", "f", "p", "fixed:5.1"),
      block("B0008", "paragraph", "g", "p", "fixed:9.9")
    ]
    expect(extractionPlan(blocks)).toEqual(["fixed:1", "function:@B0006", "fixed:5.1"])
  })

  it("SRS mẫu: đúng 10 section theo thứ tự tài liệu", async () => {
    const { blocks } = await parseDocument(await makeSrsDocx())
    const profile = matchProfile(blocks)
    const sectionOf = new Map(profile.heading_map.map((h) => [h.block_id, h.section_id]))
    // gán section đơn giản theo heading gần nhất (đủ cho SRS mẫu)
    let cur: string | null = null
    const lite = blocks.map((b) => {
      if (b.kind === "heading") cur = sectionOf.get(b.block_id) ?? null
      return { ...block(b.block_id, b.kind, b.text, b.xml_path), section_id: cur }
    })
    const plan = extractionPlan(lite)
    expect(plan.filter((s) => s.startsWith("fixed:"))).toEqual(["fixed:1", "fixed:2.1", "fixed:2.2.1", "fixed:2.2.2", "fixed:3.1.2", "fixed:4.2.3", "fixed:5.1"])
    expect(plan.filter((s) => !s.startsWith("fixed:"))).toHaveLength(3) // 1 feature + 2 function
  })
})

describe("tableGrid", () => {
  it("dựng lưới ô từ block table_cell, đoạn cùng ô nối xuống dòng, không lẫn bảng khác", () => {
    const blocks = [
      ...ucTable(),
      block("B0020", "table_cell", "dòng 2 của ô", "body/tbl[0]/tr[2]/tc[1]/p[1]"),
      block("B0030", "table_cell", "bảng khác", "body/tbl[1]/tr[0]/tc[0]/p[0]")
    ]
    expect(tableGrid(blocks[0], blocks)).toEqual([
      ["Use Case ID", "Use Case Name", "Actor"],
      ["UC01", "Register account", "Learner, Admin"],
      ["UC-02", "Log in\ndòng 2 của ô", "Learner"]
    ])
  })
})

describe("deterministicTableItems — bảng khớp đủ cột (G7)", () => {
  const blocks = ucTable()
  const grid = tableGrid(blocks[0], blocks)

  it("đủ cột bắt buộc ⇒ mỗi hàng dữ liệu một item tất định, id chuẩn hoá, cột danh sách tách phần tử", () => {
    const items = deterministicTableItems(blocks[0], grid, profileOf([col(0, "use_cases[].id"), col(1, "use_cases[].name"), col(2, "use_cases[].actor_ids", 0.9)]))
    expect(items).toEqual([
      {
        entity: "use_cases",
        id: "UC-01",
        value: { name: "Register account", actor_ids: ["Learner", "Admin"] },
        confidence: 0.9,
        field_confidence: {},
        source_block_ids: ["B0010"],
        origin: "deterministic"
      },
      {
        entity: "use_cases",
        id: "UC-02",
        value: { name: "Log in", actor_ids: ["Learner"] },
        confidence: 0.9,
        field_confidence: {},
        source_block_ids: ["B0010"],
        origin: "deterministic"
      }
    ])
  })

  it("thiếu cột bắt buộc (use case không có cột id) ⇒ null để AI trích", () => {
    expect(deterministicTableItems(blocks[0], grid, profileOf([col(1, "use_cases[].name"), col(2, "use_cases[].actor_ids")]))).toBeNull()
  })

  it("không có mapping cột / chỉ có hàng tiêu đề / cột bỏ trống ⇒ null", () => {
    expect(deterministicTableItems(blocks[0], grid, profileOf([]))).toBeNull()
    expect(deterministicTableItems(blocks[0], grid, profileOf([col(0, null), col(1, null)]))).toBeNull()
    expect(deterministicTableItems(blocks[0], grid.slice(0, 1), profileOf([col(0, "use_cases[].id"), col(1, "use_cases[].name")]))).toBeNull()
  })

  it("cột đã được người dùng xác nhận ⇒ độ tin 1; hàng trống bị bỏ", () => {
    const withEmpty = [...grid, ["", "", ""]]
    const items = deterministicTableItems(blocks[0], withEmpty, profileOf([col(0, "use_cases[].id", 0.4, true), col(1, "use_cases[].name", 0.6, true)]))!
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.confidence === 1)).toBe(true)
  })

  it("độ tin cột thấp ⇒ field của bảng rơi vào danh sách cần xác nhận (< 0.7)", () => {
    const items = deterministicTableItems(blocks[0], grid, profileOf([col(0, "use_cases[].id", 0.6), col(1, "use_cases[].name", 0.95)]))!
    const fields = items.flatMap(flattenItem)
    expect(fields.every((f) => f.confidence === 0.6 && f.confidence < FIELD_CONFIDENCE_THRESHOLD)).toBe(true)
    expect(fields.every((f) => f.origin === "deterministic")).toBe(true)
  })
})

describe("chunkBlocks — lô gửi AI", () => {
  const b = (id: string, len: number) => ({ block_id: id, text: "x".repeat(len) })

  it("gom block tới ngân sách, sang lô mới khi vượt", () => {
    const chunks = chunkBlocks([b("B1", 10), b("B2", 10), b("B3", 10), b("B4", 5)], 25)
    expect(chunks.map((c) => c.map((x) => x.block_id))).toEqual([["B1", "B2"], ["B3", "B4"]])
  })

  it("block quá dài bị cắt, đánh dấu truncated; block dài vẫn đi một mình", () => {
    const chunks = chunkBlocks([b("B1", AI_BLOCK_CHARS + 500), b("B2", 10)])
    expect(chunks[0][0].text).toHaveLength(AI_BLOCK_CHARS + " …(truncated)".length)
    expect(chunks[0][0].text.endsWith("…(truncated)")).toBe(true)
    expect(chunks.flat().map((x) => x.block_id)).toEqual(["B1", "B2"])
  })

  it("mặc định ngân sách 24k ký tự; không có block ⇒ không có lô", () => {
    expect(AI_BATCH_CHARS).toBe(24_000)
    expect(chunkBlocks([])).toEqual([])
    expect(chunkBlocks(Array.from({ length: 5 }, (_, i) => b(`B${i}`, 5_000))).map((c) => c.length)).toEqual([4, 1])
  })
})

describe("itemsFromAi — output model ⇒ item", () => {
  const ctx = (known: EntityItem[] = [], sectionId = "fixed:2.2.2") => ({
    sectionId,
    alloc: new IdAllocator({ use_cases: ["UC-01"] }),
    known,
    sectionFunction: null,
    validBlocks: new Set(["B0005", "B0006"])
  })
  const item = (over: Record<string, unknown>) => ({ entity: "use_cases", key: null, value: {}, confidence: 0.9, field_confidence: {}, source_block_ids: ["B0005"], ...over }) as never

  it("khoá tài liệu được chuẩn hoá; không khoá ⇒ dùng lại id theo tên đã biết, còn không thì cấp id mới", () => {
    const known: EntityItem[] = [{ entity: "use_cases", id: "UC-07", value: { name: "Log in" }, confidence: 1, field_confidence: {}, source_block_ids: [], origin: "deterministic" }]
    const out = itemsFromAi(
      {
        section_id: "fixed:2.2.2",
        items: [item({ key: "uc_09", value: { name: "Pay", id: "ignored" } }), item({ value: { name: "log in" } }), item({ value: { name: "New one" } })],
        unmapped_block_ids: []
      },
      ctx(known)
    )
    expect(out.map((i) => i.id)).toEqual(["UC-09", "UC-07", "UC-02"])
    expect(out[0].value).toEqual({ name: "Pay" })
    expect(out.every((i) => i.origin === "ai")).toBe(true)
  })

  it("block nguồn không thuộc lô bị lọc; không còn cái nào ⇒ lấy block đầu của lô", () => {
    const out = itemsFromAi(
      { section_id: "x", items: [item({ source_block_ids: ["B0005", "B9999"] }), item({ source_block_ids: ["B9999"] })], unmapped_block_ids: [] },
      ctx()
    )
    expect(out.map((i) => i.source_block_ids)).toEqual([["B0005"], ["B0005"]])
  })

  it("NFR nhận category theo section khi model không ghi; project không có id; giữ field_confidence", () => {
    const out = itemsFromAi(
      {
        section_id: "fixed:4.2.3",
        items: [
          item({ entity: "nfrs", key: "NFR-01", value: { statement: "fast" }, field_confidence: { threshold: 0.4 } }),
          item({ entity: "project", value: { vision: "v" } })
        ],
        unmapped_block_ids: []
      },
      ctx([], "fixed:4.2.3")
    )
    expect(out[0]).toMatchObject({ id: "NFR-01", value: { statement: "fast", category: "performance" }, field_confidence: { threshold: 0.4 } })
    expect(out[1].id).toBeNull()
  })

  it("section function: item function đầu tiên nhận id của function theo heading", () => {
    const out = itemsFromAi(
      { section_id: "function:@B0005", items: [item({ entity: "functions", key: "X-1", value: { trigger: "t" } }), item({ entity: "functions", value: { name: "khác" } })], unmapped_block_ids: [] },
      {
        ...ctx([], "function:@B0005"),
        sectionFunction: { section: "function:@B0005", entity: "functions", id: "FR-3.2.1", name: "Register", feature_id: "F-3.2", block_id: "B0005", confidence: 0.85 }
      }
    )
    expect(out[0].id).toBe("FR-3.2.1")
    expect(out[1].id).not.toBe("FR-3.2.1")
  })
})

describe("ảnh diagram (mode 1 v3 phase 5)", () => {
  const blk = (block_id: string, kind: string, text = "") => ({ block_id, kind, text }) as never

  it("captionOf: caption ngay sau ảnh, không có thì ngay trước; không có ⇒ (none)", () => {
    const blocks = [blk("B1", "caption", "Hình 0"), blk("B2", "image"), blk("B3", "caption", "Hình 1: Use case"), blk("B4", "image"), blk("B5", "paragraph", "x")]
    expect(captionOf(blk("B2", "image"), blocks)).toBe("Hình 1: Use case")
    expect(captionOf(blk("B4", "image"), blocks)).toBe("Hình 1: Use case")
    expect(captionOf(blk("B9", "image"), [blk("B9", "image"), blk("B10", "paragraph", "y")])).toBe("(none)")
  })

  it("visionItems: origin vision, độ tin item + từng field ≤ 0.7", () => {
    const it0: EntityItem = { entity: "actors", id: "A09", value: { name: "Guest" }, confidence: 0.95, field_confidence: { kind: 0.9, name: 0.4 }, source_block_ids: ["B0002"], origin: "ai" }
    expect(visionItems([it0])).toEqual([{ ...it0, origin: "vision", confidence: 0.7, field_confidence: { kind: 0.7, name: 0.4 } }])
  })
})
