/**
 * Helper test P4 cho change request mode 1 (FLF-172, plan §8.3): dựng project đã import xong (baseline 0.0),
 * tạo CR, chạy CR tới một trạng thái, bắt prompt gửi provider giả, đọc khoá / file GridFS.
 * File test phải tự `vi.mock` llm.router (hoist) như `mode1-change-request.int.test.ts`.
 */
import mongoose from "mongoose"
import { expect } from "vitest"
import { seedFixture, type SeededFixture } from "../setup.js"
import { mockOverrides, resetMockLlm } from "./mock-llm.js"
import { createMode1Project, fakeCrClarify, fakeCrPropose, fakeMode1, mode1Api } from "./mode1.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { changeRequestDetailSchema, type ChangeRequestDetail } from "../../src/modules/change-request/change-request.dto.js"
import { ChangeRequest, type IChangeRequest } from "../../src/modules/change-request/change-request.model.js"
import { DocBlock } from "../../src/modules/import/doc-block.model.js"
import { DOC_FILE_BUCKET } from "../../src/modules/doc-version/doc-file.store.js"

export type Mode1Client = ReturnType<typeof mode1Api>

/** Đích C-2 mặc định: NFR-01 + từ khoá chạm câu perf, heading 4.2.3 và 5.1. */
export const PERF_TARGETS = { entity_paths: ["nfrs[id=NFR-01]"], keywords: ["2 seconds", "Performance", "Business Rules"] }

/** Mọi prompt đi qua provider giả trong test hiện tại. */
export const prompts: string[] = []

/** Router CR của test hiện tại; đổi bằng `routeCr(...)`. */
let route: (prompt: string) => string | Error | undefined = () => undefined

/** Gọi trong `beforeEach`: xoá log mock, định tuyến import giả + CR theo `r` (mặc định clarify PERF + propose chuẩn). */
export const resetCrMock = (r?: (prompt: string) => string | Error | undefined): void => {
  resetMockLlm()
  prompts.length = 0
  route = r ?? ((p) => fakeCrClarify(PERF_TARGETS)(p) ?? fakeCrPropose(p))
  mockOverrides.next = (p) => {
    prompts.push(p)
    return fakeMode1(p) ?? route(p)
  }
}

export const routeCr = (r: (prompt: string) => string | Error | undefined): void => {
  route = r
}

export const promptsOf = (header: "# CR Clarify" | "# CR Propose" | "# CR Consistency"): string[] => prompts.filter((p) => p.includes(header))

/** Project mode 1 đã import xong: upload → xác nhận → I-4 → xác nhận field → finalize (baseline 0.0). */
export const importedProject = async (): Promise<{ seeded: SeededFixture; projectId: string; c: Mode1Client }> => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
  await c.post("/import/confirm-latest", { import_id: id })
  await c.extractAndWait(id)
  await c.patch("/import/fields", { import_id: id, confirm_all: true })
  const fin = await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
  expect(fin.status, JSON.stringify(fin.body.error)).toBe(200)
  return { seeded, projectId, c }
}

export const CR_BODY = { source: { kind: "stakeholder_email", ref: "Email PM 2026-09-17" }, requester: "PM Lan" } as const

export const newCr = async (c: Mode1Client, title = "Faster response time", description = "Response time must be 1 second instead of 2 seconds."): Promise<string> => {
  const res = await c.post("/change-requests", { title, description, ...CR_BODY })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return changeRequestDetailSchema.parse(res.body.data).change_request.cr_id
}

export const detail = (res: { status: number; body: { data: unknown; error: unknown } }): ChangeRequestDetail => {
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return changeRequestDetailSchema.parse(res.body.data)
}

/** Tạo CR rồi đi tới `impact_review` (đã khoá block). */
export const crToImpact = async (c: Mode1Client, title?: string, description?: string) => {
  const crId = await newCr(c, title, description)
  const cr = `/change-requests/${crId}`
  expect(detail(await c.post(`${cr}/clarify`)).change_request.status).toBe("impact_review")
  const impact = detail(await c.post(`${cr}/impact`))
  return { crId, cr, impact }
}

/** Tạo CR rồi đi tới `ready_to_submit`. */
export const crToReady = async (c: Mode1Client, title?: string, description?: string) => {
  const { crId, cr, impact } = await crToImpact(c, title, description)
  const proposed = detail(await c.post(`${cr}/propose`))
  const verified = detail(await c.post(`${cr}/verify`))
  expect(verified.change_request.status).toBe("ready_to_submit")
  return { crId, cr, impact, proposed, verified }
}

/** Tạo CR rồi nộp (`in_review`). */
export const crToReview = async (c: Mode1Client) => {
  const ready = await crToReady(c)
  const submitted = detail(await c.post(`${ready.cr}/submit`))
  expect(submitted.change_request.status).toBe("in_review")
  return { ...ready, submitted }
}

/** Document CR (gọi service trực tiếp). */
export const crDoc = async (projectId: string, crId: string): Promise<IChangeRequest> => {
  const cr = await ChangeRequest.findOne({ projectId, cr_id: crId })
  expect(cr, `${crId} không tồn tại`).not.toBeNull()
  return cr!
}

/** block_id đang do `crId` giữ khoá (mọi version). */
export const lockedBlocks = async (projectId: string, crId: string): Promise<string[]> =>
  ((await DocBlock.find({ projectId, locked_by_cr: crId }).distinct("block_id")) as string[]).sort()

/** Số file GridFS của project theo loại (`version`, `upload`…). */
export const gridFsFiles = async (projectId: string, kind?: string): Promise<number> =>
  mongoose.connection.db!.collection(`${DOC_FILE_BUCKET}.files`).countDocuments({ "metadata.projectId": projectId, ...(kind ? { "metadata.kind": kind } : {}) })
