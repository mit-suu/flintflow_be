import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./ai-action.service.js", () => ({ executeAiAction: vi.fn(async () => ({ success: true })) }))
vi.mock("./credit-reservation.service.js", () => ({ getActionCost: vi.fn() }))
vi.mock("../../modules/admin/ai-action-log.model.js", () => ({ AiActionLog: { findById: vi.fn() } }))

import { executeAiActionHandler, retryAiActionHandler } from "./ai-action.controller.js"
import { executeAiAction } from "./ai-action.service.js"
import { AiActionLog } from "../../modules/admin/ai-action-log.model.js"
import { ActionType } from "./ai-action.types.js"

const USER = "64b000000000000000000020"
const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }) as any
const clientInput = { promptVariables: { x: 1 }, documentLanguage: "vi", sourceLanguage: "en", documentGlossary: [{ term: "A", translation: "B" }] }

beforeEach(() => vi.clearAllMocks())

describe("ai-action.controller — khối Document language chỉ server bật (FLF-265 D16)", () => {
  it("POST /execute: bỏ documentLanguage / sourceLanguage / documentGlossary client gửi", async () => {
    const next = vi.fn()
    await executeAiActionHandler({ user: { id: USER }, body: { actionType: ActionType.DRAFT, input: clientInput } } as any, res(), next)
    expect(next).not.toHaveBeenCalled()
    expect(vi.mocked(executeAiAction).mock.calls[0][1]).toEqual({ promptVariables: { x: 1 } })
  })

  it("POST /retry/:logId: cũng bỏ", async () => {
    vi.mocked(AiActionLog.findById).mockResolvedValue({ userId: USER, actionType: ActionType.DRAFT, projectId: null } as any)
    const next = vi.fn()
    await retryAiActionHandler({ user: { id: USER }, params: { logId: "64b0000000000000000000aa" }, body: { input: clientInput } } as any, res(), next)
    expect(next).not.toHaveBeenCalled()
    expect(vi.mocked(executeAiAction).mock.calls[0][1]).toEqual({ promptVariables: { x: 1 } })
  })
})
