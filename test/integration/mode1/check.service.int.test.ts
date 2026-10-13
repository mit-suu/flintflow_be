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
import { CROSS_CHECK_STEP, semanticBatchStep } from "../../../src/modules/import/check.service.js"
import { MODE1_RULE_PROFILE } from "../../../src/modules/import/mode1-rule-profile.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { runDeterministicCheck } from "../../../src/modules/spine/deterministic-check.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { IMPORTED_DOC_VERSION } from "../../../src/modules/doc-version/versioning.js"
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
    // SRS mẫu không có tham chiếu chết; đầu mục FPT file không có không còn bắt buộc ⇒ không cờ đỏ nào
    expect(open.filter((f) => f.level === "red")).toEqual([])
  })
})

describe("check — AI semantic (1.11)", () => {
  it("finding của AI chỉ ra cờ vàng rule import_semantic, section bịa ⇒ fixed:I; trừ credit một lô map + một lượt kiểm chéo", async () => {
    const { projectId, userId, result } = await importFinalized()
    expect(semanticCalls).toBe(1)
    const spine = (await spineRepository.get(projectId))!
    const ai = spine.flags.filter((f) => f.rule_id === "import_semantic")
    expect(ai).toHaveLength(2)
    expect(ai.every((f) => f.level === "yellow" && f.resolved_at === null && f.remediation_step === "C-1")).toBe(true)
    expect(ai.map((f) => f.section_id).sort()).toEqual(["fixed:4.2.3", "fixed:I"])
    // AI chỉ đặt cờ vàng; đầu mục FPT thiếu không còn là cờ đỏ
    expect(result.flags.red).toBe(0)
    expect(result.flags.yellow).toBe(spine.flags.filter((f) => f.resolved_at === null && f.level === "yellow").length)
    // tài liệu mẫu ngắn ⇒ một lô map; thêm một lượt kiểm chéo
    const usage = await Usage.find({ projectId, step_id: /^I-1\.11/ }).sort({ step_id: 1 }).lean()
    expect(usage.map((u) => [u.step_id, u.state, u.call_kind])).toEqual([
      [semanticBatchStep(1), "deducted", "import_semantic_check"],
      [CROSS_CHECK_STEP, "deducted", "import_cross_check"]
    ])
    // 6 lượt I-4 × 2 + 1 lô check × 3 + 1 lượt kiểm chéo × 3
    expect(await CreditWallet.findOne({ userId }).lean()).toMatchObject({ balance: 982, reserved: 0 })
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
    expect(await Usage.find({ projectId, step_id: semanticBatchStep(1) }).distinct("state")).toEqual(["refunded"])
    // lô lỗi ⇒ chưa chạy kiểm chéo
    expect(await Usage.exists({ projectId, step_id: CROSS_CHECK_STEP })).toBeNull()

    mockOverrides.next = semanticRed
    const doc = (await ImportedDocument.findById(importId))!
    await resumeCheck(doc, userId)
    expect(doc.status).toBe("gap_review")
    expect(semanticCalls).toBe(1)
    // gọi lại lần nữa (lô và kiểm chéo đều đã deducted) ⇒ không gọi AI; chỉ chuyển trạng thái nếu còn hợp lệ
    doc.status = "checking"
    await doc.save()
    await resumeCheck(doc, userId)
    expect(semanticCalls).toBe(1)
  })

  it("tài liệu dài ⇒ nhiều lô map; một lô lỗi ⇒ lô khác vẫn ghi cờ, chưa kiểm chéo; resume chỉ gọi lại lô lỗi rồi kiểm chéo", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    // dừng ở checking trước mọi lượt AI (hết credit), rồi nối thêm ~80k ký tự chữ để tài liệu cần nhiều lô
    await CreditWallet.updateOne({ userId }, { $set: { balance: 0 } })
    const v = (await spineRepository.get(projectId))!.spine_version
    expect((await finalizeImport(projectId, userId, { import_id: importId, base_version: v })).doc.paused?.reason).toBe("credits")
    const last = (await DocBlock.findOne({ projectId, doc_version: IMPORTED_DOC_VERSION }).sort({ "anchor.ordinal": -1 }).lean())!
    const extra = Array.from({ length: 40 }, (_, i) => ({
      projectId: last.projectId,
      doc_version: IMPORTED_DOC_VERSION,
      block_id: `B${9000 + i}`,
      kind: "paragraph",
      anchor: { xml_path: `/extra/${i}`, ordinal: last.anchor.ordinal + 1 + i },
      text: `${i === 39 ? "TAIL-MARKER " : ""}${"The system shall keep records as needed. ".repeat(48)}`,
      text_hash: `extra-${i}`,
      section_id: "fixed:4.2.3"
    }))
    await DocBlock.insertMany(extra)
    await CreditWallet.updateOne({ userId }, { $set: { balance: 100 } })

    // lô chứa block cuối lỗi, các lô còn lại trả finding
    mockOverrides.next = (prompt) => (prompt.includes("# Import Semantic Check") && prompt.includes("TAIL-MARKER") ? new Error("provider down") : semanticRed(prompt))
    const doc = (await ImportedDocument.findById(importId))!
    await resumeCheck(doc, userId)
    expect(doc).toMatchObject({ status: "checking", paused: { reason: "resume_later" } })
    const steps = async (state: "deducted" | "refunded") => (await Usage.find({ projectId, step_id: /^I-1\.11/, state }).distinct("step_id")).sort()
    const deducted = await steps("deducted")
    // lô lỗi = hoàn credit mà chưa từng trừ (lô 1 có thêm một bản hoàn từ lượt hết credit lúc finalize)
    const failed = (await steps("refunded")).filter((s) => !deducted.includes(s))
    expect(deducted.length).toBeGreaterThan(0)
    expect(failed).toHaveLength(1)
    expect(deducted).not.toContain(CROSS_CHECK_STEP)
    // cờ của lô đã xong được ghi ngay, không chờ lô lỗi
    expect((await spineRepository.get(projectId))!.flags.some((f) => f.rule_id === "import_semantic")).toBe(true)

    semanticCalls = 0
    let crossCalls = 0
    mockOverrides.next = (prompt) => {
      if (prompt.includes("# Import Cross-Section Check")) crossCalls++
      return semanticRed(prompt)
    }
    await resumeCheck(doc, userId)
    expect(doc.status).toBe("gap_review")
    expect(semanticCalls).toBe(1)
    expect(crossCalls).toBe(1)
    expect(await steps("deducted")).toEqual([...deducted, ...failed, CROSS_CHECK_STEP].sort())
    // finding giống nhau ở nhiều lô chỉ thành một cờ
    const ai = (await spineRepository.get(projectId))!.flags.filter((f) => f.rule_id === "import_semantic")
    expect(new Set(ai.map((f) => `${f.section_id}|${f.message}`)).size).toBe(ai.length)
  })
})
