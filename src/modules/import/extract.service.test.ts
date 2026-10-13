/**
 * I-4 phần hàm thuần (plan §8.2 `extract.service.test.ts`). FLF-172 P4.
 * Phần cần Mongo + provider giả (không gọi AI khi bảng đủ cột, retry sai schema, độ tin < 0.7, hết credit,
 * resume, release hold) ở `test/integration/mode1/extract.service.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { parseDocument } from "./parse.service.js"
import { matchProfile } from "./profile-match.service.js"
import { makeSrsDocx } from "./testing/srs-fixture.js"
import {
  AI_BATCH_CHARS,
  AI_BLOCK_CHARS,
  captionOf,
  chunkBlocks,
  deterministicTableItems,
  dropMutualRelations,
  extractionPlan,
  itemsFromAi,
  keepMentionedRules,
  mergeItems,
  onlyNewFromVision,
  orientRelations,
  readsImage,
  sectionAiSteps,
  settleSection,
  shortName,
  splitList,
  stepsHash,
  visionItems
} from "./extract.service.js"
import { IdAllocator, flattenItem, idKey, type EntityItem } from "./extracted-entities.js"
import type { ITemplateProfile, TableMapEntry } from "./template-profile.model.js"
import { FIELD_CONFIDENCE_THRESHOLD } from "./import.constants.js"
import { tableGrid } from "./table-rows.js"

type Lite = Parameters<typeof deterministicTableItems>[0]

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

describe("sectionAiSteps — kế hoạch lượt AI (chung cho lượt chạy và ước tính credit)", () => {
  const none = { items: [], handled: new Set<string>(), consumed: new Set<string>(), verbatim: new Set<string>() }
  const img = (block_id: string, caption: string): Lite[] => [
    { ...block(block_id, "image", "", `body/p[${block_id}]`, "fixed:2.2.1"), image_ref: `word/media/${block_id}.png` },
    block(`${block_id}C`, "caption", caption, `body/p[${block_id}c]`, "fixed:2.2.1")
  ]

  it("ảnh đọc được trước, rồi lô chữ; bỏ heading, bảng đã đọc tất định, ảnh chụp màn hình; băm ổn định", () => {
    const blocks: Lite[] = [
      block("B0001", "heading", "2.2.1 Use Case Diagram", "body/p[0]", "fixed:2.2.1"),
      block("B0002", "paragraph", "x".repeat(AI_BLOCK_CHARS), "body/p[1]", "fixed:2.2.1"),
      ...img("B0003", "Figure 1 Use case diagram"),
      ...img("B0004", "Figure 2 Login screenshot"),
      block("B0005", "paragraph", "y".repeat(AI_BLOCK_CHARS), "body/p[5]", "fixed:2.2.1"),
      block("B0006", "paragraph", "z", "body/p[6]", "fixed:3.1.2")
    ]
    const steps = sectionAiSteps("fixed:2.2.1", blocks, none)
    expect(steps.map((s) => (s.kind === "image" ? `img:${s.block.block_id}` : s.batch.map((b) => b.block_id).join("+")))).toEqual([
      "img:B0003",
      "B0002+B0003C+B0004C+B0005"
    ])
    expect(stepsHash(steps)).toBe(stepsHash(sectionAiSteps("fixed:2.2.1", blocks, none)))
    // block đổi ⇒ băm đổi (tiến độ đã lưu không dùng lại)
    const changed = blocks.map((b) => (b.block_id === "B0005" ? { ...b, text: "changed" } : b))
    expect(stepsHash(sectionAiSteps("fixed:2.2.1", changed, none))).not.toBe(stepsHash(steps))
    // block đã đọc tất định không vào lô
    const settled = { ...none, consumed: new Set(["B0002", "B0003C", "B0004C"]) }
    expect(sectionAiSteps("fixed:2.2.1", blocks, settled).map((s) => s.kind)).toEqual(["image", "text"])
  })

  it("section không có mục tiêu trích ⇒ không có lô chữ (ảnh mục diagram vẫn đọc)", () => {
    expect(sectionAiSteps("fixed:9.9", [block("B0001", "paragraph", "a", "p", "fixed:9.9")], none)).toEqual([])
  })
})

describe("shortName — tên chức năng từ câu yêu cầu (FLF-252)", () => {
  it("bỏ 'The system shall', lấy câu đầu, cắt ở ranh giới từ", () => {
    expect(shortName("The system shall allow users to register with email. A confirmation is sent.")).toBe("Allow users to register with email")
    expect(shortName("Users must be able to export reports")).toBe("Users must be able to export reports")
    const long = shortName(`The system shall ${"very ".repeat(30)}long`)
    expect(long.length).toBeLessThanOrEqual(81)
    expect(long.endsWith("…")).toBe(true)
  })
})

describe("splitList — ô danh sách", () => {
  it("FLF-251: cột tham chiếu tách cả tác nhân phụ trong ngoặc; danh sách thường giữ ngoặc", () => {
    expect(splitList("Guest (Email Service, Identity Provider); Admin", true)).toEqual(["Guest", "Email Service", "Identity Provider", "Admin"])
    expect(splitList("Learner, Admin\nGuest")).toEqual(["Learner", "Admin", "Guest"])
    expect(splitList("Cut cost (by 20%)")).toEqual(["Cut cost (by 20%)"])
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

  it("FLF-251: cột include/extend tách danh sách tham chiếu như cột tác nhân", () => {
    const rows = [
      ["ID", "Use Case", "Actors", "Includes"],
      ["UC01", "Create slot", "Officer (Email Service)", "Send change notice, UC-07"]
    ]
    const items = deterministicTableItems(
      blocks[0],
      rows,
      profileOf([col(0, "use_cases[].id"), col(1, "use_cases[].name"), col(2, "use_cases[].actor_ids"), col(3, "use_cases[].includes")])
    )!
    expect(items[0].value).toEqual({ name: "Create slot", actor_ids: ["Officer", "Email Service"], includes: ["Send change notice", "UC-07"] })
  })

  it("FLF-252: hàng nhóm không thành phần tử; hàng tên bảng bị bỏ; nhãn nhóm làm feature của màn; Feature gộp dọc điền xuống", () => {
    const ucRows = [
      ["Use cases of the system"],
      ["ID", "Use Case", "Actors", "Description"],
      ["1", "Account & Organization"],
      ["UC-01", "Register Account", "Guest", "Create an account"]
    ]
    const uc = deterministicTableItems(blocks[0], ucRows, profileOf([col(0, "use_cases[].id"), col(1, "use_cases[].name"), col(2, "use_cases[].actor_ids")]))!
    expect(uc.map((i) => [i.id, i.value.name])).toEqual([["UC-01", "Register Account"]])

    const screenRows = [
      ["Screen", "Feature", "Description"],
      ["PUBLIC SCREENS"],
      ["Landing Page", "", "Marketing page"],
      ["Login", "Account", "Sign in"],
      ["Logout", "", "Sign out"]
    ]
    const screens = deterministicTableItems(blocks[0], screenRows, profileOf([col(0, "screens[].name"), col(1, "screens[].feature_id"), col(2, "screens[].description")]))!
    expect(screens.map((i) => [i.value.name, i.value.feature_id])).toEqual([
      ["Landing Page", "PUBLIC SCREENS"],
      ["Login", "Account"],
      ["Logout", "Account"]
    ])
  })

  it("FLF-252: ma trận phân quyền ⇒ vai trò theo tiêu đề cột + quyền theo ô đánh dấu", () => {
    const rows = [
      ["Screen", "Guest", "Admin"],
      ["PUBLIC SCREENS"],
      ["Landing Page", "X", "X"],
      ["Users", "", "view, delete"]
    ]
    const items = deterministicTableItems(blocks[0], rows, profileOf([col(0, "permissions[].screen_id"), col(1, "permissions[].role_id"), col(2, "permissions[].role_id")]))!
    expect(items.filter((i) => i.entity === "roles").map((i) => i.value)).toEqual([
      { name: "Guest", actor_id: "Guest" },
      { name: "Admin", actor_id: "Admin" }
    ])
    expect(items.filter((i) => i.entity === "permissions").map((i) => i.value)).toEqual([
      { screen_id: "Landing Page", role_id: "Guest", action: "access" },
      { screen_id: "Landing Page", role_id: "Admin", action: "access" },
      { screen_id: "Users", role_id: "Admin", action: "view" },
      { screen_id: "Users", role_id: "Admin", action: "delete" }
    ])
    expect(items.every((i) => i.origin === "deterministic" && i.id === null)).toBe(true)
  })

  it("FLF-252: bảng yêu cầu 'ID | Requirement | Priority' dưới tính năng ⇒ chức năng có mã, tên rút từ câu, mô tả đủ câu", () => {
    const rows = [
      ["ID", "Requirement", "Priority", "Acceptance Criteria"],
      ["FR-001", "The system shall let a learner enrol in a course.", "Must", "Enrolment appears in My Courses"]
    ]
    const items = deterministicTableItems(blocks[0], rows, profileOf([col(0, "functions[].id"), col(1, "functions[].description"), col(2, "functions[].priority")]))!
    expect(items).toMatchObject([
      { entity: "functions", id: "FR-001", value: { name: "Let a learner enrol in a course", description: "The system shall let a learner enrol in a course.", priority: "Must" } }
    ])
  })

  it("FLF-252: bảng NFR 'External System | Description' ⇒ tên hệ thống đứng đầu câu (cột tên không map); cột sau câu không ghép", () => {
    const rows = [
      ["External System", "Description", "Owner"],
      ["GitHub", "Provides Pull Request events, repository data, and code changes for analysis.", "DevOps"],
      ["Payment Gateway", "Payment Gateway handles subscription payments.", "Finance"]
    ]
    const items = deterministicTableItems(blocks[0], rows, profileOf([col(0, null), col(1, "nfrs[].statement"), col(2, null)]))!
    expect(items.map((i) => i.value.statement)).toEqual([
      "GitHub: Provides Pull Request events, repository data, and code changes for analysis.",
      // câu đã bắt đầu bằng tên ⇒ không lặp
      "Payment Gateway handles subscription payments."
    ])
  })

  it("FLF-252 settleSection: NFR đọc từ bảng nhận nhóm theo mục như NFR AI trích (4.1 ⇒ interface)", () => {
    const t = { ...block("B0050", "table", "", "body/tbl[3]", "fixed:4.1"), rows: [["External System", "Description"], ["GitHub", "Provides PR events."]] }
    const profile = {
      table_map: [{ block_id: "B0050", column_index: 1, header: "Description", field_path: "nfrs[].statement", confidence: 0.9, confirmed: true }]
    } as unknown as ITemplateProfile
    const out = settleSection("fixed:4.1", [t], profile, new Map())
    expect(out.items.map((i) => i.value)).toEqual([{ statement: "GitHub: Provides PR events.", category: "interface" }])
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

  it("FLF-252: ảnh chép khoá 'A01' của bảng (id cấp tự động) ⇒ đúng tác nhân đó, không thành 'A-01'; khoá là tên ⇒ cấp mã mới", () => {
    const actor = (id: string, name: string): EntityItem => ({ entity: "actors", id, value: { name }, confidence: 1, field_confidence: {}, source_block_ids: ["B0003"], origin: "deterministic" })
    const alloc = new IdAllocator({ actors: ["A01", "A02"], entities: ["E01"] })
    const out = itemsFromAi(
      {
        section_id: "fixed:1",
        items: [
          item({ entity: "actors", key: "A01", value: { name: "Developer", kind: "human" } }),
          item({ entity: "actors", key: "ACT-2", value: { name: "admin", kind: "human" } }),
          item({ entity: "entities", key: "LimCallLog", value: { name: "LimCallLog" } })
        ],
        unmapped_block_ids: []
      },
      { ...ctx([actor("A01", "Developer"), actor("A02", "Admin")], "fixed:1"), alloc, validBlocks: new Set(["B0005"]), fromImage: true }
    )
    expect(out.map((i) => i.id)).toEqual(["A01", "A02", "E02"])
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

  it("FLF-252 keepMentionedRules: mã business rule model gán cho chức năng phải có trong chữ của mục", () => {
    const fn = (ids: unknown[]): EntityItem => ({
      entity: "functions",
      id: "FR-3.2.3",
      value: { name: "Logout", business_rule_ids: ids },
      confidence: 0.5,
      field_confidence: {},
      source_block_ids: ["B0584"],
      origin: "ai"
    })
    // mục không ghi mã BR nào ⇒ mã model đoán bị bỏ, không còn field
    expect(keepMentionedRules([fn(["BR-01"])], new Set())[0].value).toEqual({ name: "Logout" })
    // giữ mã có trong chữ (khác dạng vẫn khớp), bỏ mã đoán + câu nhét vào chỗ mã
    expect(keepMentionedRules([fn(["BR05", "BR-01", "Only admins can log out."])], new Set([idKey("BR-05")]))[0].value.business_rule_ids).toEqual(["BR05"])
    const ok = fn(["BR-05"])
    expect(keepMentionedRules([ok], new Set([idKey("BR-05")]))[0]).toBe(ok)
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

  it("FLF-252 readsImage: chọn ảnh theo caption — ảnh màn hình / sequence không đọc; sơ đồ đọc được ở mục khác FPT vẫn đọc", () => {
    expect(readsImage("fixed:2.2.1", "(none)")).toBe(true)
    expect(readsImage("fixed:2.2.1", "Figure 03. Use Case Diagram - Account")).toBe(true)
    expect(readsImage("fixed:3.1.1", "Figure 17 - Register account screen layout")).toBe(false)
    expect(readsImage("fixed:2.2.2", "Figure 5 - Sequence diagram for Login")).toBe(false)
    expect(readsImage("fixed:4.1", "Figure 9 - Entity Relationship Diagram")).toBe(true)
    expect(readsImage("function:@B0042", "Hình 3: Giao diện đăng nhập")).toBe(false)
    expect(readsImage("function:@B0042", "(none)")).toBe(false)
  })

  it("FLF-252 onlyNewFromVision: phần tử ảnh trùng phần tử của bảng ⇒ chỉ còn quan hệ mới; không có gì mới ⇒ bỏ", () => {
    const table: EntityItem = { entity: "use_cases", id: "UC-02", value: { name: "Log in", actor_ids: ["Learner"] }, confidence: 0.95, field_confidence: {}, source_block_ids: ["B0010"], origin: "deterministic" }
    const vision = (value: Record<string, unknown>, id = "UC-02", entity = "use_cases"): EntityItem => ({
      entity,
      id,
      value,
      confidence: 0.6,
      field_confidence: { actor_ids: 0.5, name: 0.6 },
      source_block_ids: ["B0005"],
      origin: "vision"
    })
    expect(onlyNewFromVision([vision({ name: "Log In", actor_ids: ["learner", "Guest"] })], [table])).toEqual([
      { ...vision({ actor_ids: ["Guest"] }), field_confidence: { actor_ids: 0.5 } }
    ])
    expect(onlyNewFromVision([vision({ name: "Log in", actor_ids: ["Learner"] })], [table])).toEqual([])
    // phần tử mới hoàn toàn từ ảnh ⇒ giữ nguyên để người dùng xác nhận
    const fresh = vision({ name: "Guest", kind: "human" }, "A02", "actors")
    expect(onlyNewFromVision([fresh], [table])).toEqual([fresh])
  })

  it("FLF-252 onlyNewFromVision: field bảng không có (loại tác nhân) là phần ảnh thêm vào; ảnh sau vẽ lại ⇒ không hỏi lại", () => {
    const actor: EntityItem = { entity: "actors", id: "A03", value: { name: "GitHub Actions", description: "CI service" }, confidence: 1, field_confidence: {}, source_block_ids: ["B0051"], origin: "deterministic" }
    const context: EntityItem = {
      entity: "actors",
      id: "A03",
      value: { name: "GitHub Actions", kind: "system", description: "" },
      confidence: 0.7,
      field_confidence: {},
      source_block_ids: ["B0048"],
      origin: "vision"
    }
    const fromContext = onlyNewFromVision([context], [actor])
    expect(fromContext).toEqual([{ ...context, value: { kind: "system" } }])
    // sơ đồ use case vẽ lại cùng tác nhân: bảng + ảnh trước đã đủ ⇒ không còn gì để hỏi
    expect(onlyNewFromVision([{ ...context, source_block_ids: ["B0069"] }], [actor, ...fromContext])).toEqual([])
    // quan hệ rỗng của ảnh không thành dòng duyệt
    const uc: EntityItem = { entity: "use_cases", id: "UC-02", value: { name: "Log in", actor_ids: ["GitHub Actions"] }, confidence: 1, field_confidence: {}, source_block_ids: ["B0010"], origin: "deterministic" }
    expect(onlyNewFromVision([{ ...uc, value: { name: "Log in", includes: [], extends: [] }, origin: "vision" }], [uc])).toEqual([])
    // ảnh nối bằng mã ("A-03"), bảng ghi tên ⇒ cùng tác nhân, không phải quan hệ mới
    expect(onlyNewFromVision([{ ...uc, value: { actor_ids: ["A-03"] }, origin: "vision" }], [actor, uc])).toEqual([])
  })

  it("FLF-252 mergeItems: phần ảnh bù vào phần tử của bảng cùng mục giữ nguồn ảnh + độ tin ảnh ⇒ vẫn phải duyệt", () => {
    const table: EntityItem = { entity: "entities", id: "E01", value: { name: "user", description: "A system user" }, confidence: 1, field_confidence: {}, source_block_ids: ["B0475"], origin: "deterministic" }
    const erd: EntityItem = { entity: "entities", id: "E01", value: { relations: ["Account", "E02"] }, confidence: 0.7, field_confidence: {}, source_block_ids: ["B0473"], origin: "vision" }
    const [merged] = mergeItems([table, erd])
    expect(merged.value).toEqual({ name: "user", description: "A system user", relations: ["Account", "E02"] })
    expect(flattenItem(merged).map((f) => [f.path, f.origin, f.confidence])).toEqual([
      ["entities[id=E01].name", "deterministic", 1],
      ["entities[id=E01].description", "deterministic", 1],
      ["entities[id=E01].relations", "vision", 0.7]
    ])
    // ảnh đọc trước, chữ sau: chữ thắng field trùng, quan hệ ảnh thêm vào làm cả danh sách phải duyệt
    const image: EntityItem = { entity: "use_cases", id: "UC-02", value: { name: "Log In", actor_ids: ["Guest"] }, confidence: 0.6, field_confidence: {}, source_block_ids: ["B0005"], origin: "vision" }
    const text: EntityItem = { entity: "use_cases", id: "UC-02", value: { name: "Log in", actor_ids: ["Learner"] }, confidence: 0.9, field_confidence: {}, source_block_ids: ["B0007"], origin: "ai" }
    expect(flattenItem(mergeItems([image, text])[0]).map((f) => [f.path, f.value, f.origin, f.confidence])).toEqual([
      ["use_cases[id=UC-02].name", "Log in", "ai", 0.9],
      ["use_cases[id=UC-02].actor_ids", ["Learner", "Guest"], "vision", 0.6]
    ])
  })

  it("FLF-252 orientRelations: model đọc ngược đầu mũi tên ⇒ đảo theo nét nối tác nhân (gốc có tác nhân); đọc đúng / không phân định được ⇒ giữ", () => {
    const uc = (id: string, name: string, value: Record<string, unknown> = {}): EntityItem => ({
      entity: "use_cases",
      id,
      value: { name, ...value },
      confidence: 0.65,
      field_confidence: {},
      source_block_ids: ["B0069"],
      origin: "vision"
    })
    // đọc ngược như model dự phòng trên sơ đồ WDP301
    const read = [
      uc("UC-25", "View List User", { actor_ids: ["Admin"], extends: ["UC-27", "Ban / Unban User"] }),
      uc("UC-26", "Ban / Unban User"),
      uc("UC-27", "View User Detail"),
      uc("UC-34", "Trigger Analysis Workflow", { actor_ids: ["GitHub Actions"] }),
      uc("UC-35", "Execute Analyzer", { includes: ["UC-34"] }),
      uc("UC-37", "Process Payment", { actor_ids: ["Payment Gateway"], includes: ["Verify Transaction"] }),
      uc("UC-38", "Verify Transaction")
    ]
    const relations = (items: EntityItem[]) =>
      items.map((u) => [u.id, (u.value.includes as string[] | undefined) ?? [], (u.value.extends as string[] | undefined) ?? []])
    expect(relations(orientRelations(read, []))).toEqual([
      ["UC-25", [], []],
      ["UC-26", [], ["UC-25"]],
      ["UC-27", [], ["UC-25"]],
      ["UC-34", ["UC-35"], []],
      ["UC-35", [], []],
      ["UC-37", ["Verify Transaction"], []],
      ["UC-38", [], []]
    ])
    // model không ghi tác nhân cho gốc nhưng một use case "extend" hai use case ⇒ vẫn là đọc ngược
    const fanOut = [uc("UC-25", "View List User", { extends: ["View User Detail", "UC-26"] }), uc("UC-26", "Ban / Unban User"), uc("UC-27", "View User Detail")]
    expect(relations(orientRelations(fanOut, []))).toEqual([
      ["UC-25", [], []],
      ["UC-26", [], ["UC-25"]],
      ["UC-27", [], ["UC-25"]]
    ])
    // đọc đúng ⇒ không đổi gì
    const right = [uc("UC-25", "View List User", { actor_ids: ["Admin"] }), uc("UC-27", "View User Detail", { extends: ["UC-25"] })]
    expect(orientRelations(right, [])).toBe(right)
    // hai đầu cùng không nối tác nhân ⇒ không đoán
    const unknown = [uc("UC-01", "A", { includes: ["UC-02"] }), uc("UC-02", "B")]
    expect(orientRelations(unknown, [])).toBe(unknown)
  })

  it("FLF-252 dropMutualRelations: ảnh cho hai use case extend lẫn nhau (đọc nhầm chiều mũi tên) ⇒ bỏ cả cặp; quan hệ một chiều giữ nguyên", () => {
    const uc = (id: string, name: string, value: Record<string, unknown> = {}, origin: EntityItem["origin"] = "vision"): EntityItem => ({
      entity: "use_cases",
      id,
      value: { name, ...value },
      confidence: 0.65,
      field_confidence: {},
      source_block_ids: ["B0069"],
      origin
    })
    const known = [uc("UC-25", "View List User", {}, "deterministic"), uc("UC-26", "Ban / Unban User", {}, "deterministic"), uc("UC-27", "View User Detail", {}, "deterministic")]
    const read = [
      uc("UC-27", "View User Detail", { extends: ["Ban / Unban User"] }),
      uc("UC-26", "Ban / Unban User", { extends: ["UC-27", "View List User"] }),
      uc("UC-37", "Process Payment", { includes: ["Verify Transaction"] })
    ]
    expect(dropMutualRelations(read, known).map((u) => [u.id, u.value.extends ?? u.value.includes])).toEqual([
      ["UC-27", []],
      ["UC-26", ["View List User"]],
      ["UC-37", ["Verify Transaction"]]
    ])
    // không có cặp mâu thuẫn ⇒ trả nguyên mảng
    const oneWay = read.slice(2)
    expect(dropMutualRelations(oneWay, known)).toBe(oneWay)
  })

  it("visionItems: origin vision, độ tin item + từng field ≤ 0.7", () => {
    const it0: EntityItem = { entity: "actors", id: "A09", value: { name: "Guest" }, confidence: 0.95, field_confidence: { kind: 0.9, name: 0.4 }, source_block_ids: ["B0002"], origin: "ai" }
    expect(visionItems([it0])).toEqual([{ ...it0, origin: "vision", confidence: 0.7, field_confidence: { kind: 0.7, name: 0.4 } }])
  })
})
