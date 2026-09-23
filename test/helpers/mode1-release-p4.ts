/**
 * Helper test P4 (FLF-172) cho release / metered-ai / chat-guard mode 1. Chép cách dựng project đã import của
 * `mode1-change-request.int.test.ts#importedProject` (không sửa helper cũ).
 */
import request from "supertest"
import mongoose from "mongoose"
import { expect } from "vitest"
import JSZip from "jszip"
import { seedFixture } from "../setup.js"
import { mockOverrides } from "./mock-llm.js"
import { createMode1Project, fakeCrClarify, fakeMode1, mode1Api, promptLocations } from "./mode1.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { changeRequestDetailSchema } from "../../src/modules/change-request/change-request.dto.js"
import { fillCoreSections } from "./mode1-v2.js"
import { DOC_FILE_BUCKET } from "../../src/modules/doc-version/doc-file.store.js"

export type Mode1Api = ReturnType<typeof mode1Api>

/** Project mode 1 đã import xong (baseline v0 `0.0`). */
export const importedProject = async (name = "Lumen LMS") => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded, name)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
  await c.post("/import/confirm-latest", { import_id: id })
  await c.extractAndWait(id)
  await c.patch("/import/fields", { import_id: id, confirm_all: true })
  const fin = await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
  expect(fin.status, JSON.stringify(fin.body.error)).toBe(200)
  // D6 (FLF-183): điền các đầu mục FPT còn trống như đã chạy step (release cần hết cờ đỏ)
  await fillCoreSections(projectId)
  return { seeded, projectId, c }
}

/** Op `set` thay `from` bằng `to` ở mọi field chuỗi (cấp đầu) của phần tử — FLF-186: đề xuất là op Spine. */
const replaceOps = (path: string, text: string, from: string, to: string): { op: "set"; path: string; value: string }[] => {
  let value: Record<string, unknown> = {}
  try {
    value = JSON.parse(text.split("\nPrevious proposal failed checks")[0]) as Record<string, unknown>
  } catch {
    return []
  }
  return Object.entries(value)
    .filter(([k, v]) => k !== "id" && typeof v === "string" && v.includes(from))
    .map(([k, v]) => ({ op: "set", path: `${path}.${k}`, value: (v as string).split(from).join(to) }))
}

/**
 * Provider giả cho một CR "thay `from` bằng `to`": C-2 trả keyword `from` (+ keyword phụ), C-4 sửa mọi phần tử có `from`
 * (op set trên field chứa nó), phần tử có path khớp `commentOn` ⇒ comment, còn lại not_related.
 */
export const routeReplaceCr = (from: string, to: string, opts: { extraKeywords?: string[]; commentOn?: RegExp } = {}) => {
  mockOverrides.next = (p) =>
    fakeMode1(p) ??
    fakeCrClarify({ entity_paths: [], keywords: [from, ...(opts.extraKeywords ?? [])] })(p) ??
    (p.includes("# CR Propose")
      ? JSON.stringify({
          locations: promptLocations(p).map((l) => {
            const ops = replaceOps(l.path, l.text, from, to)
            if (ops.length) return { location_id: l.location_id, conclusion: "edit", reason: "CR", spine_ops: ops }
            if (opts.commentOn?.test(l.path)) return { location_id: l.location_id, conclusion: "comment", reason: "Xem lại", comment_text: `Xem lại ${l.path}`, spine_ops: [] }
            return { location_id: l.location_id, conclusion: "not_related", reason: "Khác nghĩa", spine_ops: [] }
          })
        })
      : undefined)
}

export const crDetail = (res: { status: number; body: { data: unknown; error: unknown } }) => {
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return changeRequestDetailSchema.parse(res.body.data)
}

export const createCr = async (c: Mode1Api, title: string, description: string): Promise<string> => {
  const res = await c.post("/change-requests", { title, description, source: { kind: "verbal" }, requester: "PM" })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return changeRequestDetailSchema.parse(res.body.data).change_request.cr_id
}

/** Chạy CR tới `written` (duyệt mọi group). Trả `cr_id` + version kết quả. */
export const writeCr = async (c: Mode1Api, title: string, description: string) => {
  const crId = await createCr(c, title, description)
  const cr = `/change-requests/${crId}`
  for (const step of ["clarify", "impact", "propose", "verify", "submit"]) crDetail(await c.post(`${cr}/${step}`))
  const { groups } = crDetail(await c.get(cr))
  let last: ReturnType<typeof crDetail> | null = null
  for (const g of groups) last = crDetail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", reason: "Đúng yêu cầu của khách", base_version: await c.spineVersion() }))
  expect(last?.change_request.status).toBe("written")
  return { crId, version: last!.change_request.result_doc_version as string }
}

export const releaseNow = async (c: Mode1Api) => c.post("/release", { base_version: await c.spineVersion() })

/** Nhận body nhị phân (tải .docx). */
export const binary = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = []
    res.on("data", (d: Buffer) => chunks.push(d))
    res.on("end", () => cb(null, Buffer.concat(chunks)))
  })

export const documentXml = async (buf: Buffer): Promise<string> => (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string")

/** Số file GridFS trong bucket tài liệu mode 1 (kiểm file mồ côi). */
export const gridFsFileCount = async (projectId?: string): Promise<number> =>
  mongoose.connection.db!.collection(`${DOC_FILE_BUCKET}.files`).countDocuments(projectId ? { "metadata.projectId": projectId } : {})
