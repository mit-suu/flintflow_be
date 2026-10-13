import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  getSpine: vi.fn(),
  getActionCost: vi.fn(async (_actionType: string) => 2),
  executeAiAction: vi.fn()
}))

vi.mock("./translation.repository.js", async () => (await import("./__tests__/translation-store.js")).fakeRepository)
vi.mock("../spine/spine.repository.js", async (importOriginal) => ({ ...(await importOriginal<object>()), get: mocks.getSpine }))
vi.mock("../import/template-profile.model.js", () => ({ TemplateProfile: { findOne: () => ({ lean: async () => null }) } }))
vi.mock("../../shared/ai/credit-reservation.service.js", () => ({ getActionCost: mocks.getActionCost }))
vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: mocks.executeAiAction }))

import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { ActionType, AiActionError, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { parseResponse, type TranslateDocumentOutput } from "../../shared/ai/response-parser.js"
import { translationRunResponseSchema } from "../pipeline/pipeline.dto.js"
import { fakeRepository, resetStore, store } from "./__tests__/translation-store.js"
import { hashSource, translationUnits } from "./translation-units.js"
import { acceptBatchItems, defaultTranslateDocumentExecutor, runTranslation, TRANSLATION_RUNNING, type TranslateDocumentExecutor } from "./translation-run.service.js"
import { BATCH_MAX_UNITS } from "./translation.service.js"

const PROJECT = "64b000000000000000000001"
const USER = "64b000000000000000000002"
const VI = { mode: "fpt" as const, documentLanguage: "vi" as const }

/** Spine giả: `n` business rule (mỗi rule một đơn vị) + vài tên để học glossary. */
const spineWith = (n: number): Spine => {
  const spine = createEmptySpine({ name: "Lumen" })
  spine.business_rules = Array.from({ length: n }, (_, i) => ({ id: `BR${i + 1}`, tier: "detail" as const, statement: `Rule number ${i + 1} for the Order.`, source_validation_ids: [] }))
  return spine
}

type Items = TranslateDocumentOutput["items"]

const itemsOf = (input: AiActionInput): { key: string; text: string | string[] }[] => JSON.parse(input.promptVariables?.items as string)

const result = (items: Items): AiActionResult<TranslateDocumentOutput> =>
  ({ success: true, data: { items }, rawText: "", cost: 2 }) as unknown as AiActionResult<TranslateDocumentOutput>

/** Provider giả: "dịch" mọi item bằng tiền tố `[vi] `. */
const echo = (transform: (items: Items) => Items = (x) => x): TranslateDocumentExecutor =>
  vi.fn(async (input: AiActionInput) =>
    result(transform(itemsOf(input).map(({ key, text }) => ({ key, text: Array.isArray(text) ? text.map((t) => `[vi] ${t}`) : `[vi] ${text}` }))))
  )

const stored = (value: string | string[]) => store.translations.get(`${PROJECT}|vi|${hashSource(value)}`)

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("runTranslation — chia lô, chỉ phần thiếu", () => {
  it("dịch tối đa max_batches lô (mặc định 5), trả translated / remaining / credits_used", async () => {
    const spine = spineWith(BATCH_MAX_UNITS * 6 + 3)
    mocks.getSpine.mockResolvedValue(spine)
    const executor = echo()

    const first = await runTranslation(PROJECT, USER, VI, {}, executor)
    const total = translationUnits(spine).length

    expect(executor).toHaveBeenCalledTimes(5)
    expect(first).toEqual({ translated: BATCH_MAX_UNITS * 5, remaining: total - BATCH_MAX_UNITS * 5, credits_used: 10 })
    expect(translationRunResponseSchema.parse(first)).toEqual(first)
    expect(stored(spine.business_rules[0].statement)).toMatchObject({ text: "[vi] Rule number 1 for the Order.", origin: "machine" })

    // Lượt sau chỉ gửi phần còn thiếu
    const second = await runTranslation(PROJECT, USER, VI, { max_batches: 10 }, executor)
    expect(second).toEqual({ translated: total - BATCH_MAX_UNITS * 5, remaining: 0, credits_used: 4 })
    const sentKeys = (executor as ReturnType<typeof vi.fn>).mock.calls.slice(5).flatMap(([input]) => itemsOf(input as AiActionInput).map((i) => i.key))
    expect(sentKeys).not.toContain("business_rules[id=BR1].statement")
  })

  it("lô chỉ gửi {key, text} + glossary con + ngôn ngữ — không nạp Spine", async () => {
    const spine = spineWith(2)
    spine.glossary = [
      { id: "G01", term: "Order", term_native: "Đơn hàng", definition: "A purchase." },
      { id: "G02", term: "Invoice", term_native: "Hoá đơn", definition: "A bill." }
    ]
    mocks.getSpine.mockResolvedValue(spine)
    // Thuật ngữ đã học từ trước nhưng không có trong lô ⇒ không vào prompt
    store.glossary.set(`${PROJECT}|vi|Refund`, { term: "Refund", translation: "Hoàn tiền", origin: "model" })
    const executor = echo()

    await runTranslation(PROJECT, USER, VI, {}, executor)

    const [input, projectId, userId] = (executor as ReturnType<typeof vi.fn>).mock.calls[0] as [AiActionInput, string, string]
    expect([projectId, userId]).toEqual([PROJECT, USER])
    expect(Object.keys(input.promptVariables ?? {}).sort()).toEqual(["glossary", "items", "source_language", "target_language"])
    expect(input.promptVariables).toMatchObject({ source_language: "English", target_language: "Vietnamese" })
    // Glossary con: chỉ thuật ngữ có mặt trong chữ của lô
    expect(input.promptVariables?.glossary).toContain("- Order → Đơn hàng")
    expect(input.promptVariables?.glossary).not.toContain("Refund")
    expect(itemsOf(input).every((i) => Object.keys(i).sort().join() === "key,text")).toBe(true)
    expect(JSON.stringify(input)).not.toContain("spine_version")
  })

  it("ngôn ngữ = gốc ⇒ không làm gì, không gọi model", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(3))
    const executor = echo()
    await expect(runTranslation(PROJECT, USER, { mode: "fpt", documentLanguage: "en" }, {}, executor)).resolves.toEqual({ translated: 0, remaining: 0, credits_used: 0 })
    expect(executor).not.toHaveBeenCalled()
    expect(mocks.getSpine).not.toHaveBeenCalled()
  })

  it("không còn gì thiếu ⇒ không gọi model", async () => {
    const spine = spineWith(2)
    mocks.getSpine.mockResolvedValue(spine)
    await runTranslation(PROJECT, USER, VI, {}, echo())
    const executor = echo()
    await expect(runTranslation(PROJECT, USER, VI, {}, executor)).resolves.toEqual({ translated: 0, remaining: 0, credits_used: 0 })
    expect(executor).not.toHaveBeenCalled()
  })
})

describe("runTranslation — kết quả lỗi", () => {
  it("lỗi parse ở lô đầu ⇒ ném ra, không ghi gì", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(3))
    const executor: TranslateDocumentExecutor = vi.fn(async () => {
      throw new AiActionError(422, "AI trả về dữ liệu không đúng định dạng", "AI_PARSE_ERROR")
    })
    await expect(runTranslation(PROJECT, USER, VI, {}, executor)).rejects.toMatchObject({ code: "AI_PARSE_ERROR" })
    expect(store.translations.size).toBe(0)
  })

  it("402 giữa chừng ⇒ dừng, trả số đã dịch; 402 ngay lô đầu ⇒ ném INSUFFICIENT_CREDIT", async () => {
    const spine = spineWith(BATCH_MAX_UNITS * 3)
    mocks.getSpine.mockResolvedValue(spine)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const ok = echo()
    let calls = 0
    const executor: TranslateDocumentExecutor = vi.fn(async (input, projectId, userId) => {
      calls++
      if (calls === 2) throw new AiActionError(402, "Không đủ credit", "INSUFFICIENT_CREDIT")
      return ok(input, projectId, userId)
    })

    const partial = await runTranslation(PROJECT, USER, VI, {}, executor)
    expect(executor).toHaveBeenCalledTimes(2)
    expect(partial).toEqual({ translated: BATCH_MAX_UNITS, remaining: BATCH_MAX_UNITS * 2, credits_used: 2 })

    const broke: TranslateDocumentExecutor = vi.fn(async () => {
      throw new AiActionError(402, "Không đủ credit", "INSUFFICIENT_CREDIT")
    })
    await expect(runTranslation(PROJECT, USER, VI, {}, broke)).rejects.toMatchObject({ statusCode: 402, code: "INSUFFICIENT_CREDIT" })
  })

  it("mảng sai độ dài, key lạ, thiếu key, sai kiểu ⇒ bỏ đúng đơn vị đó", async () => {
    const spine = createEmptySpine({ name: "Lumen" })
    spine.functions = [
      {
        id: "FN1", screen_id: null, feature_id: "F1", order: 0, name: "Place Order", trigger: "User clicks Buy.", description: "Creates an order.",
        normal: ["Step one.", "Step two."], abnormal: ["Payment fails."], validations: [], business_rule_ids: [], priority: null
      }
    ]
    mocks.getSpine.mockResolvedValue(spine)
    const executor = echo((items) => [
      ...items.map((i) => (i.key === "functions[id=FN1].normal" ? { ...i, text: ["Chỉ một bước"] } : i)) // sai độ dài
        .filter((i) => i.key !== "functions[id=FN1].description") // thiếu key
        .map((i) => (i.key === "functions[id=FN1].abnormal" ? { ...i, text: "không phải mảng" } : i)), // sai kiểu
      { key: "functions[id=FN9].name", text: "Key lạ" }
    ])

    const res = await runTranslation(PROJECT, USER, VI, {}, executor)

    expect(res).toEqual({ translated: 2, remaining: 3, credits_used: 2 })
    expect(stored("Place Order")?.text).toBe("[vi] Place Order")
    expect(stored("User clicks Buy.")?.text).toBe("[vi] User clicks Buy.")
    expect(stored(["Step one.", "Step two."])).toBeUndefined()
    expect(stored(["Payment fails."])).toBeUndefined()
    expect(stored("Creates an order.")).toBeUndefined()
    expect([...store.translations.values()].some((t) => t.text === "Key lạ")).toBe(false)
  })

  it("machine không đè author", async () => {
    const spine = spineWith(2)
    mocks.getSpine.mockResolvedValue(spine)
    const statement = spine.business_rules[0].statement
    // Bản author đến giữa lúc tra và lúc ghi (lượt AI ghi Spine trả kèm chạy song song)
    fakeRepository.findByHashes.mockImplementationOnce(async () => {
      store.translations.set(`${PROJECT}|vi|${hashSource(statement)}`, { sourceHash: hashSource(statement), text: "Bản author", origin: "author", sourceLocale: "en" })
      return new Map()
    })

    await runTranslation(PROJECT, USER, VI, {}, echo())

    expect(stored(statement)).toMatchObject({ text: "Bản author", origin: "author" })
    expect(stored(spine.business_rules[1].statement)).toMatchObject({ origin: "machine" })
  })
})

describe("runTranslation — lô hỏng, không tiến, lỗi ghi", () => {
  const parseError = () => new AiActionError(422, "AI response failed Zod schema validation", "SCHEMA_MISMATCH")

  /** Executor: các lô thứ `bad` (đếm từ 1) parse lỗi, còn lại dịch bình thường. */
  const failingAt = (...bad: number[]): TranslateDocumentExecutor => {
    const ok = echo()
    let calls = 0
    return vi.fn(async (input, projectId, userId) => {
      calls++
      if (bad.includes(calls)) throw parseError()
      return ok(input, projectId, userId)
    })
  }

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("parse lỗi ở lô 1 ⇒ bỏ lô đó, vẫn dịch lô 2, 3; lô hỏng không trả credit", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(BATCH_MAX_UNITS * 3))
    const executor = failingAt(1)
    const res = await runTranslation(PROJECT, USER, VI, {}, executor)
    expect(executor).toHaveBeenCalledTimes(3)
    expect(res).toEqual({ translated: BATCH_MAX_UNITS * 2, remaining: BATCH_MAX_UNITS, credits_used: 4 })
    expect(stored("Rule number 1 for the Order.")).toBeUndefined()
    expect(stored(`Rule number ${BATCH_MAX_UNITS + 1} for the Order.`)).toMatchObject({ origin: "machine" })
  })

  it("parse lỗi ở lô 2 ⇒ lô 3 vẫn được dịch", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(BATCH_MAX_UNITS * 3))
    const res = await runTranslation(PROJECT, USER, VI, {}, failingAt(2))
    expect(res).toEqual({ translated: BATCH_MAX_UNITS * 2, remaining: BATCH_MAX_UNITS, credits_used: 4 })
    expect(stored(`Rule number ${BATCH_MAX_UNITS * 2 + 1} for the Order.`)).toMatchObject({ origin: "machine" })
  })

  it("mọi lô đều parse lỗi ⇒ ném lỗi parse, không ghi gì", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(BATCH_MAX_UNITS * 2))
    await expect(runTranslation(PROJECT, USER, VI, {}, failingAt(1, 2))).rejects.toMatchObject({ statusCode: 422, code: "SCHEMA_MISMATCH" })
    expect(store.translations.size).toBe(0)
  })

  it("lô trả items: [] ⇒ trừ credit lô đó rồi dừng ngay, không gọi lô sau", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(BATCH_MAX_UNITS * 3))
    const executor: TranslateDocumentExecutor = vi.fn(async () => result([]))
    const res = await runTranslation(PROJECT, USER, VI, {}, executor)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ translated: 0, remaining: BATCH_MAX_UNITS * 3, credits_used: 2 })
    expect(store.translations.size).toBe(0)
  })

  it("lô mà mọi item bị loại (chuỗi / mảng chuỗi rỗng) ⇒ dừng, không ghi rác", async () => {
    const spine = createEmptySpine({ name: "Lumen" })
    spine.project.goals = ["Sell more.", "Ship faster."]
    mocks.getSpine.mockResolvedValue(spine)
    const executor = echo((items) => items.map((i) => ({ ...i, text: Array.isArray(i.text) ? i.text.map(() => "") : "" })))
    const res = await runTranslation(PROJECT, USER, VI, {}, executor)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(res.translated).toBe(0)
    expect(res.credits_used).toBe(2)
    expect(stored(["Sell more.", "Ship faster."])).toBeUndefined()
    expect(store.translations.size).toBe(0)
  })

  it("lô có tiến một phần ⇒ chạy tiếp lô sau", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(BATCH_MAX_UNITS * 2))
    // Bỏ một item mỗi lô ⇒ vẫn có tiến ⇒ không dừng
    const executor = echo((items) => items.slice(1))
    const res = await runTranslation(PROJECT, USER, VI, {}, executor)
    expect(executor).toHaveBeenCalledTimes(2)
    expect(res).toEqual({ translated: BATCH_MAX_UNITS * 2 - 2, remaining: 2, credits_used: 4 })
  })

  it("lưu bản dịch lỗi ở lô 2 ⇒ dừng, trả phần đã có với đúng credits_used", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(BATCH_MAX_UNITS * 3))
    const real = fakeRepository.saveTranslations.getMockImplementation()!
    let saves = 0
    fakeRepository.saveTranslations.mockImplementation(async (...args) => {
      saves++
      if (saves === 2) throw new Error("Mongo down")
      return real(...args)
    })
    const executor = echo()
    try {
      const res = await runTranslation(PROJECT, USER, VI, {}, executor)
      expect(executor).toHaveBeenCalledTimes(2)
      expect(res).toEqual({ translated: BATCH_MAX_UNITS, remaining: BATCH_MAX_UNITS * 2, credits_used: 4 })
    } finally {
      fakeRepository.saveTranslations.mockImplementation(real)
    }
  })

  it("học glossary lỗi ⇒ bỏ qua, bản dịch vẫn lưu và chạy tiếp", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(BATCH_MAX_UNITS * 2))
    const real = fakeRepository.upsertGlossary.getMockImplementation()!
    let modelWrites = 0
    fakeRepository.upsertGlossary.mockImplementation(async (...args) => {
      // Lần ghi `model` đầu là lúc gieo; các lần sau là học sau từng lô ⇒ lỗi
      if (args[3] === "model" && ++modelWrites > 1) throw new Error("glossary down")
      return real(...args)
    })
    try {
      const res = await runTranslation(PROJECT, USER, VI, {}, echo())
      expect(res).toEqual({ translated: BATCH_MAX_UNITS * 2, remaining: 0, credits_used: 4 })
      expect(modelWrites).toBe(3)
    } finally {
      fakeRepository.upsertGlossary.mockImplementation(real)
    }
  })
})

describe("runTranslation — một lượt mỗi (dự án, ngôn ngữ)", () => {
  it("lượt chồng lên ⇒ 409 TRANSLATION_RUNNING, không gọi model; xong thì nhả khoá", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(BATCH_MAX_UNITS * 2))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const ok = echo()
    const slow: TranslateDocumentExecutor = vi.fn(async (input, projectId, userId) => {
      await gate
      return ok(input, projectId, userId)
    })
    const first = runTranslation(PROJECT, USER, VI, { max_batches: 1 }, slow)
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1))

    const second = echo()
    await expect(runTranslation(PROJECT, USER, VI, {}, second)).rejects.toMatchObject({ statusCode: 409, code: TRANSLATION_RUNNING })
    expect(second).not.toHaveBeenCalled()

    release()
    await expect(first).resolves.toMatchObject({ translated: BATCH_MAX_UNITS, credits_used: 2 })
    expect(store.locks.size).toBe(0)
    // Lượt sau chạy được, chỉ phần còn thiếu
    await expect(runTranslation(PROJECT, USER, VI, {}, second)).resolves.toEqual({ translated: BATCH_MAX_UNITS, remaining: 0, credits_used: 2 })
  })

  it("lượt ném lỗi vẫn nhả khoá", async () => {
    mocks.getSpine.mockResolvedValue(spineWith(3))
    const broke: TranslateDocumentExecutor = vi.fn(async () => {
      throw new AiActionError(402, "Không đủ credit", "INSUFFICIENT_CREDIT")
    })
    await expect(runTranslation(PROJECT, USER, VI, {}, broke)).rejects.toMatchObject({ statusCode: 402 })
    expect(store.locks.size).toBe(0)
    expect(fakeRepository.releaseRunLock).toHaveBeenCalledTimes(1)
  })
})

describe("glossary trong lượt dịch", () => {
  it("gieo term_native (seed) và học tên đã dịch (model) cho lô sau", async () => {
    const spine = spineWith(BATCH_MAX_UNITS)
    spine.actors = [{ id: "A01", name: "Customer", kind: "human", description: "" }]
    spine.business_rules.push({ id: "BRX", tier: "detail", statement: "The Customer pays first.", source_validation_ids: [] })
    spine.glossary = [{ id: "G1", term: "Order", term_native: "Đơn hàng", definition: "" }]
    mocks.getSpine.mockResolvedValue(spine)
    const executor = echo()

    await runTranslation(PROJECT, USER, VI, {}, executor)

    expect(store.glossary.get(`${PROJECT}|vi|Order`)).toMatchObject({ translation: "Đơn hàng", origin: "seed" })
    expect(store.glossary.get(`${PROJECT}|vi|Customer`)).toMatchObject({ translation: "[vi] Customer", origin: "model" })
    // Lô 1 dịch tên actor ⇒ lô 2 (có "Customer") nhận thuật ngữ đó
    const calls = (executor as ReturnType<typeof vi.fn>).mock.calls as [AiActionInput][]
    expect(calls).toHaveLength(2)
    expect(calls[1][0].promptVariables?.glossary).toContain("- Customer → [vi] Customer")
  })
})

describe("acceptBatchItems", () => {
  it("mảng chuỗi rỗng / trắng ⇒ bỏ; phần tử được trim", () => {
    const batch = [
      { key: "a", sourceHash: "ha", text: ["One.", "Two."] },
      { key: "b", sourceHash: "hb", text: ["Three."] }
    ]
    expect(acceptBatchItems(batch, [{ key: "a", text: ["", ""] }, { key: "b", text: ["  Ba. "] }])).toEqual([
      { key: "b", sourceHash: "hb", source: ["Three."], text: ["Ba."] }
    ])
    expect(acceptBatchItems(batch, [{ key: "a", text: ["Một.", "  "] }])).toEqual([])
  })

  it("key trùng ⇒ lấy lần đầu; chuỗi rỗng ⇒ bỏ", () => {
    const batch = [
      { key: "a", sourceHash: "ha", text: "One" },
      { key: "b", sourceHash: "hb", text: "Two" }
    ]
    expect(acceptBatchItems(batch, [{ key: "a", text: "Một" }, { key: "a", text: "Một nữa" }, { key: "b", text: "  " }])).toEqual([
      { key: "a", sourceHash: "ha", source: "One", text: "Một" }
    ])
  })

  it("chép nguyên câu gốc ⇒ bỏ (giữ 'thiếu', cùng quy tắc với lượt AI trả kèm); tên ngắn giữ nguyên vẫn nhận", () => {
    const batch = [
      { key: "a", sourceHash: "ha", text: "The system shall save the order." },
      { key: "b", sourceHash: "hb", text: ["User opens the form.", "System saves it."] },
      { key: "c", sourceHash: "hc", text: "Dashboard" }
    ]
    expect(
      acceptBatchItems(batch, [
        { key: "a", text: " The system shall save the order. " },
        { key: "b", text: ["User opens the form.", "System saves it."] },
        { key: "c", text: "Dashboard" }
      ])
    ).toEqual([{ key: "c", sourceHash: "hc", source: "Dashboard", text: "Dashboard" }])
  })

  it("lô có một mục rỗng / null qua parser ⇒ các mục còn lại vẫn được nhận", () => {
    const batch = [
      { key: "a", sourceHash: "ha", text: "One rule." },
      { key: "b", sourceHash: "hb", text: "Two rule." },
      { key: "c", sourceHash: "hc", text: "Three rule." }
    ]
    const parsed = parseResponse<TranslateDocumentOutput>(
      JSON.stringify({ items: [{ key: "a", text: "Luật một." }, { key: "b", text: "" }, { key: "c", text: null }] }),
      ActionType.TRANSLATE_DOCUMENT
    )
    expect(acceptBatchItems(batch, parsed.items)).toEqual([{ key: "a", sourceHash: "ha", source: "One rule.", text: "Luật một." }])
  })
})

describe("defaultTranslateDocumentExecutor", () => {
  it("gọi executeAiAction với ActionType translate_document, projectId, userId", async () => {
    mocks.executeAiAction.mockResolvedValue(result([]))
    await defaultTranslateDocumentExecutor({ promptVariables: { items: "[]" } }, PROJECT, USER)
    expect(mocks.executeAiAction).toHaveBeenCalledWith("translate_document", { promptVariables: { items: "[]" } }, PROJECT, USER)
  })
})
