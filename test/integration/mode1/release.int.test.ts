/**
 * Release mode 1 (FLF-172, P4 §8.3 `release.test.ts`; plan §6 2F, Flow 6, UC-57) trên Mongo in-memory + provider giả:
 * đỏ > 0 ⇒ chặn; gom đúng CR từ lần release trước; bản sạch; baseline `type: release`; nhánh lỗi của `release.service`
 * và kho GridFS `doc-file.store`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import mongoose from "mongoose"

const failSnapshot = vi.hoisted(() => ({ on: false }))

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../../src/modules/pipeline/s9/baseline.service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../src/modules/pipeline/s9/baseline.service.js")>()
  return {
    ...orig,
    snapshotBaseline: (async (...args: Parameters<typeof orig.snapshotBaseline>) => {
      if (failSnapshot.on) throw new Error("snapshot boom")
      return orig.snapshotBaseline(...args)
    }) as typeof orig.snapshotBaseline
  }
})

import { seedFixture } from "../../setup.js"
import { resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, mode1Api } from "../../helpers/mode1.js"
import {
  binary,
  createCr,
  crDetail,
  documentXml,
  gridFsFileCount,
  importedProject,
  releaseNow,
  routeReplaceCr,
  writeCr,
  type Mode1Api
} from "../../helpers/mode1-release-p4.js"
import { releaseResponseSchema, versionsResponseSchema } from "../../../src/modules/doc-version/doc-version.dto.js"
import { release } from "../../../src/modules/doc-version/release.service.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { DocFileNotFoundError, docFileStore, gridFsDocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocxPackage, readBlocks, readStamp } from "../../../src/modules/docx-ooxml/index.js"
import { lockedPaths } from "../../helpers/mode1-cr-p4.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

const PERF = "The system shall respond"

beforeEach(() => {
  resetMockLlm()
  failSnapshot.on = false
  routeReplaceCr("2 seconds", "1 second", { extraKeywords: ["Passwords"], commentOn: /^business_rules\[/ })
})

/** Import ⇒ CR-001 (sửa NFR perf + ghi chú luật mật khẩu) ⇒ 0.1. */
const projectWithRevision = async () => {
  const ctx = await importedProject()
  const first = await writeCr(ctx.c, "Faster", "1 second instead of 2 seconds")
  expect(first).toEqual({ crId: "CR-001", version: "0.1" })
  return ctx
}

const addRedFlag = async (projectId: string) => {
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
}

const released = async (c: Mode1Api) => {
  const res = await releaseNow(c)
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return releaseResponseSchema.parse(res.body.data)
}

describe("release — chặn", () => {
  it("đỏ > 0 ⇒ 422 RELEASE_RED_FLAGS_OPEN kèm cờ; không tạo version, không lưu file, Spine không có baseline release", async () => {
    const { c, projectId } = await projectWithRevision()
    await addRedFlag(projectId)
    const filesBefore = await gridFsFileCount(projectId)
    const blocked = await releaseNow(c)
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.code).toBe("RELEASE_RED_FLAGS_OPEN")
    expect(blocked.body.meta.flags.length).toBeGreaterThan(0)
    expect(blocked.body.meta.flags.every((f: { level: string }) => f.level === "red")).toBe(true)
    expect(await gridFsFileCount(projectId)).toBe(filesBefore)
    expect(await DocVersion.countDocuments({ projectId, kind: "release" })).toBe(0)
    const spine = (await spineRepository.get(projectId))!
    expect(spine.baselines.some((b) => b.type === "release")).toBe(false)
  })

  it("base_version lệch ⇒ 409 SPINE_VERSION_CONFLICT; project chưa import ⇒ 404 DOC_VERSION_NOT_FOUND; không có Spine ⇒ 404", async () => {
    const { c } = await projectWithRevision()
    const stale = await c.post("/release", { base_version: (await c.spineVersion()) - 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("SPINE_VERSION_CONFLICT")

    const seeded = await seedFixture("minimal")
    const fresh = mode1Api(seeded, await createMode1Project(seeded, "Chưa import"))
    const none = await releaseNow(fresh)
    expect(none.status).toBe(404)
    expect(none.body.error.code).toBe("DOC_VERSION_NOT_FOUND")

    const missing = new mongoose.Types.ObjectId().toHexString()
    await expect(release(missing, seeded.userId, 1)).rejects.toMatchObject({ statusCode: 404, code: spineRepository.SPINE_NOT_FOUND })
  })

  it("thiếu base_version ⇒ 400", async () => {
    const { c } = await projectWithRevision()
    expect((await c.post("/release", {})).status).toBe(400)
  })
})

describe("release — bản sạch + baseline", () => {
  it("1.0 = render snapshot Spine (FLF-186): stamp release, nội dung sau CR, không Track Changes; baseline type release snapshot Spine", async () => {
    const { c, projectId } = await projectWithRevision()
    const spineBefore = (await spineRepository.get(projectId))!
    const rel = await released(c)
    expect(rel.version).toMatchObject({ version: "1.0", kind: "release", based_on: "0.1", has_clean_file: true })
    expect(rel.cr_ids).toEqual(["CR-001"])
    expect(rel.baseline).toMatchObject({ type: "release", version: "1.0", doc_version: "1.0" })
    expect(rel.spine_version).toBeGreaterThan(spineBefore.spine_version)

    const spine = (await spineRepository.get(projectId))!
    const entry = spine.baselines.find((b) => b.type === "release")!
    expect(entry).toMatchObject({ id: rel.baseline.id, version: "1.0", doc_version: "1.0" })
    const v10 = await DocVersion.findOne({ projectId, version: "1.0" }).lean()
    expect(v10).toMatchObject({ kind: "release", baseline_ref: rel.baseline.id, cr_ids: ["CR-001"] })

    // bản sạch = bản render (file_ref và clean_file_ref cùng một file)
    expect(v10!.clean_file_ref).toBe(v10!.file_ref)
    const clean = await DocxPackage.load(await docFileStore().load(v10!.clean_file_ref!))
    expect(await readStamp(clean)).toEqual({ project_id: projectId, version: "1.0", source: "release" })
    const cleanXml = await documentXml(await docFileStore().load(v10!.clean_file_ref!))
    expect(cleanXml).not.toMatch(/<w:ins\b|<w:del\b|<w:delText\b|commentReference|commentRangeStart/)
    const cleanBlocks = await readBlocks(clean)
    expect(cleanBlocks.find((b) => b.text.startsWith(PERF))?.text).toContain("1 second")
    expect(cleanBlocks.find((b) => b.text.startsWith(PERF))?.text).not.toContain("2 seconds")

    // tải về 1.0 ⇒ bản sạch không _DRAFT
    const dl = await binary(c.get("/versions/1.0/download"))
    expect(decodeURIComponent(String(dl.headers["content-disposition"]))).toContain("Lumen LMS_v1.0.docx")
    expect(await documentXml(dl.body as Buffer)).not.toMatch(/<w:ins\b|<w:del\b/)
  })
})

describe("release — gom CR", () => {
  it("2.0 chỉ gom CR written sau 1.0, theo thứ tự ghi; CR huỷ không được gom; baseline release thứ hai", async () => {
    const { c, projectId } = await projectWithRevision()
    expect((await released(c)).cr_ids).toEqual(["CR-001"])

    routeReplaceCr("1 second", "500 ms")
    expect(await writeCr(c, "Nhanh hơn", "500 ms")).toEqual({ crId: "CR-002", version: "1.1" })
    // CR-003 huỷ giữa chừng
    const cancelled = await createCr(c, "Bỏ", "không làm nữa")
    crDetail(await c.post(`/change-requests/${cancelled}/clarify`))
    crDetail(await c.post(`/change-requests/${cancelled}/cancel`, { reason: "Khách đổi ý, không cần nữa" }))
    routeReplaceCr("500 ms", "200 ms")
    expect(await writeCr(c, "Nhanh nữa", "200 ms")).toEqual({ crId: "CR-004", version: "1.2" })

    const second = await released(c)
    expect(second.version).toMatchObject({ version: "2.0", based_on: "1.2" })
    expect(second.cr_ids).toEqual(["CR-002", "CR-004"])
    expect(second.baseline).toMatchObject({ type: "release", version: "2.0", doc_version: "2.0" })

    const spine = (await spineRepository.get(projectId))!
    expect(spine.baselines.filter((b) => b.type === "release").map((b) => b.version)).toEqual(["1.0", "2.0"])
    const versions = versionsResponseSchema.parse((await c.get("/versions")).body.data)
    expect(versions.map((v) => v.version)).toEqual(["2.0", "1.2", "1.1", "1.0", "0.1", "0.0"])

    const v20 = await DocVersion.findOne({ projectId, version: "2.0" }).lean()
    const clean = await DocxPackage.load(await docFileStore().load(v20!.clean_file_ref!))
    expect((await readBlocks(clean)).find((b) => b.text.startsWith(PERF))?.text).toContain("200 ms")
    expect(await documentXml(await docFileStore().load(v20!.clean_file_ref!))).not.toMatch(/<w:ins\b|<w:del\b/)
  })

  it("CR đang dở không chặn release: khoá phần tử (theo path) giữ nguyên qua release, CR không bị gom", async () => {
    const { c, projectId } = await projectWithRevision()
    routeReplaceCr("1 second", "500 ms")
    const pending = await createCr(c, "Đang dở", "500 ms")
    crDetail(await c.post(`/change-requests/${pending}/clarify`))
    const impact = crDetail(await c.post(`/change-requests/${pending}/impact`))
    expect(impact.locations.length).toBeGreaterThan(0)
    const held = await lockedPaths(projectId, pending)
    expect(held.length).toBeGreaterThan(0)

    const rel = await released(c)
    expect(rel.cr_ids).toEqual(["CR-001"])
    expect(await lockedPaths(projectId, pending)).toEqual(held)
    const detail = crDetail(await c.get(`/change-requests/${pending}`))
    expect(detail.change_request.status).toBe("impact_review")
  })
})

describe("release — lỗi giữa chừng", () => {
  it("snapshot baseline lỗi ⇒ xoá file vừa lưu (không mồ côi), không tạo version; chạy lại được", async () => {
    const { c, projectId } = await projectWithRevision()
    const filesBefore = await gridFsFileCount(projectId)
    failSnapshot.on = true
    const res = await releaseNow(c)
    expect(res.status).toBe(500)
    expect(await gridFsFileCount(projectId)).toBe(filesBefore)
    expect(await DocVersion.countDocuments({ projectId, version: "1.0" })).toBe(0)

    failSnapshot.on = false
    const again = await released(c)
    expect(again.version.version).toBe("1.0")
    expect(await gridFsFileCount(projectId)).toBe(filesBefore + 1)
  })
})

describe("doc-file.store — GridFS", () => {
  it("save/load giữ nguyên byte + metadata; ref hợp lệ nhưng không có / ref sai ⇒ DocFileNotFoundError", async () => {
    const data = Buffer.from([0, 1, 2, 250, 255])
    const ref = await gridFsDocFileStore.save(data, { projectId: "P1", kind: "upload", name: "SRS.docx" })
    expect(mongoose.isValidObjectId(ref)).toBe(true)
    expect(Buffer.compare(await gridFsDocFileStore.load(ref), data)).toBe(0)
    const file = await mongoose.connection.db!.collection("source-docs.files").findOne({ _id: new mongoose.Types.ObjectId(ref) })
    expect(file).toMatchObject({ filename: "P1/upload/SRS.docx", metadata: { projectId: "P1", kind: "upload", name: "SRS.docx" } })

    await expect(gridFsDocFileStore.load(new mongoose.Types.ObjectId().toHexString())).rejects.toBeInstanceOf(DocFileNotFoundError)
    await expect(gridFsDocFileStore.load("khong-phai-id")).rejects.toBeInstanceOf(DocFileNotFoundError)
  })

  it("file lớn nhiều chunk đọc lại đủ", async () => {
    const big = Buffer.alloc(600 * 1024, 7)
    const ref = await gridFsDocFileStore.save(big, { projectId: "P2", kind: "version", name: "0.0" })
    const back = await gridFsDocFileStore.load(ref)
    expect(back.length).toBe(big.length)
    expect(Buffer.compare(back, big)).toBe(0)
  })

  it("remove: xoá được; ref không có / ref sai ⇒ im lặng; removeProject chỉ xoá file của project đó", async () => {
    const a = await gridFsDocFileStore.save(Buffer.from("a"), { projectId: "A", kind: "version", name: "0.0" })
    await gridFsDocFileStore.save(Buffer.from("a2"), { projectId: "A", kind: "clean", name: "1.0" })
    const b = await gridFsDocFileStore.save(Buffer.from("b"), { projectId: "B", kind: "version", name: "0.0" })
    await gridFsDocFileStore.remove(a)
    await expect(gridFsDocFileStore.load(a)).rejects.toBeInstanceOf(DocFileNotFoundError)
    await expect(gridFsDocFileStore.remove(a)).resolves.toBeUndefined()
    await expect(gridFsDocFileStore.remove(new mongoose.Types.ObjectId().toHexString())).resolves.toBeUndefined()
    await expect(gridFsDocFileStore.remove("khong-phai-id")).resolves.toBeUndefined()

    await gridFsDocFileStore.removeProject("A")
    expect(await gridFsFileCount("A")).toBe(0)
    expect(await gridFsFileCount("B")).toBe(1)
    expect((await gridFsDocFileStore.load(b)).toString()).toBe("b")
    await expect(gridFsDocFileStore.removeProject("khong-co")).resolves.toBeUndefined()
  })
})
