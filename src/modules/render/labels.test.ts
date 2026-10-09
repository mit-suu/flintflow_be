import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { spineSchema } from "../spine/spine.schema.js"
import { FIXED_SECTIONS } from "../spine/section-registry.js"
import type { Spine } from "../spine/spine.types.js"
import { loadStepRegistry } from "../pipeline/step-registry.js"
import { _internal } from "./assemble.service.js"
import type { ChangeRecordRow } from "./section-renderer.js"
import type { TemplateLayout } from "./layout-sections.js"
import type { Block, InlineRun, RenderedDocument } from "./rendered-document.types.js"
import {
  ASSEMBLE_TEXT,
  GROUP_HEADINGS,
  RECORD_TEXT,
  VI_ENUM_LABELS,
  VI_FPT_LABELS,
  VI_LABELS,
  VI_PHASE_LABELS,
  VI_SECTION_TITLES,
  WRITER_TEXT,
  enumLabel,
  fptLabelFor,
  labelFor,
  writerOptionsFor
} from "./labels.js"
import { writeDocx } from "./docx-writer.js"
import { readZipText } from "./zip.test-helper.js"

const fixture = (): Spine =>
  spineSchema.parse(JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-19-screens.json", import.meta.url), "utf8")))

/** Fixture 19 màn + một function mồ côi (heading "Unassigned Functions") + vài sơ đồ chưa có PNG (caption chờ ảnh). */
const spineForLabels = (): Spine => {
  const spine = fixture()
  spine.functions.push({
    id: "FN-ORPHAN",
    screen_id: null,
    feature_id: "F-DEAD",
    order: 99,
    name: "Orphan Nightly Cleanup",
    trigger: "Cron 03:00 UTC.",
    description: "Removes expired sessions.",
    normal: ["The system deletes expired sessions."],
    abnormal: [],
    validations: [],
    business_rule_ids: [],
    priority: null
  })
  return spine
}

const change = (over: Partial<ChangeRecordRow>): ChangeRecordRow => ({
  txn: "t1",
  op: "add",
  reason: "seed",
  at: "2026-09-01T09:00:00.000Z",
  by: "system",
  step_id: "S-2.1",
  path: "actors[id=A01].name",
  ...over
})

/** Lịch sử phủ mọi nhánh câu máy của §I: tạo/cập nhật theo giai đoạn, baseline, câu máy, lời user, "and N more". */
const RECORD: ChangeRecordRow[] = [
  change({ txn: "t1", step_id: "B-1.1" }),
  change({ txn: "t2", step_id: "S-3.1", at: "2026-09-02T09:00:00.000Z" }),
  change({ txn: "t3", step_id: "S-3.2", at: "2026-09-03T09:00:00.000Z", by: "u1" }),
  change({ txn: "b1", path: "baselines[]", step_id: "S-9.5", reason: "Ký baseline v1.0", at: "2026-09-04T09:00:00.000Z" }),
  change({ txn: "b2", path: "baselines[]", step_id: null, reason: null, at: "2026-09-05T09:00:00.000Z" }),
  change({ txn: "c0", op: "set", step_id: null, reason: "Cascade: roles[id=R1] removed", at: "2026-09-06T09:00:00.000Z" }),
  change({ txn: "c1", op: "set", step_id: null, reason: "Customer asked to rename Login", at: "2026-09-07T09:00:00.000Z", by: "u1" }),
  ...["sửa sau baseline", "Hoà giải section stale", "User xác nhận giả định ở cổng chốt", "Hoà giải: user xác nhận nội dung không đổi"].map((reason, i) =>
    change({ txn: `c${i + 2}`, op: "set", step_id: null, reason, at: "2026-09-07T09:00:00.000Z", by: "u1" })
  )
]

const build = (spine: Spine, opts: { language?: "vi" | "en"; template?: TemplateLayout } = {}): Promise<RenderedDocument> =>
  _internal.buildDocument(
    {
      projectId: "650000000000000000000001",
      projectName: "FlintFlow",
      spine,
      statusChanges: [],
      recordChanges: RECORD,
      source: "draft",
      version: "v0.1",
      ...(opts.template ? { template: opts.template } : {}),
      ...(opts.language ? { language: opts.language } : {})
    },
    // Sơ đồ chưa có PNG ⇒ placeholder + caption "chờ ảnh" (cũng là chữ máy cần dịch)
    { loadDiagramPng: async () => null, now: () => new Date("2026-09-15T00:00:00.000Z") }
  )

const runText = (runs: InlineRun[]): string => runs.map((r) => r.text).join("")

/** Mọi chữ của tài liệu (để so giá trị Spine còn nguyên). */
const allText = (doc: RenderedDocument): string => {
  const out: string[] = []
  const block = (b: Block) => {
    if (b.type === "heading") out.push(b.text)
    else if (b.type === "paragraph") out.push(runText(b.runs))
    else if (b.type === "bullet_list" || b.type === "numbered_list") out.push(...b.items.map(runText))
    else if (b.type === "table") out.push(...b.header.map(runText), ...b.rows.flatMap((r) => r.map(runText)))
    else if (b.type === "image" && b.caption) out.push(b.caption)
  }
  for (const s of doc.sections) {
    out.push(s.heading)
    s.blocks.forEach(block)
  }
  for (const r of doc.recordOfChanges) out.push(r.in_charge, r.description)
  return out.join("\n")
}

/** Chỗ chỉ chứa chữ máy: tiêu đề mục cố định / nhóm, heading con, tiêu đề cột, nhãn đậm, chú thích hình, §I. */
const labelSlots = (doc: RenderedDocument): { headings: string[]; boldLabels: string[]; captions: string[]; record: string[] } => {
  const headings: string[] = []
  const boldLabels: string[] = []
  const captions: string[] = []
  for (const s of doc.sections) {
    if (s.id.startsWith("fixed:") || s.id.startsWith("group:")) headings.push(s.heading)
    for (const b of s.blocks) {
      if (b.type === "heading") headings.push(b.text)
      if (b.type === "table") headings.push(...b.header.map(runText))
      if (b.type === "image" && b.caption) captions.push(b.caption)
      const items = b.type === "paragraph" ? [b.runs] : b.type === "bullet_list" || b.type === "numbered_list" ? b.items : []
      for (const item of items) if (item[0]?.bold) boldLabels.push(item[0].text.replace(/: $/, ""))
    }
  }
  const record = doc.recordOfChanges.flatMap((r) => [r.in_charge, r.description])
  return { headings, boldLabels, captions, record }
}

/** Chữ tiếng Anh do máy sinh — gom từ chính các bảng nhãn (thêm nhãn mới vào bảng là test tự phủ). */
const ENGLISH_LABELS = new Set<string>([
  ...Object.keys(VI_FPT_LABELS),
  ...Object.values(GROUP_HEADINGS.en),
  ...FIXED_SECTIONS.map((s) => s.title_en),
  ASSEMBLE_TEXT.en.unassignedFunctions,
  ASSEMBLE_TEXT.en.systemInCharge,
  ASSEMBLE_TEXT.en.removedSection,
  RECORD_TEXT.en.baselineSigned,
  RECORD_TEXT.en.documentUpdated,
  ...loadStepRegistry().map((s) => s.phase_label_en)
])

describe("labels — bảng nhãn", () => {
  it("VI_LABELS / VI_SECTION_TITLES của mode 1 giữ nguyên 40 nhãn / 19 mục (thêm key là đổi bản in mode 1)", () => {
    expect(Object.keys(VI_LABELS)).toHaveLength(40)
    expect(Object.keys(VI_SECTION_TITLES)).toHaveLength(19)
    expect(labelFor("vi", "Use Case")).toBe("Use Case")
    expect(fptLabelFor("vi", "Use Case")).toBe("Use case")
    expect(fptLabelFor(undefined, "Use Case")).toBe("Use Case")
  })

  it("mọi nhãn tiếng Việt khác bản tiếng Anh (không có nhãn 'dịch' thành chính nó)", () => {
    for (const [en, vi] of Object.entries(VI_FPT_LABELS)) expect(vi, en).not.toBe(en)
    for (const key of Object.keys(GROUP_HEADINGS.en)) expect(GROUP_HEADINGS.vi[key], key).not.toBe(GROUP_HEADINGS.en[key])
  })

  it("mọi phase của step-registry (đóng băng) có nhãn tiếng Việt ở render; mọi section cố định có tiêu đề vi", () => {
    for (const phase of new Set(loadStepRegistry().map((s) => s.phase as string))) expect(VI_PHASE_LABELS[phase], phase).toBeTruthy()
    for (const s of FIXED_SECTIONS.filter((x) => x.id !== "fixed:I")) expect(VI_SECTION_TITLES[s.id], s.id).toBeTruthy()
  })

  it("enumLabel: vi tra bảng, giá trị lạ giữ nguyên; không có ngôn ngữ ⇒ giá trị thô", () => {
    expect(enumLabel("vi", "actor_kind", "human")).toBe(VI_ENUM_LABELS.actor_kind.human)
    expect(enumLabel("vi", "permission_action", "impersonate")).toBe("impersonate")
    expect(enumLabel(undefined, "priority", "must")).toBe("must")
  })

  it("WRITER_TEXT hai ngôn ngữ cùng bộ key, cùng số cột §I", () => {
    expect(Object.keys(WRITER_TEXT.vi).sort()).toEqual(Object.keys(WRITER_TEXT.en).sort())
    expect(WRITER_TEXT.vi.rocHeader).toHaveLength(WRITER_TEXT.en.rocHeader.length)
  })
})

describe("labels — fixture 19 màn qua đường mode 2 (mẫu FPT)", () => {
  it("language vi ⇒ không còn nhãn / tiêu đề / câu máy tiếng Anh nào ở chỗ chỉ chứa chữ máy", async () => {
    const vi = await build(spineForLabels(), { language: "vi" })
    const en = await build(spineForLabels())
    const slots = labelSlots(vi)

    // Bản tiếng Anh thật sự có những chữ đó — nếu không test này không kiểm gì
    const enSlots = labelSlots(en)
    expect([...enSlots.headings, ...enSlots.boldLabels, ...enSlots.record].filter((t) => ENGLISH_LABELS.has(t)).length).toBeGreaterThan(50)

    const leftovers = [...slots.headings, ...slots.boldLabels].filter((t) => ENGLISH_LABELS.has(t))
    expect(leftovers).toEqual([])
    // Chú thích hình: không còn đầu tiếng Anh, không còn câu "image pending"
    const englishCaptionHeads = [...ENGLISH_LABELS].filter((k) => k.length > 3)
    for (const caption of slots.captions) {
      expect(englishCaptionHeads.find((k) => caption === k || caption.startsWith(`${k} `)), caption).toBeUndefined()
      expect(caption).not.toContain("image pending")
    }
    expect(slots.captions.length).toBeGreaterThan(0)
    // §I: câu máy + người ghi "system"
    for (const text of slots.record) {
      expect(ENGLISH_LABELS.has(text), text).toBe(false)
      expect(text).not.toMatch(/^(Create|Update) |more change|signed$|reconciled|Edited after|Assumptions confirmed|Reviewed:/)
    }
    expect(vi.recordOfChanges.map((r) => r.description)).toContain("Customer asked to rename Login; Sửa sau baseline; Hoà giải các mục cần xem lại; và 2 thay đổi khác")

    // Chữ nối trong câu ghép
    const text = allText(vi)
    // Câu "Giao diện" (mô tả màn của fixture có cụm "screen: " là nội dung Spine — chỉ soát đầu câu)
    const interfaces = vi.sections.flatMap((s) =>
      s.blocks.flatMap((b) => (b.type === "bullet_list" ? b.items.filter((i) => i[0]?.text === "Giao diện: ").map((i) => runText(i.slice(1))) : []))
    )
    expect(interfaces.length).toBeGreaterThan(0)
    for (const sentence of interfaces) expect(sentence).toMatch(/^(Màn hình |Pop-up |Không có$)/)
    expect(text).not.toContain("(optional)")
    expect(text).not.toMatch(/(^|\n|, )has /)
    expect(text.split("\n")).not.toContain("N/A")
    expect(vi.sections.map((s) => s.heading)).toContain(ASSEMBLE_TEXT.vi.unassignedFunctions)
  })

  it("giá trị Spine (câu có khoảng trắng) có trong bản tiếng Anh thì vẫn nguyên văn trong bản tiếng Việt", async () => {
    const spine = spineForLabels()
    const enText = allText(await build(spine))
    const viText = allText(await build(spine, { language: "vi" }))
    const values = new Set<string>()
    const walk = (v: unknown, key = ""): void => {
      if (key === "puml" || key === "flags" || key === "steps") return
      if (typeof v === "string") {
        if (v.includes(" ") && v.trim().length >= 8) values.add(v.trim())
      } else if (Array.isArray(v)) v.forEach((x) => walk(x))
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k)
    }
    walk(spine)
    const shown = [...values].filter((v) => enText.includes(v))
    expect(shown.length).toBeGreaterThan(300)
    expect(shown.filter((v) => !viText.includes(v))).toEqual([])
  })

  it("ma trận phân quyền §3.1.3: tên vai trò trùng khoá nhãn (Actor, Data, Role) vẫn nguyên văn, chỉ cột Screen được dịch", async () => {
    const spine = spineForLabels()
    spine.roles[0].name = "Actor"
    spine.roles[1].name = "Data"
    spine.roles[2].name = "Role"
    const header = (doc: RenderedDocument) => {
      const table = doc.sections.find((s) => s.id === "fixed:3.1.3")?.blocks.find((b) => b.type === "table")
      return table?.type === "table" ? table.header.map(runText) : []
    }
    const names = spine.roles.map((r) => r.name)
    expect(header(await build(spine, { language: "vi" }))).toEqual(["Màn hình", ...names])
    expect(header(await build(spine))).toEqual(["Screen", ...names])
  })

  it("đọc cache (rehydrateImages) với language vi ⇒ chú thích placeholder tiếng Việt; không truyền ⇒ như cũ", async () => {
    // Bản cache giữ tham chiếu `diagram-ref:<id>` (chưa phân giải) — dựng tay một section có ảnh tham chiếu
    const base = await build(spineForLabels())
    const cached: RenderedDocument = {
      ...base,
      sections: [{ ...base.sections[0], blocks: [{ type: "image", png: "diagram-ref:D-FLOW", caption: "Screens Flow" }] }]
    }
    const caption = async (language?: string) => {
      const doc = await _internal.rehydrateImages(cached, "650000000000000000000001", async () => null, language)
      const b = doc.sections[0].blocks[0]
      return b.type === "image" ? b.caption : undefined
    }
    expect(await caption()).toBe(`Screens Flow — ${ASSEMBLE_TEXT.en.imagePending("D-FLOW")}`)
    expect(await caption("vi")).toBe(`Screens Flow — ${ASSEMBLE_TEXT.vi.imagePending("D-FLOW")}`)
    expect(await caption("vi")).not.toContain("image pending")
  })

  it("phụ lục cờ: tên mục cố định / mục đã xoá theo ngôn ngữ tài liệu", async () => {
    const spine = spineForLabels()
    const flag = (id: string, section_id: string): Spine["flags"][number] => ({
      id,
      level: "red",
      rule_id: "section_empty",
      section_id,
      message: "Section is empty",
      remediation_step: "S-8.1",
      opened_at_version: 1,
      resolved_at: null,
      waived_by_user: false,
      waive_reason: null,
      waived_at_version: null
    })
    spine.flags = [flag("FL1", "fixed:5.5"), flag("FL2", "custom:GONE")]
    const sections = async (language?: "vi") => (await build(spine, language ? { language } : {})).flagsAppendix?.redOpen.map((r) => r.section)
    expect(await sections("vi")).toEqual(["5.5 Thuật ngữ", ASSEMBLE_TEXT.vi.removedSection])
    expect(await sections()).toEqual(["5.5 Glossary", "(removed section)"])
  })

  it("không truyền ngôn ngữ = language en: tài liệu y hệt nhau (mode 2 hôm nay không đổi)", async () => {
    const spine = spineForLabels()
    expect(await build(spine, { language: "en" })).toEqual(await build(spine))
  })

  it("mode 1 (có layout file người dùng): language bị bỏ qua — tài liệu y hệt", async () => {
    const entry = (order: number, heading_text: string, level: number, section_id: string) => ({ order, heading_text, level, section_id })
    const template: TemplateLayout = {
      language: "vi",
      layout: [entry(0, "1 Giới thiệu", 1, "fixed:1"), entry(1, "2 Tác nhân", 1, "fixed:2.1"), entry(2, "3 Phân quyền", 1, "fixed:3.1.3")],
      legacyRecord: []
    }
    const spine = spineForLabels()
    const withLanguage = await build(spine, { template, language: "vi" })
    expect(withLanguage).toEqual(await build(spine, { template }))
    // Bằng chứng nhãn mới không lọt vào mode 1: ô actor kind vẫn là giá trị thô
    expect(JSON.stringify(withLanguage)).toContain('"text":"human"')
    expect(withLanguage.recordOfChanges.some((r) => /^Create /.test(r.description))).toBe(true)
  })
})

describe("labels — writerOptionsFor (FLF-265 §3.1)", () => {
  const sample = JSON.parse(readFileSync(new URL("../../../fixtures/rendered-document-sample.json", import.meta.url), "utf8")) as RenderedDocument

  it("mode 1 ⇒ đúng tuỳ chọn trước FLF-265, bỏ qua ngôn ngữ tài liệu", () => {
    for (const language of ["vi", "en", undefined] as const) expect(writerOptionsFor("import", language)).toEqual({ flagLanguage: "vi" })
  })

  it("mode 2 ⇒ writer + phụ lục cờ theo ngôn ngữ tài liệu; mặc định en", () => {
    expect(writerOptionsFor("fpt", "vi")).toEqual({ language: "vi", flagLanguage: "vi" })
    expect(writerOptionsFor("fpt", "en")).toEqual({ language: "en", flagLanguage: "en" })
    expect(writerOptionsFor(undefined)).toEqual({ language: "en", flagLanguage: "en" })
  })

  it("mode 2 en ra document.xml y hệt tuỳ chọn cũ; vi in bìa / mục lục tiếng Việt", async () => {
    const before = readZipText(await writeDocx(sample, { flagLanguage: "en" }), "word/document.xml")
    expect(readZipText(await writeDocx(sample, writerOptionsFor("fpt", "en")), "word/document.xml")).toBe(before)

    const vi = readZipText(await writeDocx(sample, writerOptionsFor("fpt", "vi")), "word/document.xml")
    expect(vi).toContain(WRITER_TEXT.vi.toc)
    expect(vi).toContain(WRITER_TEXT.vi.coverTitle)
    expect(vi).not.toContain(WRITER_TEXT.en.toc)
  })

  it("mode 1 ra document.xml y hệt { flagLanguage: vi } cũ", async () => {
    const before = readZipText(await writeDocx(sample, { flagLanguage: "vi" }), "word/document.xml")
    expect(readZipText(await writeDocx(sample, writerOptionsFor("import", "en")), "word/document.xml")).toBe(before)
  })
})
