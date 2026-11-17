import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: vi.fn() }))

import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import type { AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { OpTransaction } from "../../shared/ai/response-parser.js"
import { projectStep, type StepContext } from "./context-projection.js"
import { DraftRejectedError, draftOps, type DraftExecutor } from "./draft-to-ops.js"
import { ESCALATION_MODEL, isErdOnly, normalizeEntityNames, stripEntityNameSuffix } from "./erd-retry.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const reply = (ops: unknown[]): AiActionResult<OpTransaction> => ({
  success: true,
  data: { ops: ops as OpTransaction["ops"] },
  rawText: "{}",
  actionType: "draft" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  latencyMs: 1,
  logId: "l",
  cost: 1
})

describe("FLF-433 erd-retry - hàm thuần", () => {
  it("bỏ đuôi tên màn hình / kỹ thuật; tên chỉ còn đuôi thì giữ", () => {
    expect(stripEntityNameSuffix("Exam List")).toBe("Exam")
    expect(stripEntityNameSuffix("Booking Service")).toBe("Booking")
    expect(stripEntityNameSuffix("List")).toBe("List")
    expect(stripEntityNameSuffix("Voucher")).toBe("Voucher")
  })
  it("normalizeEntityNames sửa add/set entities, không sửa khi trùng tên entity khác trong lô", () => {
    const ops = normalizeEntityNames([
      { op: "add", path: "entities[]", value: { name: "Exam List" } },
      { op: "set", path: "entities[id=E02].name", value: "Grade Table" },
      { op: "add", path: "entities[]", value: { name: "Order" } },
      { op: "add", path: "entities[]", value: { name: "Order Form" } }
    ]) as { value: { name?: string } | string }[]
    expect((ops[0].value as { name: string }).name).toBe("Exam")
    expect(ops[1].value).toBe("Grade")
    expect((ops[3].value as { name: string }).name).toBe("Order Form")
  })
  it("isErdOnly chỉ khi mọi lỗi là luật erd_*", () => {
    expect(isErdOnly([{ rule: "erd_disconnected", message: "" }])).toBe(true)
    expect(isErdOnly([{ rule: "erd_disconnected", message: "" }, { rule: "schema_invalid", message: "" }])).toBe(false)
    expect(isErdOnly([])).toBe(false)
  })
})

describe("FLF-433 draftOps - lỗi luật ERD: bản vá rồi model mạnh hơn ở lượt cuối", () => {
  it("lô chỉ vướng luật ERD ⇒ lượt 2 patch_mode (lô cũ giữ), lượt 3 gọi ESCALATION_MODEL", async () => {
    const spine = structuredClone(FIXTURE)
    const ctx: StepContext = { ...projectStep(spine, "S-4.5"), documents: "", documentTokens: 0, transcriptTail: "", contextTokens: 1 }
    // Entity đứng riêng ⇒ erd_disconnected (luật hình dạng ERD), model không bao giờ nối ⇒ đủ 3 lượt
    const isolated = [{ op: "add", path: "entities[]", value: { id: "E90", name: "Parking Lot", description: "A place.", relations: [], relation_verbs: {}, relation_cardinality: {}, relation_optional: [], attributes: [], feature_ids: [], states: [], transitions: [] } }]
    const executor = vi.fn<DraftExecutor>(async (_a, input) => reply((input.promptVariables as { patch_mode?: boolean }).patch_mode ? [] : isolated))
    const err = await draftOps("p", "S-4.5", ctx, { userId: "u", spine, executor }).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(DraftRejectedError)
    expect((err as DraftRejectedError).errors.every((e) => e.rule.startsWith("erd_"))).toBe(true)
    const calls = executor.mock.calls
    expect(calls).toHaveLength(3)
    expect((calls[0][1].promptVariables as { patch_mode: boolean }).patch_mode).toBe(false)
    expect((calls[1][1].promptVariables as { patch_mode: boolean }).patch_mode).toBe(true)
    expect(calls[0][4]?.model).toBeUndefined()
    expect(calls[1][4]?.model).toBeUndefined()
    expect(calls[2][4]?.model).toBe(ESCALATION_MODEL)
    // Lô cuối = lô đã giữ (bản vá rỗng) — không mất phần đã soạn
    expect((err as DraftRejectedError).lastOps).toHaveLength(1)
  })
})
