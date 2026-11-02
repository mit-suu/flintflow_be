/**
 * Helper test P4 mode 1 — phần import (FLF-172): dựng import tới từng trạng thái bằng cách gọi service trực tiếp
 * (không qua HTTP) để test I-4 / finalize / check / gap report / re-upload ở tầng service.
 * Provider AI giả: file test tự `vi.mock` `llm.router` bằng `mock-llm.ts` và đặt `mockOverrides.next`.
 */
import { expect } from "vitest"
import { seedFixture } from "../setup.js"
import { createMode1Project } from "./mode1.js"
import { makeSrsDocx, type SrsFixtureOptions } from "../../src/modules/import/testing/srs-fixture.js"
import { acceptLatest, uploadImport } from "../../src/modules/import/import.service.js"
import { runExtraction } from "../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../src/modules/import/finalize.service.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"

export const fileOf = (buffer: Buffer, originalname = "SRS_Lumen.docx") => ({ buffer, originalname, size: buffer.length })

export interface Mode1Ctx {
  projectId: string
  userId: string
  importId: string
}

/** Project mode import + upload SRS mẫu (FLF-343: tách file ngay ⇒ `extracting` chưa chạy) + xác nhận bản mới nhất. */
export const importAtExtracting = async (opts: { balance?: number; srs?: SrsFixtureOptions; buffer?: Buffer } = {}): Promise<Mode1Ctx> => {
  const seeded = await seedFixture("minimal", { balance: opts.balance ?? 1000 })
  const projectId = await createMode1Project(seeded)
  const doc = await uploadImport(projectId, seeded.userId, fileOf(opts.buffer ?? (await makeSrsDocx(opts.srs))))
  expect(doc.status).toBe("extracting")
  expect(doc.confirmed_latest_at).toBeNull()
  await acceptLatest(doc, true)
  return { projectId, userId: seeded.userId, importId: String(doc._id) }
}

/** Chạy I-4 ⇒ `baselining` (FLF-343: không còn dừng ở `fields_review`). */
export const importAtBaselining = async (opts: { balance?: number; srs?: SrsFixtureOptions } = {}): Promise<Mode1Ctx> => {
  const ctx = await importAtExtracting(opts)
  const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
  expect(run.doc.status).toBe("baselining")
  return ctx
}

/** Chạy tới hết finalize + check (thường là `gap_review`). */
export const importFinalized = async (opts: { balance?: number; srs?: SrsFixtureOptions } = {}) => {
  const ctx = await importAtBaselining(opts)
  const before = (await spineRepository.get(ctx.projectId))!
  const result = await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: before.spine_version })
  return { ...ctx, result, baseVersionBefore: before.spine_version }
}
