/**
 * Mode 1 — version, tải về, release (Flow 6) và chặn sửa ngoài CR (G9, BR-03) qua HTTP trên Mongo thật
 * (FLF-171, P2 2F + 2G).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import JSZip from "jszip"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../src/app.js"
import { seedFixture } from "../setup.js"
import { mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { createMode1Project, fakeCrClarify, fakeCrPropose, fakeMode1, mode1Api } from "../helpers/mode1.js"
import { fillCoreSections, markBaselineV1 } from "../helpers/mode1-v2.js"
import { routeReplaceCr } from "../helpers/mode1-release-p4.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { changeRequestDetailSchema } from "../../src/modules/change-request/change-request.dto.js"
import { compareResponseSchema, releaseResponseSchema, versionBlocksResponseSchema, versionsResponseSchema } from "../../src/modules/doc-version/doc-version.dto.js"
import { changeRequiresCrMetaSchema } from "../../src/modules/change-request/change-request.dto.js"
import { applyTransaction } from "../../src/modules/spine/op-engine.js"
import { DocxPackage, readBlocks } from "../../src/modules/docx-ooxml/index.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"

const TARGETS = { entity_paths: ["nfrs[id=NFR-01]"], keywords: ["2 seconds"] }

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = (p) => fakeMode1(p) ?? fakeCrClarify(TARGETS)(p) ?? fakeCrPropose(p)
})

type Api = ReturnType<typeof mode1Api>

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = []
    res.on("data", (d: Buffer) => chunks.push(d))
    res.on("end", () => cb(null, Buffer.concat(chunks)))
  })

const documentXml = async (buf: Buffer): Promise<string> => (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string")

/** Import ⇒ gap_review ⇒ CR-001 sửa câu perf ⇒ version 0.1. */
const projectWithRevision = async () => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded, "Lumen LMS")
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
  await c.post("/import/confirm-latest", { import_id: id })
  await c.extractAndWait(id)
  await c.patch("/import/fields", { import_id: id, confirm_all: true })
  expect((await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })).status).toBe(200)
  // D6 (FLF-183): điền các đầu mục FPT còn trống như đã chạy step, để release chỉ còn chặn bởi cờ test đặt
  await fillCoreSections(projectId)

  const created = await c.post("/change-requests", { title: "Faster", description: "1 second instead of 2 seconds", source: { kind: "verbal" }, requester: "PM" })
  const cr = `/change-requests/${created.body.data.change_request.cr_id}`
  for (const step of ["clarify", "impact", "propose", "verify", "submit"]) expect((await c.post(`${cr}/${step}`)).status).toBe(200)
  const groups = changeRequestDetailSchema.parse((await c.get(cr)).body.data).groups
  for (const g of groups) {
    const res = await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  }
  return { seeded, projectId, c }
}

const releaseNow = async (c: Api) => c.post("/release", { base_version: await c.spineVersion() })

describe("mode 1 — version + tải về", () => {
  it("danh sách version, block đọc từ file render, so sánh 0.0 → 0.1, tải bản draft có watermark DRAFT", async () => {
    const { c } = await projectWithRevision()
    const versions = versionsResponseSchema.parse((await c.get("/versions")).body.data)
    expect(versions.map((v) => [v.version, v.kind])).toEqual([
      ["0.1", "cr_revision"],
      ["0.0", "imported"]
    ])

    const blocks = versionBlocksResponseSchema.parse((await c.get("/versions/0.1/blocks")).body.data)
    // FLF-186: 0.1 là bản render từ Spine sau CR — NFR hiện trong bảng Performance, không còn Track Changes theo block
    const perf = blocks.find((b) => b.text.includes("The system shall respond"))!
    expect(perf.text).toContain("1 s")
    expect(perf.revisions).toBeUndefined()
    expect((await c.get("/versions/9.9/blocks")).body.error.code).toBe("DOC_VERSION_NOT_FOUND")

    const diff = compareResponseSchema.parse((await c.get("/versions/compare?from=0.0&to=0.1")).body.data)
    // bảng Performance: khớp theo text (file render không có neo) ⇒ modified 2 s → 1 s
    expect(diff.blocks).toContainEqual(
      expect.objectContaining({ block_id: null, change: "modified", before: expect.stringContaining("| 2 s |"), after: expect.stringContaining("| 1 s |") })
    )
    expect((await c.get("/versions/compare?from=0.1&to=0.1")).status).toBe(400)

    const draft = await binary(c.get("/versions/0.1/download"))
    expect(draft.status).toBe(200)
    expect(decodeURIComponent(String(draft.headers["content-disposition"]))).toContain("Lumen LMS_v0.1_DRAFT.docx")
    const zip = await JSZip.loadAsync(draft.body as Buffer)
    const headers = Object.keys(zip.files).filter((n) => /^word\/header\d+\.xml$/.test(n))
    expect(headers.length).toBeGreaterThan(0)
    expect(await zip.file(headers[0])!.async("string")).toContain('string="DRAFT"')
    // §I Record of Changes của bản render có dòng của CR
    expect(await documentXml(draft.body as Buffer)).toContain("CR-001: Faster")
  })
})

describe("mode 1 — release (Flow 6)", () => {
  it("còn cờ đỏ ⇒ 422 RELEASE_RED_FLAGS_OPEN; hết đỏ ⇒ 1.0 sạch, baseline release, gom CR", async () => {
    const { c, projectId } = await projectWithRevision()
    // Sơ đồ render lỗi ⇒ cờ đỏ render_error (mode 1 không waive)
    const spine = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, {
      base_version: spine.spine_version,
      by: "test",
      ops: [
        {
          op: "add",
          path: "diagrams[]",
          value: { id: "D01", kind: "erd", puml: "@startuml\n@enduml", section: "fixed:3.1.5", owner_kind: null, owner_id: null, render_status: "error", error: "boom", source_hash: "x", rendered_at: null }
        }
      ]
    })
    const blocked = await releaseNow(c)
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.code).toBe("RELEASE_RED_FLAGS_OPEN")
    expect(blocked.body.meta.flags.map((f: { rule_id: string }) => f.rule_id)).toContain("render_error")

    const now = (await spineRepository.get(projectId))!
    await applyTransaction(projectId, { base_version: now.spine_version, by: "test", ops: [{ op: "remove", path: "diagrams[id=D01]" }] })
    const res = await releaseNow(c)
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const rel = releaseResponseSchema.parse(res.body.data)
    expect(rel.version).toMatchObject({ version: "1.0", kind: "release", based_on: "0.1", has_clean_file: true })
    expect(rel.cr_ids).toEqual(["CR-001"])
    expect(rel.baseline).toMatchObject({ type: "release", version: "1.0", doc_version: "1.0" })

    const clean = await binary(c.get("/versions/1.0/download"))
    expect(decodeURIComponent(String(clean.headers["content-disposition"]))).toContain("Lumen LMS_v1.0.docx")
    const xml = await documentXml(clean.body as Buffer)
    expect(xml).not.toMatch(/<w:ins\b|<w:del\b|commentReference/)
    const cleanBlocks = await readBlocks(await DocxPackage.load(clean.body as Buffer))
    expect(cleanBlocks.find((b) => b.text.includes("The system shall respond"))?.text).toContain("1 second")
    // FLF-186: bản release = render snapshot — bản "tracked" cũng là bản render (bản đánh dấu theo section: để sau)
    const tracked = await documentXml((await binary(c.get("/versions/1.0/download?variant=tracked"))).body as Buffer)
    expect(tracked).not.toMatch(/<w:ins\b/)

    // CR sau release ⇒ 1.1 render từ Spine mới
    routeReplaceCr("1 second", "500 ms")
    const created = await c.post("/change-requests", { title: "Even faster", description: "500 ms", source: { kind: "verbal" }, requester: "PM" })
    const cr = `/change-requests/${created.body.data.change_request.cr_id}`
    for (const step of ["clarify", "impact", "propose", "verify", "submit"]) expect((await c.post(`${cr}/${step}`)).status).toBe(200)
    let done = null as Awaited<ReturnType<typeof c.post>> | null
    for (const g of changeRequestDetailSchema.parse((await c.get(cr)).body.data).groups) {
      done = await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() })
    }
    expect(done!.body.data.change_request.result_doc_version).toBe("1.1")
    const v11 = await documentXml((await binary(c.get("/versions/1.1/download"))).body as Buffer)
    expect(v11).toContain("500 ms")
    expect(v11).toContain("CR-002: Even faster")
  })
})

describe("mode 1 — chặn sửa ngoài change request (G9, BR-03)", () => {
  it("/changes, /changes/preview, /undo, /reconcile và chat ra lệnh sửa ⇒ 409 CHANGE_REQUIRES_CR kèm prefill; chat hỏi đáp vẫn đi", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    // D3 (FLF-183): chặn chỉ áp sau baseline v1
    await markBaselineV1(projectId)
    const auth = { Authorization: `Bearer ${seeded.token}` }
    const base = `/api/v1/projects/${projectId}`
    const version = (await request(app).get(`${base}/spine`).set(auth)).body.data.spine_version as number

    const change = await request(app).post(`${base}/changes`).set(auth).send({ base_version: version, instruction: "Rename actor Learner to Student" })
    expect(change.status).toBe(409)
    expect(change.body.error.code).toBe("CHANGE_REQUIRES_CR")
    expect(changeRequiresCrMetaSchema.parse(change.body.meta).prefill).toEqual({
      title: "Rename actor Learner to Student",
      description: "Rename actor Learner to Student"
    })
    for (const path of ["/changes/preview", "/undo", "/reconcile"]) {
      const res = await request(app).post(`${base}${path}`).set(auth).send({ base_version: version, instruction: "Rename actor" })
      expect(res.body.error?.code, path).toBe("CHANGE_REQUIRES_CR")
    }

    const chat = await request(app).post(`${base}/chats`).set(auth).send({})
    const chatId = chat.body.data._id as string
    const edit = await request(app).post(`${base}/chats/${chatId}/messages`).set(auth).send({ content: "Rename actor Learner to Student", step: "B-1.1" })
    expect(edit.status).toBe(409)
    expect(edit.body).toMatchObject({ error: { code: "CHANGE_REQUIRES_CR" }, meta: { prefill: { title: "Rename actor Learner to Student" } } })
    const stream = await request(app).post(`${base}/chats/${chatId}/messages/stream`).set(auth).send({ content: "Delete use case UC-01", step: "B-1.1" })
    expect(stream.status).toBe(409)

    // project mode 2 không bị chặn
    const fpt = await request(app).post(`/api/v1/projects/${seeded.projectId}/changes/preview`).set(auth).send({ base_version: seeded.spineVersion, ops: [{ op: "set", path: "project.vision", value: "x" }] })
    expect(fpt.body.error?.code).not.toBe("CHANGE_REQUIRES_CR")
  })
})
