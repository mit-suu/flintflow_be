/**
 * Check sau baseline v0 (nút 1.11 AI semantic + 1.12 code rule) trên Mongo thật + provider AI giả — plan §8.2
 * `check.service.test.ts`. FLF-172 P4: luật loại trừ mode 1 không bắn cờ; AI check chỉ ra vàng; hết credit /
 * lỗi AI ⇒ paused, resume không gọi lại AI đã xong.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtBaselining, importFinalized } from "../../helpers/mode1-import-p4.js"
import { finalizeImport, resumeCheck } from "../../../src/modules/import/finalize.service.js"
import { SEMANTIC_CHECK_STEP } from "../../../src/modules/import/check.service.js"
import { MODE1_RULE_PROFILE } from "../../../src/modules/import/mode1-rule-profile.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { runDeterministicCheck } from "../../../src/modules/spine/deterministic-check.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

let semanticCalls = 0
const semanticRed = (prompt: string): string | undefined => {
  if (!prompt.includes("# Import Semantic Check")) return fakeMode1(prompt)
  semanticCalls++
  const b = /\[(B\d{4,})\] \(fixed:4\.2\.3\)/.exec(prompt)?.[1] ?? "B0001"
  // model cố gán mức đỏ + trả thêm finding ở section bịa: cờ vẫn vàng
  return JSON.stringify({
    findings: [
      { rule: "ambiguity", section_id: "fixed:4.2.3", message: "\"95% of requests\" needs a load profile.", block_ids: [b], level: "red" },
      { rule: "conflict", section_id: "fixed:42", message: "Two rules disagree.", block_ids: [], severity: "critical" }
    ]
  })
}

beforeEach(() => {
  resetMockLlm()
  semanticCalls = 0
  mockOverrides.next = semanticRed
})

const EXCLUDED = [...MODE1_RULE_PROFILE.exclude]

describe("check — hồ sơ luật mode 1", () => {
  it("luật loại trừ không bắn cờ dù Spine import có điều kiện kích hoạt; luật hạ mức chỉ ra vàng", async () => {
    const { projectId } = await importFinalized()
    const spine = (await spineRepository.get(projectId))!
    const { projectId: _p, ...plain } = spine
    // chạy đủ luật như mode 2 trên cùng Spine: các luật loại trừ đều có ứng viên (roles/entities rỗng, UC không gắn function…)
    const mode2Rules = new Set(runDeterministicCheck(plain, [], { atBaseline: true }).map((f) => f.rule_id))
    expect(mode2Rules.has("array_empty")).toBe(true)
    expect(mode2Rules.has("usecase_no_function")).toBe(true)

    const open = spine.flags.filter((f) => f.resolved_at === null)
    expect(open.filter((f) => EXCLUDED.includes(f.rule_id))).toEqual([])
    const downgraded = open.filter((f) => MODE1_RULE_PROFILE.downgrade.has(f.rule_id))
    expect(downgraded.length).toBeGreaterThan(0)
    expect(downgraded.every((f) => f.level === "yellow")).toBe(true)
    // SRS mẫu không có tham chiếu chết ⇒ 0 đỏ sau import
    expect(open.filter((f) => f.level === "red")).toEqual([])
  })
})

describe("check — AI semantic (1.11)", () => {
  it("finding của AI chỉ ra cờ vàng rule import_semantic, section bịa ⇒ fixed:I; trừ credit một lượt I-1.11", async () => {
    const { projectId, userId, result } = await importFinalized()
    expect(semanticCalls).toBe(1)
    const spine = (await spineRepository.get(projectId))!
    const ai = spine.flags.filter((f) => f.rule_id === "import_semantic")
    expect(ai).toHaveLength(2)
    expect(ai.every((f) => f.level === "yellow" && f.resolved_at === null && f.remediation_step === "C-1")).toBe(true)
    expect(ai.map((f) => f.section_id).sort()).toEqual(["fixed:4.2.3", "fixed:I"])
    expect(result.flags.red).toBe(0)
    expect(result.flags.yellow).toBe(spine.flags.filter((f) => f.resolved_at === null && f.level === "yellow").length)
    const usage = await Usage.find({ projectId, step_id: SEMANTIC_CHECK_STEP }).lean()
    expect(usage.map((u) => u.state)).toEqual(["deducted"])
    // 6 lượt I-4 × 2 + 1 lượt check × 3
    expect(await CreditWallet.findOne({ userId }).lean()).toMatchObject({ balance: 985, reserved: 0 })
  })

  it("cờ AI không bị recompute tất định đóng ở lượt sau", async () => {
    const { projectId } = await importFinalized()
    const flagsService = await import("../../../src/modules/spine/flags.service.js")
    await flagsService.recompute(projectId, { by: "import", ruleProfile: MODE1_RULE_PROFILE })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.flags.filter((f) => f.rule_id === "import_semantic" && f.resolved_at === null)).toHaveLength(2)
  })

  it("hết credit ở 1.11 ⇒ paused credits ở checking, chưa recompute; nạp rồi resume ⇒ gọi AI một lần, gap_review", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    await CreditWallet.updateOne({ userId }, { $set: { balance: 0 } })
    const v = (await spineRepository.get(projectId))!.spine_version
    const fin = await finalizeImport(projectId, userId, { import_id: importId, base_version: v })
    expect(fin.doc.status).toBe("checking")
    expect(fin.doc.paused?.reason).toBe("credits")
    expect(semanticCalls).toBe(0)
    expect((await spineRepository.get(projectId))!.flags).toEqual([])

    await CreditWallet.updateOne({ userId }, { $set: { balance: 10 } })
    const doc = (await ImportedDocument.findById(importId))!
    await resumeCheck(doc, userId)
    expect(semanticCalls).toBe(1)
    expect(doc.status).toBe("gap_review")
    expect(doc.paused).toBeNull()
  })

  it("AI lỗi ⇒ paused resume_later, hoàn credit; resume sau khi 1.11 đã xong không gọi AI lại", async () => {
    mockOverrides.next = (prompt) => (prompt.includes("# Import Semantic Check") ? new Error("provider down") : fakeMode1(prompt))
    const { projectId, userId, importId } = await importAtBaselining()
    const balance = (await CreditWallet.findOne({ userId }).lean())!.balance
    const v = (await spineRepository.get(projectId))!.spine_version
    const fin = await finalizeImport(projectId, userId, { import_id: importId, base_version: v })
    expect(fin.doc).toMatchObject({ status: "checking", paused: { reason: "resume_later" } })
    expect(await CreditWallet.findOne({ userId }).lean()).toMatchObject({ balance, reserved: 0 })
    expect(await Usage.find({ projectId, step_id: SEMANTIC_CHECK_STEP }).distinct("state")).toEqual(["refunded"])

    mockOverrides.next = semanticRed
    const doc = (await ImportedDocument.findById(importId))!
    await resumeCheck(doc, userId)
    expect(doc.status).toBe("gap_review")
    expect(semanticCalls).toBe(1)
    // gọi lại lần nữa (đã có usage deducted cho I-1.11) ⇒ không gọi AI; chỉ chuyển trạng thái nếu còn hợp lệ
    doc.status = "checking"
    await doc.save()
    await resumeCheck(doc, userId)
    expect(semanticCalls).toBe(1)
  })
})
