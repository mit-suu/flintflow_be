/**
 * Phát hành sau đổi mẫu trên Mongo in-memory: version đã phát hành tải lại y nguyên khi dự án đổi sang mẫu bắt buộc, và mục của
 * mẫu mới còn trống chặn phát hành cho tới khi được viết.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { resetMockLlm } from "../../helpers/mock-llm.js"
import { documentXml, importedProject, releaseNow, routeReplaceCr } from "../../helpers/mode1-release-p4.js"
import { downloadVersion } from "../../../src/modules/doc-version/versions.service.js"
import { mode1RuleProfileFor, ruleProfileOf } from "../../../src/modules/import/mode1-guard.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import * as flagsService from "../../../src/modules/spine/flags.service.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  routeReplaceCr("2 seconds", "1 second", { extraKeywords: ["Passwords"], commentOn: /^business_rules\[/ })
})

const MISSING = "custom:CSMISS"

const addCustomSection = async (projectId: string, text: string | null) => {
  const spine = (await spineRepository.get(projectId))!
  await applyTransaction(projectId, {
    base_version: spine.spine_version,
    by: "test",
    ops: [{
      op: "add",
      path: "custom_sections[]",
      value: { id: "CSMISS", heading: "Phạm vi", level: 2, blocks: text === null ? [] : [{ kind: "paragraph", text, rows: null, image_ref: null }], source: "manual" }
    }]
  })
}

const simulateMigration = async (projectId: string) => {
  await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed" } })
  await TemplateProfile.updateOne({ projectId }, { $set: {
    migrated_base_at: new Date(),
    migration_missing_sections: [MISSING],
    layout: [{ order: 0, heading_text: "Phạm vi", level: 2, section_id: MISSING }]
  } })
}

describe("version đã phát hành không phụ thuộc lần đổi mẫu sau đó", () => {
  it("dự án mẫu tự do phát hành 1.0 → đổi sang mẫu bắt buộc → tải 1.0 vẫn đúng file đã lưu", async () => {
    const { c, projectId } = await importedProject()
    const res = await releaseNow(c)
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const before = await downloadVersion(projectId, "Lumen LMS", "1.0", "auto")

    await simulateMigration(projectId)

    const after = await downloadVersion(projectId, "Lumen LMS", "1.0", "auto")
    expect(after.filename).toBe(before.filename)
    expect(await documentXml(after.data)).toBe(await documentXml(before.data))
  })
})

describe("mục để trống sau đổi mẫu chặn phát hành", () => {
  it("cờ đỏ cho tới khi mục có chữ thật; không kèm template_section_empty", async () => {
    const { projectId } = await importedProject()
    await addCustomSection(projectId, null)
    await simulateMigration(projectId)

    const profile = (await ruleProfileOf(projectId))!
    expect([...(profile.templateMissing ?? [])]).toEqual([MISSING])
    expect(profile.checkSectionReferences).toBe(true)

    const blocked = await flagsService.recompute(projectId, { by: "test", ruleProfile: await mode1RuleProfileFor(projectId), atBaseline: true })
    const open = blocked.flags.filter((f) => f.resolved_at === null)
    expect(open.filter((f) => f.rule_id === "template_section_migration_missing").map((f) => [f.level, f.section_id])).toEqual([["red", MISSING]])
    expect(open.some((f) => f.rule_id === "template_section_empty" && f.section_id === MISSING)).toBe(false)

    // Viết nội dung thật vào mục ⇒ recompute đóng cờ
    const spine = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, {
      base_version: spine.spine_version,
      by: "test",
      ops: [{ op: "add", path: "custom_sections[id=CSMISS].blocks[]", value: { kind: "paragraph", text: "Phạm vi gồm đăng nhập và báo cáo.", rows: null, image_ref: null } }]
    })
    const cleared = await flagsService.recompute(projectId, { by: "test", ruleProfile: await mode1RuleProfileFor(projectId), atBaseline: true })
    expect(cleared.flags.some((f) => f.rule_id === "template_section_migration_missing" && f.resolved_at === null)).toBe(false)
  })
})

describe("heading nhóm của mẫu đích không chặn phát hành (test tay 11/11)", () => {
  it("profile ghi heading nhóm vào migration_missing_sections (bản cũ) ⇒ lọc khỏi cờ đỏ, mục lá vẫn chặn", async () => {
    const { projectId } = await importedProject()
    await addCustomSection(projectId, null)
    const WRAPPER = "custom:CSWRAP"
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed" } })
    await TemplateProfile.updateOne({ projectId }, { $set: {
      migrated_base_at: new Date(),
      migration_missing_sections: [WRAPPER, MISSING],
      layout: [
        { order: 0, heading_text: "II. Software Requirement Specification", level: 1, section_id: WRAPPER },
        { order: 1, heading_text: "Phạm vi", level: 2, section_id: MISSING }
      ]
    } })

    const profile = (await ruleProfileOf(projectId))!
    expect([...(profile.templateMissing ?? [])]).toEqual([MISSING])
    const recomputed = await flagsService.recompute(projectId, { by: "test", ruleProfile: await mode1RuleProfileFor(projectId), atBaseline: true })
    const red = recomputed.flags.filter((f) => f.resolved_at === null && f.rule_id === "template_section_migration_missing").map((f) => f.section_id)
    expect(red).toEqual([MISSING])
  })
})

