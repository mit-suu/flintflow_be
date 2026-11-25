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
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { mockRecordSummaryRows } from "../../../src/shared/ai/providers/mock.provider.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
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
import { TemplateMigration } from "../../../src/modules/template-migration/template-migration.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { DocFileNotFoundError, clearDocFileCache, docFileStore, gridFsDocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
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
  expect(first).toEqual({ crId: "CR-001", version: "0.2" })
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
        value: { id: "D99", kind: "erd", format: "puml", source: "@startuml\n@enduml", section: "fixed:3.1.5", owner_kind: null, owner_id: null, render_status: "error", error: "boom", source_hash: "x", rendered_at: null }
      }
    ]
  })
}

const released = async (c: Mode1Api) => {
  const res = await releaseNow(c)
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return releaseResponseSchema.parse(res.body.data)
}

describe("release - chặn", () => {
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

describe("release - bản sạch + baseline", () => {
  it("1.0 = render snapshot Spine (FLF-186): stamp release, nội dung sau CR, không Track Changes; baseline type release snapshot Spine", async () => {
    const { c, projectId } = await projectWithRevision()
    const spineBefore = (await spineRepository.get(projectId))!
    const rel = await released(c)
    expect(rel.version).toMatchObject({ version: "1.0", kind: "release", based_on: "0.2", has_clean_file: true })
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
    expect(await readStamp(clean)).toEqual({ project_id: projectId, version: "1.0", source: "release", base_version: null, latest_cr: null, kind: null })
    const cleanXml = await documentXml(await docFileStore().load(v10!.clean_file_ref!))
    expect(cleanXml).not.toMatch(/<w:ins\b|<w:del\b|<w:delText\b|commentReference|commentRangeStart/)
    const cleanBlocks = await readBlocks(clean)
    expect(cleanBlocks.find((b) => b.text.startsWith(PERF))?.text).toContain("1 second")
    expect(cleanBlocks.find((b) => b.text.startsWith(PERF))?.text).not.toContain("2 seconds")

    // tải về 1.0 ⇒ bản sạch không _DRAFT
    const dl = await binary(c.get("/versions/1.0/download"))
    expect(decodeURIComponent(String(dl.headers["content-disposition"]))).toContain("Lumen LMS_v1.0.docx")
    expect(await readStamp(await DocxPackage.load(dl.body as Buffer))).toEqual({ project_id: projectId, version: "1.0", source: "release", base_version: "1.0", latest_cr: null, kind: "release" })
    expect(await documentXml(dl.body as Buffer)).not.toMatch(/<w:ins\b|<w:del\b/)

    // FLF-316: format=pdf đi qua Gotenberg — test trỏ cổng đóng ⇒ 503 có mã riêng, bản .docx vẫn tải được
    const pdf = await c.get("/versions/1.0/download?format=pdf")
    expect(pdf.status).toBe(503)
    expect(pdf.body.error.code).toBe("PDF_EXPORT_UNAVAILABLE")
    expect((await c.get("/versions/1.0/download?variant=original&format=pdf")).status).toBe(400)
  })
})

describe("release - gom CR", () => {
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
    expect(versions.map((v) => v.version)).toEqual(["2.0", "1.2", "1.1", "1.0", "0.2", "0.1"])

    const v20 = await DocVersion.findOne({ projectId, version: "2.0" }).lean()
    const clean = await DocxPackage.load(await docFileStore().load(v20!.clean_file_ref!))
    expect((await readBlocks(clean)).find((b) => b.text.startsWith(PERF))?.text).toContain("200 ms")
    expect(await documentXml(await docFileStore().load(v20!.clean_file_ref!))).not.toMatch(/<w:ins\b|<w:del\b/)
  })

  it("CR đang dở không chặn release (đề xuất chưa xác nhận không nằm trong bản nháp), CR không bị gom", async () => {
    const { c, projectId } = await projectWithRevision()
    routeReplaceCr("1 second", "500 ms")
    const pending = await createCr(c, "Đang dở", "500 ms")
    crDetail(await c.post(`/change-requests/${pending}/clarify`))
    const impact = crDetail(await c.post(`/change-requests/${pending}/impact`))
    expect(impact.locations.length).toBeGreaterThan(0)
    // FLF-375 (§3.2): không khoá chỗ đang sửa
    expect(await lockedPaths(projectId, pending)).toEqual([])

    const rel = await released(c)
    expect(rel.cr_ids).toEqual(["CR-001"])
    expect(await lockedPaths(projectId, pending)).toEqual([])
    const detail = crDetail(await c.get(`/change-requests/${pending}`))
    expect(detail.change_request.status).toBe("impact_review")
  })
})

describe("release - bản Track Changes gộp (FLF-484)", () => {
  it("1.0 gộp thay đổi của cả hai CR so với bản gốc; bản sạch không có w:ins; tải được `_v1.0_tracked.docx`", async () => {
    const { c, projectId } = await projectWithRevision()
    routeReplaceCr("1 second", "500 ms")
    expect(await writeCr(c, "Nhanh hơn", "500 ms")).toEqual({ crId: "CR-002", version: "0.3" })
    const rel = await released(c)
    expect(rel.cr_ids).toEqual(["CR-001", "CR-002"])
    expect(rel.version.has_tracked_file).toBe(true)
    const v10 = await DocVersion.findOne({ projectId, version: "1.0" }).lean()
    expect(v10!.tracked_file_ref).toBeTruthy()
    expect(v10!.tracked_file_ref).not.toBe(v10!.file_ref)

    const trackedXml = await documentXml(await docFileStore().load(v10!.tracked_file_ref!))
    expect(trackedXml).toMatch(/<w:ins[ >]/)
    expect(trackedXml).toMatch(/<w:del[ >]/)
    expect(trackedXml).toContain("500 ms")
    expect(trackedXml).toContain("2 seconds")
    expect(trackedXml).toContain('w:author="CR-001, CR-002"')
    expect(await documentXml(await docFileStore().load(v10!.clean_file_ref!))).not.toMatch(/<w:ins[ >]|<w:del[ >]/)

    const versions = versionsResponseSchema.parse((await c.get("/versions")).body.data)
    expect(versions.find((v) => v.version === "1.0")?.has_tracked_file).toBe(true)
    const dl = await binary(c.get("/versions/1.0/download?variant=tracked"))
    expect(dl.status).toBe(200)
    expect(decodeURIComponent(String(dl.headers["content-disposition"]))).toContain("Lumen LMS_v1.0_tracked.docx")
  })

  it("2.0 so với 1.0, không so với bản gốc: chỉ hiện thay đổi sau 1.0", async () => {
    const { c, projectId } = await projectWithRevision()
    await released(c)
    routeReplaceCr("1 second", "500 ms")
    expect(await writeCr(c, "Nhanh hơn", "500 ms")).toEqual({ crId: "CR-002", version: "1.1" })
    const second = await released(c)
    expect(second.version.has_tracked_file).toBe(true)
    const v20 = await DocVersion.findOne({ projectId, version: "2.0" }).lean()
    const xml = await documentXml(await docFileStore().load(v20!.tracked_file_ref!))
    expect(xml).toContain('w:author="CR-002"')
    expect(xml).not.toContain('w:author="CR-001')
    expect(xml).toMatch(/<w:ins[ >]/)
    // CR-001 (2 seconds ⇒ 1 second) đã nằm trong 1.0, không phải thay đổi của 2.0
    expect(xml).not.toContain("2 seconds")
  })
})

describe("release - bản Track Changes khi có đổi mẫu giữa hai lần phát hành (FLF-484)", () => {
  // Chèn thẳng bản ghi đổi mẫu đã áp dụng (không qua dịch vụ đổi mẫu): `trackedPolicySince` chỉ đọc `state`, `applied_at`, `translated`
  const insertMigration = (projectId: string, translated: boolean) =>
    TemplateMigration.collection.insertOne({ projectId: new mongoose.Types.ObjectId(projectId), state: "applied", applied_at: new Date(Date.now() + 1000), translated })

  it("đổi mẫu kèm dịch ⇒ bản phát hành không có bản đánh dấu", async () => {
    const { c, projectId } = await projectWithRevision()
    await insertMigration(projectId, true)
    const rel = await released(c)
    expect(rel.version.has_tracked_file).toBe(false)
    expect((await DocVersion.findOne({ projectId, version: "1.0" }).lean())!.tracked_file_ref).toBeNull()
  })

  it("đổi mẫu không dịch ⇒ vẫn có bản đánh dấu (chỉ so nội dung)", async () => {
    const { c, projectId } = await projectWithRevision()
    await insertMigration(projectId, false)
    const rel = await released(c)
    expect(rel.version.has_tracked_file).toBe(true)
    expect((await DocVersion.findOne({ projectId, version: "1.0" }).lean())!.tracked_file_ref).toBeTruthy()
  })
})

describe("nhãn đầu tài liệu theo số bản nháp (FLF-484)", () => {
  const draftLabel = async (c: Mode1Api) => {
    const res = await c.get("/document?source=draft")
    expect(res.status).toBe(200)
    return res.body.data.version as string
  }

  it("bản nháp mang đúng số version mới nhất, không còn `+ N changes`; sau phát hành là 1.0", async () => {
    const { c } = await projectWithRevision()
    expect(await draftLabel(c)).toBe("0.2")
    await released(c)
    expect(await draftLabel(c)).toBe("1.0")
  })

  it("version mới mà spine_version không đổi (CR chỉ có comment) ⇒ nhãn theo version mới, không dính cache", async () => {
    const { c, projectId } = await projectWithRevision()
    expect(await draftLabel(c)).toBe("0.2")
    const prev = (await DocVersion.findOne({ projectId, version: "0.2" }).lean())!
    const { _id, ...rest } = prev
    await DocVersion.create({ ...rest, version: "0.3", based_on: "0.2", cr_ids: ["CR-099"], tracked_file_ref: null })
    expect(await draftLabel(c)).toBe("0.3")
  })

  it("tên file xuất bản nháp theo số version: `_v0.2_DRAFT.docx`", async () => {
    const { c } = await projectWithRevision()
    const res = await binary(c.get("/export/word?source=draft"))
    expect(res.status).toBe(200)
    expect(decodeURIComponent(String(res.headers["content-disposition"]))).toContain("_v0.2_DRAFT.docx")
  })
})

describe("release - lỗi giữa chừng", () => {
  it("snapshot baseline lỗi ⇒ xoá file vừa lưu (không mồ côi), không tạo version; chạy lại được", async () => {
    const { c, projectId } = await projectWithRevision()
    const filesBefore = await gridFsFileCount(projectId)
    failSnapshot.on = true
    const res = await releaseNow(c)
    expect(res.status).toBe(500)
    // xoá cả bản sạch lẫn bản Track Changes gộp
    expect(await gridFsFileCount(projectId)).toBe(filesBefore)
    expect(await DocVersion.countDocuments({ projectId, version: "1.0" })).toBe(0)

    failSnapshot.on = false
    const again = await released(c)
    expect(again.version.version).toBe("1.0")
    // bản sạch + bản Track Changes gộp (FLF-484)
    expect(await gridFsFileCount(projectId)).toBe(filesBefore + 2)
  })
})

describe("doc-file.store - GridFS", () => {
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

  it("FLF-377: đọc lần hai lấy từ cache (không tải lại GridFS), trả bản sao; xoá file ⇒ bỏ cache", async () => {
    clearDocFileCache()
    const data = Buffer.from("mẫu bắt buộc")
    const ref = await gridFsDocFileStore.save(data, { projectId: "P3", kind: "upload", name: "Mau.docx" })
    const first = await gridFsDocFileStore.load(ref)
    // Xoá thẳng trong GridFS (không qua store) ⇒ lần đọc sau chỉ có thể đến từ cache
    await mongoose.connection.db!.collection("source-docs.chunks").deleteMany({ files_id: new mongoose.Types.ObjectId(ref) })
    const second = await gridFsDocFileStore.load(ref)
    expect(Buffer.compare(second, data)).toBe(0)
    // Bên gọi sửa buffer không làm hỏng cache
    first.fill(0)
    second.fill(0)
    expect(Buffer.compare(await gridFsDocFileStore.load(ref), data)).toBe(0)
    await gridFsDocFileStore.remove(ref)
    await expect(gridFsDocFileStore.load(ref)).rejects.toBeInstanceOf(DocFileNotFoundError)
  })

  it("file lớn nhiều chunk đọc lại đủ", async () => {
    const big = Buffer.alloc(600 * 1024, 7)
    const ref = await gridFsDocFileStore.save(big, { projectId: "P2", kind: "version", name: "0.1" })
    const back = await gridFsDocFileStore.load(ref)
    expect(back.length).toBe(big.length)
    expect(Buffer.compare(back, big)).toBe(0)
  })

  it("remove: xoá được; ref không có / ref sai ⇒ im lặng; removeProject chỉ xoá file của project đó", async () => {
    const a = await gridFsDocFileStore.save(Buffer.from("a"), { projectId: "A", kind: "version", name: "0.1" })
    await gridFsDocFileStore.save(Buffer.from("a2"), { projectId: "A", kind: "clean", name: "1.0" })
    const b = await gridFsDocFileStore.save(Buffer.from("b"), { projectId: "B", kind: "version", name: "0.1" })
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

describe("release - AI viết gọn mô tả Record of Changes (FLF-492)", () => {
  const SUMMARY_PROMPT = "Record of Changes - concise descriptions"
  let summaryCalls = 0

  /** Trả lời lượt viết gọn bằng provider mock thật (rút gọn câu dựng sẵn); lượt khác đi đường mặc định. */
  const answerSummary = (fail = false) => {
    summaryCalls = 0
    mockOverrides.next = (prompt) => {
      if (!prompt.includes(SUMMARY_PROMPT)) return undefined
      summaryCalls += 1
      if (fail) return new Error("model down")
      return JSON.stringify({ rows: mockRecordSummaryRows(prompt) })
    }
  }
  const releaseWith = async (c: Mode1Api, body: Record<string, unknown>) => c.post("/release", { base_version: await c.spineVersion(), ...body })
  const cleanXml = async (projectId: string): Promise<string> => {
    const v10 = (await DocVersion.findOne({ projectId, version: "1.0" }).lean())!
    return documentXml(await docFileStore().load(v10.clean_file_ref!))
  }

  it("gói duyệt báo credit ước tính; không bật ô chọn ⇒ không gọi AI, bảng dùng câu dựng sẵn", async () => {
    const { c, projectId } = await projectWithRevision()
    answerSummary()
    const pkg = await c.get("/review-package")
    expect(pkg.body.data.concise_record_credits).toBe(1)
    expect((await releaseWith(c, {})).status).toBe(201)
    expect(summaryCalls).toBe(0)
    const xml = await cleanXml(projectId)
    expect(xml).toContain("CR-001:")
    expect(xml).not.toContain("[MOCK AI]")
  })

  it("concise_record: true ⇒ dòng CR dùng mô tả viết gọn, lưu vào CR", async () => {
    const { c, projectId } = await projectWithRevision()
    answerSummary()
    expect((await releaseWith(c, { concise_record: true })).status).toBe(201)
    expect(await cleanXml(projectId)).toContain("[MOCK AI]")
    const cr = await ChangeRequest.findOne({ projectId, cr_id: "CR-001" }).lean()
    expect(cr?.record_summaries?.length).toBeGreaterThan(0)
  })

  it("AI lỗi lúc viết gọn ⇒ vẫn phát hành, dòng CR giữ câu dựng sẵn", async () => {
    const { c, projectId } = await projectWithRevision()
    answerSummary(true)
    expect((await releaseWith(c, { concise_record: true })).status).toBe(201)
    const xml = await cleanXml(projectId)
    expect(xml).toContain("CR-001:")
    expect(xml).not.toContain("[MOCK AI]")
  })
})
