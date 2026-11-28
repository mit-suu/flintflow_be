/**
 * FLF-455 - Ngoài phạm vi theo loại nội dung 29148, mọi chế độ (business-flow nguyên tắc 4, §3.1 dòng I-4, §3.1.2):
 * file có section dự toán chi phí ở chế độ 1, 3, 4 ⇒ gắn Ngoài phạm vi, không bị soạn, không vào Spine (nên không bị kiểm),
 * chữ giữ nguyên trong file. Mongo thật + provider AI giả phân loại theo chữ của khối.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import mongoose from "mongoose"
import request from "supertest"
import JSZip from "jszip"
import app from "../../../src/app.js"
import { authAs } from "../../setup.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting, runExtraction, useExtractConcurrency } from "../../helpers/mode1-import-p4.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { makeDocx, p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import * as flagsService from "../../../src/modules/spine/flags.service.js"
import { ruleProfileOf } from "../../../src/modules/import/mode1-guard.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import { crToWritten, importedProject, resetCrMock } from "../../helpers/mode1-cr-p4.js"

useExtractConcurrency(1)

const COST = "Chi phí phát triển dự kiến là 500 triệu đồng, gồm nhân sự và hạ tầng máy chủ."
const CHAPTER_1 = "Cổng cấp phép xây dựng trực tuyến cho phép người dân nộp hồ sơ và theo dõi tiến độ xử lý."

/** AI giả: khối chữ chi phí ⇒ loại "cost estimate", ngoài 29148, không rút phần tử nào; còn lại như AI giả mặc định. */
const fakeClassify = (prompt: string): string | undefined => {
  if (!prompt.includes("# Import Extract") || !prompt.includes(COST.slice(0, 30))) return fakeMode1(prompt)
  const section = /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?"
  const tail = prompt.slice(prompt.indexOf("Blocks of the section"))
  const line = tail.split("\n").find((l) => l.includes(COST.slice(0, 30)))
  const block = /^\[(B\d{4,})\]/.exec(line ?? "")?.[1]
  return JSON.stringify({
    section_id: section,
    items: [],
    unmapped_block_ids: block ? [block] : [],
    content_mismatch: null,
    guidance_blocks: [],
    content_types: block ? [{ block_id: block, iso29148: "cost estimate", in_scope: false, confidence: 0.9 }] : []
  })
}

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeClassify
})

/** Mẫu có Chương 1 đã viết, Chương 2 chỉ chữ hướng dẫn, Chương 3 (tên tự đặt) có chữ chi phí, Phụ lục A dự toán còn trống. */
const templateWithCost = () =>
  makeDocx({
    styles: `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/></w:style>`,
    body:
      styled("u1", "1 Giới thiệu") +
      p(CHAPTER_1) +
      styled("u1", "2 Tác nhân") +
      p("[Mục này mô tả các tác nhân của hệ thống.]") +
      styled("u1", "3 Kế hoạch tài chính") +
      p(COST) +
      styled("u1", "4 Dự toán kinh phí") +
      p("[Mục này ghi dự toán kinh phí.]")
  })

const setIntent = (projectId: string, intent: "fixed" | "free") =>
  mongoose.connection.db!.collection("projects").updateOne({ _id: new mongoose.Types.ObjectId(projectId) }, { $set: { template_intent: intent, start_kind: "existing" } })

const run = async (buffer: Buffer, intent?: "fixed" | "free") => {
  const ctx = await importAtExtracting({ buffer })
  const extracted = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
  expect(extracted.doc.status).toBe("baselining")
  if (intent) await setIntent(ctx.projectId, intent)
  const before = (await spineRepository.get(ctx.projectId))!
  await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: before.spine_version })
  const profile = (await TemplateProfile.findOne({ projectId: ctx.projectId }).lean())!
  const spine = (await spineRepository.get(ctx.projectId))!
  return { ctx, structure: profile.target_structure!, profile, spine }
}

/** Tải file Word thật (GET /export/word) của dự án import rồi lấy chữ trong document.xml (đã bỏ thẻ XML). */
const exportedText = async (projectId: string, userId: string): Promise<string> => {
  const user = (await User.findById(userId).lean())!
  const project = (await Project.findById(projectId).lean())!
  const token = await authAs({ _id: user._id, email: user.email, orgId: String(project.organizationId) })
  const res = await request(app)
    .get(`/api/v1/projects/${projectId}/export/word?source=draft`)
    .set({ Authorization: `Bearer ${token}` })
    .buffer(true)
    .parse((r, done) => {
      const chunks: Buffer[] = []
      r.on("data", (c: Buffer) => chunks.push(c))
      r.on("end", () => done(null, Buffer.concat(chunks)))
    })
  expect(res.status).toBe(200)
  const xml = await (await JSZip.loadAsync(res.body as Buffer)).file("word/document.xml")!.async("string")
  return xml.replace(/<[^>]+>/g, "")
}

/** Mục Ngoài phạm vi không có bước soạn nào (`owner_steps` rỗng) — không chỉ vắng khỏi `missing`. */
const expectNoDraftSteps = (structure: { sections: { section_id: string; status: string; owner_steps?: string[] }[]; missing: string[] }) => {
  const out = structure.sections.filter((s) => s.status === "out_of_scope")
  expect(out.length).toBeGreaterThan(0)
  for (const s of out) {
    expect(s.owner_steps ?? [], s.section_id).toEqual([])
    expect(structure.missing).not.toContain(s.section_id)
  }
}

const statusOf = (structure: { sections: { title: string; status: string }[] }, title: string) => structure.sections.find((s) => s.title.includes(title))?.status

/**
 * Chữ chi phí chỉ ở mục riêng (giữ nguyên để xuất file), không thành phần tử Spine nào (nên luật không có gì để kiểm), không
 * có cờ nào neo vào đó, và vẫn nguyên trong file.
 */
const expectCostUntouched = async (projectId: string, spine: { custom_sections?: unknown; flags: { message?: string }[] }) => {
  const { custom_sections: custom, ...rest } = spine
  expect(JSON.stringify(custom)).toContain("500 triệu")
  expect(JSON.stringify(rest)).not.toContain("500 triệu")
  const blocks = await DocBlock.find({ projectId }).lean()
  expect(blocks.some((b) => b.text.trim() === COST)).toBe(true)
}

describe("FLF-455 - Ngoài phạm vi theo loại nội dung 29148, mọi chế độ", () => {
  it("chế độ 1: file đủ cấu trúc + mục dự toán chi phí ⇒ Ngoài phạm vi, không thành mục thiếu, không vào Spine, chữ giữ nguyên", async () => {
    const { ctx, structure, spine } = await run(await makeSrsDocx({ extraBody: styled("u1", "Phụ lục A Kế hoạch tài chính") + p(COST) }), "fixed")
    expect(structure.resolved_mode).toBe(1)
    expect(statusOf(structure, "Kế hoạch tài chính")).toBe("out_of_scope")
    expect(structure.missing).toEqual([])
    await expectCostUntouched(ctx.projectId, spine)
    expectNoDraftSteps(structure)
    // Xuất Word thật: chữ mục Ngoài phạm vi vẫn nguyên trong file
    const text = await exportedText(ctx.projectId, ctx.userId)
    expect(text).toContain("500 triệu")
    expect(spine.flags.some((f) => (f.message ?? "").includes("Kế hoạch tài chính"))).toBe(false)
  }, 120000)

  it("chế độ 3: mục dự toán có chữ (theo nội dung) và mục dự toán còn trống (theo heading) ⇒ Ngoài phạm vi; chỉ soạn mục thiếu của mẫu", async () => {
    const { ctx, structure, profile, spine } = await run(await templateWithCost(), "fixed")
    expect(structure).toMatchObject({ target: "template", intent: "fixed", resolved_mode: 3 })
    expect(statusOf(structure, "Giới thiệu")).toBe("present")
    expect(statusOf(structure, "Tác nhân")).toBe("missing")
    expect(statusOf(structure, "Kế hoạch tài chính")).toBe("out_of_scope")
    expect(statusOf(structure, "Dự toán kinh phí")).toBe("out_of_scope")
    expect(structure.missing).toHaveLength(1)
    expectNoDraftSteps(structure)
    // Ngữ cảnh soạn của Luồng 2 chỉ có mục thiếu: hai mục Ngoài phạm vi không bị soạn
    const outIds = structure.sections.filter((s) => s.status === "out_of_scope").map((s) => s.section_id)
    expect(outIds).toHaveLength(2)
    expect((profile.template_context ?? []).map((e) => e.section_id).filter((id) => outIds.includes(id))).toEqual([])
    await expectCostUntouched(ctx.projectId, spine)
    expect(await exportedText(ctx.projectId, ctx.userId)).toContain("500 triệu")
  }, 120000)

  it("FLF-455: mục dự toán còn trống Ngoài phạm vi không bị cờ đỏ template_section_empty chặn baseline; mục riêng trống trong phạm vi thì vẫn bị", async () => {
    const { ctx, structure } = await run(await templateWithCost(), "fixed")
    const budget = structure.sections.find((s) => s.title.includes("Dự toán kinh phí"))!
    expect(budget.status).toBe("out_of_scope")
    await flagsService.recompute(ctx.projectId, { by: "test", ruleProfile: await ruleProfileOf(ctx.projectId) })
    const spine = (await spineRepository.get(ctx.projectId))!
    // Mục còn trống thật trong Spine (nếu không thì test không chứng minh gì)
    expect(spine.custom_sections.some((c) => `custom:${c.id}` === budget.section_id)).toBe(true)
    expect(spine.flags.filter((f) => !f.resolved_at && f.rule_id === "template_section_empty").map((f) => f.section_id)).not.toContain(budget.section_id)
    // Nhãn tay in_scope: mục bị kiểm lại như mục trong phạm vi
    await TemplateProfile.updateOne({ projectId: ctx.projectId, "target_structure.sections.section_id": budget.section_id }, { $set: { "target_structure.sections.$.status": "missing" } })
    await flagsService.recompute(ctx.projectId, { by: "test", ruleProfile: await ruleProfileOf(ctx.projectId) })
    const after = (await spineRepository.get(ctx.projectId))!
    expect(after.flags.filter((f) => !f.resolved_at && f.rule_id === "template_section_empty").map((f) => f.section_id)).toContain(budget.section_id)
  }, 120000)

  it("chế độ 4: bổ sung theo mẫu chuẩn FlintFlow ⇒ mục dự toán vẫn Ngoài phạm vi, mục thiếu là mục của mẫu chuẩn", async () => {
    const { ctx, structure, spine } = await run(await templateWithCost(), "free")
    expect(structure).toMatchObject({ target: "fpt", intent: "free", resolved_mode: 4 })
    expect(statusOf(structure, "Kế hoạch tài chính")).toBe("out_of_scope")
    expect(statusOf(structure, "Dự toán kinh phí")).toBe("out_of_scope")
    expect(structure.missing.length).toBeGreaterThan(0)
    expect(structure.missing.some((id) => structure.sections.find((s) => s.section_id === id)?.title.includes("tài chính"))).toBe(false)
    expectNoDraftSteps(structure)
    await expectCostUntouched(ctx.projectId, spine)
    expect(await exportedText(ctx.projectId, ctx.userId)).toContain("500 triệu")
  }, 120000)
})

describe("FLF-455 - sửa mục khác qua CR thật không đổi mục Ngoài phạm vi", () => {
  it("dự án import có mục dự toán Ngoài phạm vi; CR sửa NFR ghi vào Spine ⇒ mục dự toán nguyên chữ, nguyên trong file Word xuất ra", async () => {
    resetCrMock()
    const { seeded, projectId, c } = await importedProject()
    const oid = new mongoose.Types.ObjectId(projectId)
    const section = { id: "CS77", heading: "Kế hoạch tài chính", level: 1, source: "import", blocks: [{ kind: "paragraph", text: COST, rows: null, image_ref: null }] }
    const upd = await Spine.updateOne({ projectId: oid }, { $push: { custom_sections: section } })
    expect(upd.modifiedCount).toBe(1)
    spineRepository.clearReadCache()
    await TemplateProfile.updateOne(
      { projectId },
      {
        $set: {
          target_structure: {
            target: "fpt",
            intent: "free",
            resolved_mode: 1,
            missing: [],
            compared_at: new Date().toISOString(),
            sections: [{ section_id: "custom:CS77", title: "Kế hoạch tài chính", status: "out_of_scope", owner_steps: [] }]
          }
        }
      }
    )
    const before = (await spineRepository.get(projectId))!
    expect(JSON.stringify(before.custom_sections)).toContain("500 triệu")

    await crToWritten(c)

    const after = (await spineRepository.get(projectId))!
    expect(after.spine_version).toBeGreaterThan(before.spine_version)
    expect(after.custom_sections).toEqual(before.custom_sections)
    expect(after.nfrs).not.toEqual(before.nfrs)
    expect(await exportedText(projectId, seeded.userId)).toContain("500 triệu")
  }, 120000)
})
