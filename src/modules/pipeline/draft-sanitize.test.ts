import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi } from "vitest"

vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: vi.fn() }))
vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return { ...actual, get: vi.fn(), applyAndSave: vi.fn(), saveWithVersion: vi.fn() }
})

import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import type { AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { OpTransaction } from "../../shared/ai/response-parser.js"
import { projectStep, type StepContext } from "./context-projection.js"
import { draftOps, type DraftExecutor } from "./draft-to-ops.js"
import { cleanDiagramLabel, cleanRelationVerb, sanitizeDraftForm } from "./draft-sanitize.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

describe("cleanDiagramLabel (FLF-477, mẫu thật từ log S-5.2)", () => {
  it("dấu phẩy ⇒ gạch ngang, bỏ ngoặc vuông, gọn khoảng trắng", () => {
    expect(cleanDiagramLabel("Select slot, pay deposit")).toBe("Select slot - pay deposit")
    expect(cleanDiagramLabel("Submit form[valid] ,  confirm")).toBe("Submit formvalid - confirm")
    expect(cleanDiagramLabel("Show list")).toBe("Show list")
  })
  it("relation verb: chữ hoa / gạch nối ⇒ viết thường cách nhau bằng dấu cách; không sửa được thì giữ nguyên", () => {
    expect(cleanRelationVerb("Is-Owned By")).toBe("is owned by")
    expect(cleanRelationVerb("has 2")).toBe("has 2")
  })
})

describe("sanitizeDraftForm", () => {
  it("sửa message của interactions ở mọi dạng op, giữ nguyên số op và op_index", () => {
    const ops = [
      { op: "add", path: "functions[id=FN004].interactions[]", value: { from: "A01", to: "system", message: "Pick slot, pay", kind: "request", flow: "normal" } },
      { op: "set", path: "functions[id=FN004]", value: { id: "FN004", interactions: [{ from: "A01", to: "system", message: "a, b", kind: "request", flow: "normal" }] } },
      { op: "set", path: "functions[id=FN004].interactions", value: [{ from: "A01", to: "system", message: "x[1]", kind: "response", flow: "normal" }] },
      { op: "add", path: "entities[id=E01].transitions[]", value: { from: "s1", to: "s2", event: "pay, confirm" } },
      { op: "set", path: "functions[id=FN004].name", value: "Pay, confirm" }
    ]
    const out = sanitizeDraftForm(ops, undefined)
    expect(out.ops).toHaveLength(5)
    expect((out.ops[0].value as { message: string }).message).toBe("Pick slot - pay")
    expect((out.ops[1].value as { interactions: Array<{ message: string }> }).interactions[0].message).toBe("a - b")
    expect((out.ops[2].value as Array<{ message: string }>)[0].message).toBe("x1")
    expect((out.ops[3].value as { event: string }).event).toBe("pay - confirm")
    // Tên chức năng là nội dung, không phải nhãn sơ đồ ⇒ không đụng
    expect(out.ops[4].value).toBe("Pay, confirm")
    expect(out.fixes).toHaveLength(4)
    expect((ops[0].value as { message: string }).message).toBe("Pick slot, pay")
  })
  it("localized cùng hình dạng cũng được làm sạch", () => {
    const out = sanitizeDraftForm([], [{ path: "functions[id=FN004].interactions[]", value: { from: "A01", to: "system", message: "Chọn, trả", kind: "request", flow: "normal" } }])
    expect((out.localized![0].value as { message: string }).message).toBe("Chọn - trả")
  })
})

describe("draftOps × làm sạch hình thức (FLF-477)", () => {
  it("message có dấu phẩy ⇒ lô vẫn nhận ngay lượt 1, op ghi bản đã sạch (không tốn lượt thử)", async () => {
    const spine = structuredClone(FIXTURE)
    const fn = spine.functions.find((f) => f.id === "FN001")!
    const stepId = `S-5.2@${fn.screen_id}`
    const ctx: StepContext = { ...projectStep(spine, stepId), documents: "", documentTokens: 0, transcriptTail: "User: answer", contextTokens: 1 }
    const ops = [
      { op: "set", path: "functions[id=FN001].interactions", value: [
        { from: "A01", to: "system", message: "Select slot, pay deposit", kind: "request", flow: "normal" },
        { from: "system", to: "A01", message: "Show result", kind: "response", flow: "normal" }
      ] }
    ]
    const executor = vi.fn<DraftExecutor>(async () => ({
      success: true, data: { ops: ops as OpTransaction["ops"] }, rawText: "{}", actionType: "draft" as never, provider: "mock", aiModel: "mock",
      tokensUsed: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1, logId: "l", cost: 1
    } as AiActionResult<OpTransaction>))
    const result = await draftOps("p", stepId, ctx, { userId: "u", spine, executor })
    expect(executor).toHaveBeenCalledTimes(1)
    const first = result.txn!.ops[0] as { value: Array<{ message: string }> }
    expect(first.value[0].message).toBe("Select slot - pay deposit")
  })
})
