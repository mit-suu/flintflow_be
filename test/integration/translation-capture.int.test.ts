/**
 * FLF-265 phase 2 §2.7 (D16) — lượt AI ghi Spine trả kèm bản ngôn ngữ tài liệu, qua HTTP trên Mongo thật:
 * `POST /changes/preview` (lượt gọi `change_instruction` thật qua `executeAiAction`, provider giả ở tầng `callLLM`) rồi
 * `POST /changes` theo `preview_id`. Dự án `en` ⇒ prompt không có khối; dự án `vi` ⇒ có khối, `localized` lưu thành bản
 * `author` sau khi áp, Spine vẫn tiếng Anh; đầu ra kèm khối bị cắt ⇒ thử lại không kèm khối, Spine vẫn ghi.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () =>
  (await import("../helpers/mock-llm.js")).mockLlmRouterModule()
)

import app from "../../src/app.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Spine } from "../../src/modules/spine/spine.model.js"
import { SpineTranslation } from "../../src/modules/translation/spine-translation.model.js"
import { TranslationGlossary } from "../../src/modules/translation/translation-glossary.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { hashSource } from "../../src/modules/translation/translation-units.js"
import { changesPreviewResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"

const BLOCK = "## Document language"
const rename = { op: "set", path: "actors[id=A01].name", value: "Product Owner" }
const localized = [{ path: "actors[id=A01].name", value: "Chủ sản phẩm" }]
const instruction = "Rename actor A01 to Product Owner"

let seeded: SeededFixture

const client = () => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${seeded.projectId}`
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body)
  }
}

/** Prompt `change_instruction` gửi tới provider giả, theo thứ tự gọi. */
const prompts: string[] = []

const previewThenApply = async () => {
  const api = client()
  const preview = await api.post("/changes/preview", { base_version: seeded.spineVersion, instruction })
  expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
  const planned = changesPreviewResponseSchema.parse(preview.body.data)
  expect(planned.ok).toBe(true)
  const applied = await api.post("/changes", { base_version: seeded.spineVersion, instruction, preview_id: planned.preview_id })
  expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
  return applied.body.data as { spine_version: number }
}

const actorName = async () => ((await Spine.findOne({ projectId: seeded.projectId }).lean()) as { actors: { id: string; name: string }[] }).actors.find((a) => a.id === "A01")?.name

beforeEach(async () => {
  resetMockLlm()
  prompts.length = 0
  seeded = await seedFixture("full")
})

describe("lượt sửa qua chat — dự án en", () => {
  it("prompt không có khối Document language; localized model tự trả cũng không được lưu", async () => {
    mockOverrides.next = (prompt) => {
      prompts.push(prompt)
      return JSON.stringify({ ops: [rename], localized })
    }
    await previewThenApply()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain(BLOCK)
    expect(await actorName()).toBe("Product Owner")
    expect(await SpineTranslation.countDocuments({ projectId: seeded.projectId })).toBe(0)
  })
})

describe("lượt sửa qua chat — dự án vi (FLF-265 D16)", () => {
  beforeEach(async () => {
    await Project.updateOne({ _id: seeded.projectId }, { documentLanguage: "vi" })
  })

  it("preview mang khối + glossary con; apply theo preview_id ⇒ Spine tiếng Anh, bản author, tên vào glossary; status bớt một mục thiếu", async () => {
    await TranslationGlossary.create([
      { projectId: seeded.projectId, locale: "vi", term: "Founder", translation: "Nhà sáng lập", origin: "seed" },
      { projectId: seeded.projectId, locale: "vi", term: "Nonexistent Term Xyz", translation: "Không có", origin: "model" }
    ])
    const before = (await client().get("/translations/status")).body.data as { missing: number }
    mockOverrides.next = (prompt) => {
      prompts.push(prompt)
      return JSON.stringify({ ops: [rename], localized })
    }

    await previewThenApply()

    // Một lượt gọi model (preview); apply dùng lại lô đã xem
    expect(mockCalls.filter((c) => c.kind === "change")).toHaveLength(1)
    expect(prompts[0]).toContain(BLOCK)
    expect(prompts[0]).toContain("Vietnamese (tiếng Việt)")
    expect(prompts[0]).toContain("  - Founder → Nhà sáng lập")
    expect(prompts[0]).not.toContain("Nonexistent Term Xyz")

    expect(await actorName()).toBe("Product Owner")
    const row = await SpineTranslation.findOne({ projectId: seeded.projectId, locale: "vi", sourceHash: hashSource("Product Owner") }).lean()
    expect(row).toMatchObject({ text: "Chủ sản phẩm", origin: "author", sourceLocale: "en" })
    expect(await TranslationGlossary.findOne({ projectId: seeded.projectId, locale: "vi", term: "Product Owner" }).lean()).toMatchObject({
      translation: "Chủ sản phẩm",
      origin: "model"
    })

    const after = (await client().get("/translations/status")).body.data as { missing: number }
    expect(after.missing).toBe(before.missing - 1)
  })

  it("thêm phần tử mới qua chat, op add không có id (server cấp) ⇒ vẫn lưu bản author", async () => {
    const add = { op: "add", path: "actors[]", value: { name: "Pharmacist", description: "Hands out medicine to patients.", kind: "system" } }
    mockOverrides.next = (prompt) => {
      prompts.push(prompt)
      return JSON.stringify({ ops: [add], localized: [{ path: "actors[]", value: { name: "Dược sĩ", description: "Phát thuốc cho bệnh nhân." } }] })
    }

    await previewThenApply()

    const spine = (await Spine.findOne({ projectId: seeded.projectId }).lean()) as { actors: { id: string; name: string }[] }
    const added = spine.actors.find((a) => a.name === "Pharmacist")
    expect(added?.id).toMatch(/^A\d+$/)
    const rows = await SpineTranslation.find({
      projectId: seeded.projectId,
      locale: "vi",
      sourceHash: { $in: [hashSource("Pharmacist"), hashSource("Hands out medicine to patients.")] }
    }).lean()
    expect(rows.map((r) => [r.text, r.origin]).sort()).toEqual([
      ["Dược sĩ", "author"],
      ["Phát thuốc cho bệnh nhân.", "author"]
    ])
    expect(await TranslationGlossary.findOne({ projectId: seeded.projectId, locale: "vi", term: "Pharmacist" }).lean()).toMatchObject({ translation: "Dược sĩ" })
  })

  it("đầu ra kèm khối bị cắt ⇒ thử lại một lần không kèm khối: Spine vẫn ghi, không có bản author, chỉ trừ credit một lượt", async () => {
    const walletBefore = await CreditWallet.findOne({ organizationId: seeded.orgId }).lean()
    mockOverrides.next = (prompt) => {
      prompts.push(prompt)
      return prompt.includes(BLOCK) ? '{"ops":[{"op":"set","path":"actors[id=A01].name","value":"Prod' : JSON.stringify({ ops: [rename] })
    }

    await previewThenApply()

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain(BLOCK)
    expect(prompts[1]).not.toContain(BLOCK)
    expect(await actorName()).toBe("Product Owner")
    expect(await SpineTranslation.countDocuments({ projectId: seeded.projectId })).toBe(0)

    const walletAfter = await CreditWallet.findOne({ organizationId: seeded.orgId }).lean()
    // change_instruction = 3 credit, giá không đổi khi bật khối; lượt thử lại nằm trong cùng một lần giữ credit
    expect((walletBefore?.balance ?? 0) - (walletAfter?.balance ?? 0)).toBe(3)
    expect(walletAfter?.reserved).toBe(0)
  })

  it("non_english_content vẫn bắt chữ Việt ghi thẳng vào Spine ở mode 2 dù documentLanguage = vi", async () => {
    const res = await client().post("/changes", {
      base_version: seeded.spineVersion,
      ops: [{ op: "set", path: "actors[id=A01].name", value: "Quản trị viên" }]
    })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const spine = (await Spine.findOne({ projectId: seeded.projectId }).lean()) as { flags: { rule_id: string; target_id?: string | null; resolved_at: string | null }[] }
    expect(spine.flags.filter((f) => f.rule_id === "non_english_content" && f.resolved_at === null).map((f) => f.target_id)).toContain("A01")
  })
})
