/**
 * I-4 đọc song song nhiều section: cấp mã / ghép tên / lọc chạy ở bước ghép theo thứ tự tài liệu ⇒ kết quả trùng khít bản
 * tuần tự (golden chụp trước khi tách gọi AI khỏi xử lý) ở mọi mức song song và mọi điểm dừng / chạy tiếp. Mongo thật +
 * provider AI giả tất định theo (section, lô), trễ theo seed để thứ tự đọc xong xáo trộn.
 */
import { readFileSync } from "node:fs"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

const notifyTopUpNeeded = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("../../../src/modules/import/credit-flow.service.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/modules/import/credit-flow.service.js")>()),
  notifyTopUpNeeded
}))

/** Việc test chen vào lúc I-4 tải ảnh (trước lượt AI đọc ảnh); `null` = tải bình thường. */
const imageLoad = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }))
vi.mock("../../../src/modules/render/import-media.js", async (orig) => {
  const media = await orig<typeof import("../../../src/modules/render/import-media.js")>()
  return {
    ...media,
    loadImportImage: async (...args: Parameters<typeof media.loadImportImage>) => {
      await imageLoad.hook?.()
      return media.loadImportImage(...args)
    }
  }
})

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting, useExtractConcurrency, type Mode1Ctx } from "../../helpers/mode1-import-p4.js"
import { env } from "../../../src/config/env.js"
import { AI_BLOCK_CHARS, estimateExtraction, loadExtractionInputs, planPendingSections, runExtraction } from "../../../src/modules/import/extract.service.js"
import { ExtractionDraft, type ExtractionProgress } from "../../../src/modules/import/extraction-draft.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { buildPlaceholderPng } from "../../../src/modules/render/diagram-placeholder.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"

const GOLDEN = "./__snapshots__/extract-parallel.golden.json"

const sectionOf = (prompt: string) => /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?"
const isExtract = (prompt: string) => prompt.includes("# Import Extract") || prompt.includes("# Read Diagram Image")
/** Block thật đầu tiên của lô (bỏ ví dụ trong lời dẫn của prompt). */
const firstBlock = (prompt: string) => /\n\[(B\d{4,})\]/.exec(prompt.slice(prompt.indexOf("Blocks of the section")))?.[1] ?? "B0001"

/**
 * Output I-4 giả: `fakeMode1` + phần tử làm cấp mã phụ thuộc thứ tự — phần tử không mã (mới ở mỗi lô), một tác nhân
 * chung mọi section (section đầu cấp mã, section sau ghép tên), một khoá AI tự đặt (UC-90) đứng trước use case không mã,
 * và tác nhân "Guest" của ảnh được chữ 2.2.1 nhắc lại.
 */
const goldenMock = (prompt: string): string | undefined => {
  const base = fakeMode1(prompt)
  if (!base || !prompt.includes("# Import Extract")) return base
  const out = JSON.parse(base) as { items: object[] }
  const section = sectionOf(prompt)
  const b = firstBlock(prompt)
  const item = (entity: string, key: string | null, value: object, confidence = 0.8) => ({ entity, key, value, confidence, field_confidence: {}, source_block_ids: [b] })
  out.items.push(item("actors", null, { name: "Shared Persona", kind: "human" }))
  out.items.push(item("actors", null, { name: `Persona ${section} ${b}`, kind: "human" }))
  if (section === "fixed:1" && prompt.includes("MARK-P01")) out.items.push(item("use_cases", "UC-90", { name: "Self keyed flow", actor_ids: ["Shared Persona"] }))
  out.items.push(item("use_cases", null, { name: `Flow ${section} ${b}`, actor_ids: ["Shared Persona"] }))
  if (section === "fixed:2.2.1") out.items.push(item("actors", null, { name: "Guest", kind: "human" }, 0.7))
  return JSON.stringify(out)
}

const PNG = buildPlaceholderPng(12, 7, 0x40)
const SRS = {
  srs: {
    overviewParagraphs: Array.from(
      { length: 10 },
      (_, i) => `MARK-P${String(i + 1).padStart(2, "0")} ` + "Lumen keeps course material organised for small centres. ".repeat(Math.floor((AI_BLOCK_CHARS - 200) / 58))
    ),
    images: [
      { name: "image1.png", data: PNG, caption: "Figure 1 USECASE-IMG use case diagram" },
      { name: "image2.png", data: PNG, caption: "Figure 2 Context diagram" }
    ]
  }
}

/** Drafts so được giữa các lượt chạy: usage quy về step của nó (id usage mỗi lượt một khác). */
const snapshot = async (importId: string) => {
  const drafts = await ExtractionDraft.find({ import_id: importId }).sort({ section_id: 1 }).lean()
  const usages = new Map((await Usage.find({ _id: { $in: drafts.map((d) => d.usage_id).filter(Boolean) } }).lean()).map((u) => [String(u._id), `${u.step_id} ${u.call_kind}`]))
  return drafts.map((d) => ({
    section_id: d.section_id,
    status: d.status,
    error: d.error,
    usage: d.usage_id ? (usages.get(d.usage_id) ?? "?") : null,
    unmapped: d.unmapped_block_ids,
    images: d.diagram_images,
    partial: d.partial,
    fields: d.fields
  }))
}

const golden = async (ctx: Mode1Ctx) => expect(JSON.stringify(await snapshot(ctx.importId), null, 2)).toMatchFileSnapshot(GOLDEN)

/** Lỗi mạng: FLF-360 coi là tạm thời (đọc lại lô sau giãn cách), `executeAiAction` không thử lại trong lượt gọi. */
const networkError = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Trễ tất định theo lượt (section + block / ảnh đầu của lượt) — thứ tự xong xáo trộn nhưng lặp lại được. */
const seededDelay = (prompt: string): number => {
  const key = `${sectionOf(prompt)}|${/Image block: \[(B\d+)\]/.exec(prompt)?.[1] ?? firstBlock(prompt)}`
  let h = 17
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 10_007
  return 30 + (h % 120)
}

/** Lượt bắt đầu (vào provider) / trả lời xong, số lượt đang bay. Hết credit thì không tới provider ⇒ không tính. */
let starts: string[] = []
/** Số lượt đọc ảnh đã tới provider. */
let imageStarts = 0
let calls: string[] = []
let inFlight = 0
let peak = 0
/** Trễ của lượt (mặc định theo seed), việc test chen giữa lượt (ghi DB…, chạy sau trễ) và câu trả lời. */
let delayOf: (prompt: string) => number = seededDelay
let during: ((prompt: string) => Promise<void>) | null = null
let reply: (prompt: string) => string | Error | undefined = goldenMock

beforeEach(() => {
  resetMockLlm()
  notifyTopUpNeeded.mockClear()
  starts = []
  imageStarts = 0
  imageLoad.hook = null
  calls = []
  inFlight = 0
  peak = 0
  delayOf = seededDelay
  during = null
  reply = goldenMock
  mockOverrides.before = async (prompt) => {
    if (!isExtract(prompt)) return
    starts.push(sectionOf(prompt))
    if (prompt.includes("# Read Diagram Image")) imageStarts++
    peak = Math.max(peak, ++inFlight)
    await sleep(delayOf(prompt))
    await during?.(prompt)
  }
  mockOverrides.next = (prompt) => {
    if (!isExtract(prompt)) return goldenMock(prompt)
    inFlight--
    calls.push(sectionOf(prompt))
    return reply(prompt)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const deductedI4 = (ctx: Mode1Ctx) => Usage.countDocuments({ projectId: ctx.projectId, step_id: /^I-4:/, state: "deducted" })
const estimateOf = async (ctx: Mode1Ctx) => (await estimateExtraction(ctx.projectId, { _id: ctx.importId } as never))!.ai_calls
const draftsOf = async (ctx: Mode1Ctx) => ExtractionDraft.find({ import_id: ctx.importId }).lean()
const resume = async (ctx: Mode1Ctx) => {
  await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { paused: null } })
  return runExtraction(ctx.projectId, ctx.userId, ctx.importId)
}
/** Số lượt AI theo kế hoạch của từng section. */
const stepsPerSection = async (ctx: Mode1Ctx): Promise<Map<string, number>> => {
  const inputs = (await loadExtractionInputs(ctx.projectId))!
  return new Map(planPendingSections(inputs.plan, inputs.blocks, inputs.profile, inputs.provisional, new Set()).map((p) => [p.section_id, p.steps.length]))
}
const isFixed1Batch = (prompt: string, mark: string) => sectionOf(prompt) === "fixed:1" && prompt.includes("# Import Extract") && prompt.includes(`MARK-${mark}`)
const savedRawSteps = async (ctx: Mode1Ctx) => (await draftsOf(ctx)).reduce((n, d) => n + ((d.partial as ExtractionProgress | null)?.raw_steps?.length ?? 0), 0)

type LegacyItem = { entity: string; id: string | null; value: Record<string, unknown>; confidence: number; field_confidence: object; source_block_ids: string[]; origin: string }

describe("I-4 — golden (kết quả bản tuần tự)", () => {
  useExtractConcurrency(1)

  it("chạy một mạch ⇒ drafts trùng golden; số lượt AI = số usage đã trừ = ước tính", async () => {
    const ctx = await importAtExtracting(SRS)
    const estimate = await estimateOf(ctx)
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("baselining")
    await golden(ctx)
    expect(await deductedI4(ctx)).toBe(calls.length)
    expect(calls).toHaveLength(estimate)
    expect(peak).toBe(1)
  }, 60_000)

  it("chạy tiếp từ tiến độ dạng cũ (phần tử đã cấp mã, trước FLF-392) ⇒ không gọi lại lô đã xong, kết quả trùng golden", async () => {
    const ctx = await importAtExtracting(SRS)
    reply = (prompt) => (isFixed1Batch(prompt, "P05") ? new Error("provider down") : goldenMock(prompt))
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(first.doc.paused?.reason).toBe("resume_later")
    const draft = (await ExtractionDraft.findOne({ import_id: ctx.importId, section_id: "fixed:1" }).lean())!
    const progress = draft.partial as ExtractionProgress
    expect(progress.raw_steps).toHaveLength(1)

    // Dựng lại tiến độ như bản cũ lưu sau lô 1: phần tử của lô 1 (đã cấp mã) — lấy từ golden, nguồn có block đầu của lô 1
    const goldenFixed1 = (JSON.parse(readFileSync(new URL(GOLDEN, import.meta.url), "utf8")) as Awaited<ReturnType<typeof snapshot>>).find((d) => d.section_id === "fixed:1")!
    const batch1 = goldenFixed1.fields.find((f) => f.path === "actors[id=A04].name")!.source_block_ids[0]
    const items = new Map<string, LegacyItem>()
    for (const f of goldenFixed1.fields.filter((x) => x.source_block_ids.includes(batch1))) {
      const m = /^(?:project\.(\w+)|(\w+)\[id=([^\]]+)\]\.(\w+))$/.exec(f.path)!
      const [entity, id, field] = m[1] ? ["project", null, m[1]] : [m[2], m[3], m[4]]
      const key = `${entity}|${id}`
      const it = items.get(key) ?? { entity, id, value: {}, confidence: f.confidence, field_confidence: {}, source_block_ids: [batch1], origin: f.origin }
      it.value[field] = f.value
      items.set(key, it)
    }
    const legacy = { plan_hash: progress.plan_hash, steps_done: 1, items: [...items.values()], unmapped_block_ids: [], diagram_images: [], usage_id: progress.raw_steps![0].usage_id }
    await ExtractionDraft.updateOne({ _id: draft._id }, { $set: { partial: legacy } })

    starts = []
    reply = goldenMock
    const resumed = await resume(ctx)
    expect(resumed.doc.status).toBe("baselining")
    expect(starts.filter((s) => s === "fixed:1")).toHaveLength(2)
    await golden(ctx)
  }, 60_000)
})

describe("I-4 — song song (IMPORT_EXTRACT_CONCURRENCY = 4)", () => {
  useExtractConcurrency(4)

  it("thứ tự đọc xong xáo trộn ⇒ drafts trùng golden; số lượt / credit không đổi; thật sự chạy chồng nhau", async () => {
    const ctx = await importAtExtracting(SRS)
    const estimate = await estimateOf(ctx)
    delayOf = (prompt) => 120 + (seededDelay(prompt) - 30)
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc).toMatchObject({ status: "baselining", extract_cursor: null, reread: null })
    await golden(ctx)
    expect(calls).toHaveLength(estimate)
    expect(await deductedI4(ctx)).toBe(estimate)
    expect(peak).toBeGreaterThanOrEqual(3)
    expect(peak).toBeLessThanOrEqual(env.IMPORT_EXTRACT_CONCURRENCY)
  }, 60_000)

  it("Dừng khi nhiều section đang đọc ⇒ paused user, không lượt nào bắt đầu sau đó; chạy tiếp không gọi lại lượt đã lưu, trùng golden", async () => {
    const ctx = await importAtExtracting(SRS)
    const estimate = await estimateOf(ctx)
    let startsAtStop = -1
    let flyingAtStop = 0
    // Lượt mục 1 20ms, section khác 400ms ⇒ lúc bấm Dừng (cuối lô 2 của mục 1) các section khác đang giữa lượt đầu — lần
    // kiểm cờ kế tiếp của chúng chắc chắn sau lệnh ghi. (Worker đã kiểm cờ trước lệnh ghi mà đang giữ credit thì vẫn mở lượt
    // đó — như bản tuần tự, cờ chỉ kiểm trước mỗi lượt.)
    delayOf = (prompt) => (sectionOf(prompt) === "fixed:1" ? 20 : 400)
    during = async (prompt) => {
      if (startsAtStop >= 0 || !isFixed1Batch(prompt, "P05")) return
      await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { paused: { reason: "user", at: new Date() } } })
      startsAtStop = starts.length
      flyingAtStop = inFlight
    }
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(first.doc.paused?.reason).toBe("user")
    expect(flyingAtStop).toBeGreaterThanOrEqual(2)
    expect(starts).toHaveLength(startsAtStop)
    expect(inFlight).toBe(0)
    // lượt đang bay lúc dừng chạy xong và được lưu; section đọc dở giữ output thô
    const fixed1 = (await ExtractionDraft.findOne({ import_id: ctx.importId, section_id: "fixed:1" }).lean())!
    expect(fixed1).toMatchObject({ status: "pending", partial: { steps_done: 2 } })
    expect(first.doc.extract_cursor).toBe("fixed:1")
    const saved = await savedRawSteps(ctx)
    expect(await deductedI4(ctx)).toBe(saved)
    expect(await estimateOf(ctx)).toBe(estimate - saved)

    const resumed = await resume(ctx)
    expect(resumed.doc.status).toBe("baselining")
    expect(await deductedI4(ctx)).toBe(estimate)
    await golden(ctx)
  }, 60_000)

  it("hết credit giữa chừng ⇒ paused credits, một thông báo nạp; credit trừ = lượt đã lưu; nạp + chạy tiếp ⇒ trùng golden", async () => {
    const ctx = await importAtExtracting({ ...SRS, balance: 7 })
    const estimate = await estimateOf(ctx)
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(first.doc.paused?.reason).toBe("credits")
    expect((await ImportedDocument.findById(ctx.importId).lean())!.paused?.reason).toBe("credits")
    expect(notifyTopUpNeeded).toHaveBeenCalledTimes(1)
    const completed = starts.length
    expect(completed).toBeGreaterThanOrEqual(4)
    expect(completed).toBeLessThan(estimate)
    expect(await deductedI4(ctx)).toBe(completed)
    expect(await savedRawSteps(ctx)).toBe(completed)
    expect(await estimateOf(ctx)).toBe(estimate - completed)
    const w = (await CreditWallet.findOne({ userId: ctx.userId }).lean())!
    expect(w.reserved).toBe(0)
    expect(w.balance).toBeLessThan(2)

    await CreditWallet.updateOne({ userId: ctx.userId }, { $set: { balance: 1000 } })
    const resumed = await resume(ctx)
    expect(resumed.doc.status).toBe("baselining")
    expect(await deductedI4(ctx)).toBe(estimate)
    await golden(ctx)
  }, 60_000)

  it("nạp credit trong lúc các section khác đang dừng dần (job còn chạy) ⇒ chạy tiếp ngay trong job, trùng golden", async () => {
    const ctx = await importAtExtracting({ ...SRS, balance: 9 })
    const estimate = await estimateOf(ctx)
    // mục 1 nhanh ⇒ lô 2 của nó hết credit (4 lượt đầu giữ 8 credit) khi 3 section khác còn đang gọi AI; nạp tiền lúc đó
    delayOf = (prompt) => (sectionOf(prompt) === "fixed:1" ? 5 : 200)
    let toppedUp = false
    during = async () => {
      if (toppedUp || (await ImportedDocument.findById(ctx.importId).lean())!.paused?.reason !== "credits") return
      toppedUp = true
      await CreditWallet.updateOne({ userId: ctx.userId }, { $inc: { balance: 1000 } })
    }
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(toppedUp).toBe(true)
    expect(run.doc).toMatchObject({ status: "baselining", paused: null })
    expect(notifyTopUpNeeded).toHaveBeenCalledTimes(1)
    expect(await deductedI4(ctx)).toBe(estimate)
    await golden(ctx)
  }, 60_000)

  it("section khác thấy Dừng trong lúc một section đang tải ảnh ⇒ lượt đọc ảnh không bắt đầu dù ví đủ tiền; chạy tiếp ⇒ trùng golden", async () => {
    const ctx = await importAtExtracting(SRS)
    const estimate = await estimateOf(ctx)
    // Lần tải ảnh đầu: bấm Dừng rồi giữ ảnh lâu hơn mọi lượt của section khác (≤ 150ms) ⇒ section khác kiểm cờ trước lượt
    // kế tiếp và bật tín hiệu dừng chung trước khi ảnh tải xong. Ví vẫn đủ ⇒ chỉ tín hiệu dừng chặn được lượt đọc ảnh
    let loads = 0
    imageLoad.hook = async () => {
      if (loads++) return
      await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { paused: { reason: "user", at: new Date() } } })
      await sleep(600)
    }
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(loads).toBeGreaterThan(0)
    expect(run.doc.paused?.reason).toBe("user")
    expect(imageStarts).toBe(0)
    expect(await deductedI4(ctx)).toBe(await savedRawSteps(ctx))

    imageLoad.hook = null
    const resumed = await resume(ctx)
    expect(resumed.doc.status).toBe("baselining")
    expect(await deductedI4(ctx)).toBe(estimate)
    await golden(ctx)
  }, 60_000)

  it("FLF-360 khi song song: hai section quá tải cùng lúc đều đọc lại lô của mình ⇒ trùng golden, credit chỉ trừ lượt đọc được", async () => {
    const backoff = env.IMPORT_AI_RETRY_BACKOFF_MS
    env.IMPORT_AI_RETRY_BACKOFF_MS = [150, 150]
    try {
      const ctx = await importAtExtracting(SRS)
      const estimate = await estimateOf(ctx)
      // lượt đầu của mục 1 và của 3.1.2 lỗi mạng (tạm thời, không thử lại trong lượt gọi) ⇒ mỗi section đọc lại một vòng
      const failures = new Map([["fixed:1", 1], ["fixed:3.1.2", 1]])
      const seen = new Set<string>()
      const watch = setInterval(() => {
        void ImportedDocument.findById(ctx.importId, { reread: 1 })
          .lean()
          .then((d) => d?.reread && seen.add(d.reread.section_id))
      }, 20)
      reply = (prompt) => {
        const left = prompt.includes("# Import Extract") ? (failures.get(sectionOf(prompt)) ?? 0) : 0
        if (!left) return goldenMock(prompt)
        failures.set(sectionOf(prompt), left - 1)
        return networkError()
      }
      const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId).finally(() => clearInterval(watch))
      expect(run.doc).toMatchObject({ status: "baselining", reread: null })
      expect([...seen].every((s) => s === "fixed:1" || s === "fixed:3.1.2")).toBe(true)
      expect(seen.has("fixed:1")).toBe(true)
      expect(starts).toHaveLength(estimate + 2)
      expect(await deductedI4(ctx)).toBe(estimate)
      await golden(ctx)
    } finally {
      env.IMPORT_AI_RETRY_BACKOFF_MS = backoff
    }
  }, 60_000)

  it("Dừng trong lúc chờ đọc lại ⇒ bỏ ngang giãn cách, không gọi lại lô; chạy tiếp từ đúng lô đó", async () => {
    const backoff = env.IMPORT_AI_RETRY_BACKOFF_MS
    env.IMPORT_AI_RETRY_BACKOFF_MS = [600, 600, 600]
    try {
      const ctx = await importAtExtracting(SRS)
      const estimate = await estimateOf(ctx)
      let stoppedAt = -1
      reply = (prompt) => {
        if (!isFixed1Batch(prompt, "P01")) return goldenMock(prompt)
        // lần lỗi đầu ⇒ người dùng bấm Dừng trong lúc job chờ đọc lại
        if (stoppedAt < 0) {
          stoppedAt = 0
          void ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { paused: { reason: "user", at: new Date() } } }).then(() => (stoppedAt = starts.length))
        }
        return networkError()
      }
      const t0 = Date.now()
      const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
      expect(first.doc).toMatchObject({ paused: { reason: "user" }, reread: null })
      // 3 vòng × 600ms nếu không bỏ ngang
      expect(Date.now() - t0).toBeLessThan(1_500)
      expect(starts.filter((s) => s === "fixed:1")).toHaveLength(1)
      expect(starts.length).toBeLessThanOrEqual(stoppedAt + 3)

      reply = goldenMock
      starts = []
      const resumed = await resume(ctx)
      expect(resumed.doc.status).toBe("baselining")
      expect(await deductedI4(ctx)).toBe(estimate)
      await golden(ctx)
    } finally {
      env.IMPORT_AI_RETRY_BACKOFF_MS = backoff
    }
  }, 60_000)

  it("chạy tiếp section đã đọc xong mà chưa ghép ⇒ ghép luôn, 0 lượt AI", async () => {
    const ctx = await importAtExtracting(SRS)
    const estimate = await estimateOf(ctx)
    const steps = await stepsPerSection(ctx)
    // mục 1 chậm, lô 2 lỗi ⇒ các section phía sau đọc xong trong lúc đó nhưng không được ghép (mục 1 chưa xong)
    delayOf = (prompt) => (sectionOf(prompt) === "fixed:1" ? 120 : 5)
    reply = (prompt) => (isFixed1Batch(prompt, "P05") ? new Error("provider down") : goldenMock(prompt))
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(first.doc.paused?.reason).toBe("resume_later")
    const readOnly = (await draftsOf(ctx))
      .filter((d) => d.status !== "done" && d.partial && (d.partial as ExtractionProgress).steps_done === steps.get(d.section_id))
      .map((d) => d.section_id)
    expect(readOnly.length).toBeGreaterThanOrEqual(1)

    starts = []
    reply = goldenMock
    const resumed = await resume(ctx)
    expect(resumed.doc.status).toBe("baselining")
    expect(starts.filter((s) => readOnly.includes(s))).toEqual([])
    expect(await deductedI4(ctx)).toBe(estimate)
    await golden(ctx)
  }, 60_000)

  it("Dừng và hết credit cùng lúc ⇒ paused vẫn là user (credit không đè), không báo nạp", async () => {
    const ctx = await importAtExtracting({ ...SRS, balance: 0 })
    // Người dùng bấm Dừng ngay khi lượt chạy bắt đầu nhưng job đọc cờ trước khi lệnh ghi tới (các worker vẫn mở lượt) — lượt
    // hết credit sau đó ghi `paused` có điều kiện thì phải giữ `user`
    const realFindById = ImportedDocument.findById.bind(ImportedDocument) as (...a: unknown[]) => unknown
    const realUpdateOne = ImportedDocument.updateOne.bind(ImportedDocument) as (...a: unknown[]) => unknown
    let hide = true
    let wrote = false
    vi.spyOn(ImportedDocument, "findById").mockImplementation(((id: unknown, projection?: Record<string, unknown>, ...rest: unknown[]) => {
      if (!hide || projection?.paused !== 1) return realFindById(id, projection, ...rest)
      return {
        lean: async () => {
          if (!wrote) {
            wrote = true
            await realUpdateOne({ _id: ctx.importId }, { $set: { paused: { reason: "user", at: new Date() } } })
          }
          return { _id: id, paused: null }
        }
      }
    }) as never)
    vi.spyOn(ImportedDocument, "updateOne").mockImplementation(((filter: Record<string, unknown>, ...rest: unknown[]) => {
      if ("paused" in filter && filter.paused === null) hide = false
      return realUpdateOne(filter, ...rest)
    }) as never)

    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(wrote).toBe(true)
    expect(hide).toBe(false)
    expect(first.doc.paused?.reason).toBe("user")
    expect((await ImportedDocument.findById(ctx.importId).lean())!.paused?.reason).toBe("user")
    expect(notifyTopUpNeeded).not.toHaveBeenCalled()
    expect(await deductedI4(ctx)).toBe(0)
  }, 60_000)

  it("exception trong một worker ⇒ job ném sau khi mọi worker đã dừng; chạy lại không gọi AI cho lượt đã lưu, trùng golden", async () => {
    const ctx = await importAtExtracting(SRS)
    const estimate = await estimateOf(ctx)
    const realSave = ExtractionDraft.prototype.save as (...a: unknown[]) => Promise<unknown>
    let thrown = false
    vi.spyOn(ExtractionDraft.prototype, "save").mockImplementation(function (this: InstanceType<typeof ExtractionDraft>, ...args: unknown[]) {
      const progress = this.partial as ExtractionProgress | null
      if (!thrown && this.section_id === "fixed:3.1.2" && progress?.raw_steps?.length === 1) {
        thrown = true
        return Promise.reject(new Error("disk full"))
      }
      return realSave.apply(this, args)
    } as never)

    await expect(runExtraction(ctx.projectId, ctx.userId, ctx.importId)).rejects.toThrow("disk full")
    expect(thrown).toBe(true)
    expect(inFlight).toBe(0)
    const startsAtThrow = starts.length
    await sleep(200)
    expect(starts).toHaveLength(startsAtThrow)

    vi.restoreAllMocks()
    const again = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(again.doc.status).toBe("baselining")
    // chỉ lượt lưu hỏng được gọi lại (lần trước đã trừ credit cho nó)
    expect(await deductedI4(ctx)).toBe(estimate + 1)
    await golden(ctx)
  }, 60_000)
})
