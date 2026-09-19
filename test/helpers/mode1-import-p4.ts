/**
 * Helper test P4 mode 1 — phần import (FLF-172): dựng import tới từng trạng thái bằng cách gọi service trực tiếp
 * (không qua HTTP) để test I-4 / finalize / check / gap report / re-upload ở tầng service.
 * Provider AI giả: file test tự `vi.mock` `llm.router` bằng `mock-llm.ts` và đặt `mockOverrides.next`.
 */
import { expect } from "vitest"
import { seedFixture } from "../setup.js"
import { createMode1Project } from "./mode1.js"
import { makeSrsDocx, type SrsFixtureOptions } from "../../src/modules/import/testing/srs-fixture.js"
import { confirmLatest, uploadImport } from "../../src/modules/import/import.service.js"
import { patchFields, runExtraction } from "../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../src/modules/import/finalize.service.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"

export const fileOf = (buffer: Buffer, originalname = "SRS_Lumen.docx") => ({ buffer, originalname, size: buffer.length })

export interface Mode1Ctx {
  projectId: string
  userId: string
  importId: string
}

/** Project mode import + upload SRS mẫu + xác nhận bản mới nhất ⇒ import ở `extracting`. */
export const importAtExtracting = async (opts: { balance?: number; srs?: SrsFixtureOptions; buffer?: Buffer } = {}): Promise<Mode1Ctx> => {
  const seeded = await seedFixture("minimal", { balance: opts.balance ?? 1000 })
  const projectId = await createMode1Project(seeded)
  const doc = await uploadImport(projectId, seeded.userId, fileOf(opts.buffer ?? (await makeSrsDocx(opts.srs))))
  expect(doc.status).toBe("awaiting_latest_confirm")
  const confirmed = await confirmLatest(projectId, String(doc._id))
  expect(confirmed.status).toBe("extracting")
  return { projectId, userId: seeded.userId, importId: String(doc._id) }
}

/** Chạy I-4 + xác nhận mọi field ⇒ `baselining`. */
export const importAtBaselining = async (opts: { balance?: number } = {}): Promise<Mode1Ctx> => {
  const ctx = await importAtExtracting(opts)
  const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
  if (run.doc.status === "fields_review") await patchFields(ctx.projectId, { import_id: ctx.importId, fields: [], confirm_all: true })
  return ctx
}

/** Chạy tới hết finalize + check (thường là `gap_review`). */
export const importFinalized = async (opts: { balance?: number } = {}) => {
  const ctx = await importAtBaselining(opts)
  const before = (await spineRepository.get(ctx.projectId))!
  const result = await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: before.spine_version })
  return { ...ctx, result, baseVersionBefore: before.spine_version }
}
