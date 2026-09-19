/**
 * spine.repository.ts
 * ─────────────────────────────────────────────────────────────────
 * Cửa ghi/đọc duy nhất vào collection `spines` và `changes`.
 *
 * Khoá lạc quan: `saveWithVersion` chỉ ghi khi `spine_version` trong DB còn
 * bằng `baseVersion` mà caller đã đọc. Lệch ⇒ 409 SPINE_VERSION_CONFLICT
 * (Phases §4.1 "Hai tab cùng ghi"). Điều kiện nằm trong chính filter của
 * `findOneAndUpdate` nên Mongo đảm bảo nguyên tử, không cần transaction.
 *
 * Mọi dữ liệu đọc ra đi qua zod: DB lưu Date/ObjectId, repository trả dạng
 * JSON (chuỗi ISO, id chuỗi) đúng `SpineRecord`.
 */

import { z } from "zod"
import type { ClientSession } from "mongoose"
import { Spine as SpineModel } from "./spine.model.js"
import { Change as ChangeModel } from "./change.model.js"
import { changeSchema, spineRecordSchema } from "./spine.schema.js"
import type { Change, Spine, SpineProject, SpineRecord } from "./spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { TRANSACTION_UNAVAILABLE, runInTransaction, sessionOptions } from "../../shared/db/transaction.js"

export const SPINE_VERSION_CONFLICT = "SPINE_VERSION_CONFLICT"
export const SPINE_NOT_FOUND = "SPINE_NOT_FOUND"
export const SPINE_SCHEMA_INVALID = "SPINE_SCHEMA_INVALID"
export const CHANGE_SEQ_CONFLICT = "CHANGE_SEQ_CONFLICT"
export const CHANGE_INVALID = "CHANGE_INVALID"

/** Phase/step khởi đầu của project mới (srs-spine.md §2.2: progress reset về B-0). */
export const INITIAL_PHASE = "B-0"
export const INITIAL_STEP = "B-0.1"

export type SpineInit = Partial<Pick<SpineProject, "name" | "domain">>

export const createEmptySpine = (init: SpineInit = {}): Spine => ({
  project: {
    name: init.name ?? "",
    vision: null,
    goals: [],
    type: null,
    domain: init.domain ?? null,
    complexity: null,
    form_factor: null,
    stakes: null,
    working_mode: null,
    release_scope: { in: [], out: [] }
  },
  progress: {
    current_phase: INITIAL_PHASE,
    current_step: INITIAL_STEP,
    screen_cursor: null,
    screen_queue: [],
    elicit_turns_this_phase: 0
  },
  steps: [],
  features: [],
  actors: [],
  roles: [],
  use_cases: [],
  screens: [],
  permissions: [],
  entities: [],
  functions: [],
  nfrs: [],
  business_rules: [],
  common_requirements: [],
  messages: [],
  other_requirements: [],
  glossary: [],
  addendum: [],
  custom_sections: [],
  diagrams: [],
  assumptions: [],
  flags: [],
  sections: [],
  baselines: [],
  spine_version: 1
})

// ─── helpers ─────────────────────────────────────────────────────

const DB_ONLY_KEYS = new Set(["_id", "__v", "createdAt", "updatedAt"])

/** Date → ISO, ObjectId → hex, bỏ undefined và key chỉ DB có (schema là strict). */
const toJson = (doc: unknown): unknown => {
  const json: unknown = JSON.parse(JSON.stringify(doc))
  if (typeof json !== "object" || json === null) return json
  return Object.fromEntries(Object.entries(json).filter(([key]) => !DB_ONLY_KEYS.has(key)))
}

const parseRecord = (doc: unknown): SpineRecord => spineRecordSchema.parse(toJson(doc))

const parseChange = (doc: unknown): Change => changeSchema.parse(toJson(doc))

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "code" in err && err.code === 11000

const seqOnlySchema = z.object({ seq: z.number().int() })

// ─── Spine ───────────────────────────────────────────────────────

export const get = async (projectId: string): Promise<SpineRecord | null> => {
  const doc = await SpineModel.findOne({ projectId }, null, { lean: true })
  return doc ? parseRecord(doc) : null
}

const baselineRefsSchema = z.array(z.object({ id: z.string().min(1), snapshot_ref: z.string().min(1) }))

export type BaselineRef = z.infer<typeof baselineRefsSchema>[number]

/**
 * Chỉ `baselines[].{id, snapshot_ref}` — đủ để đổi mã `BLnnn` sang `Baseline._id` (render) mà không nạp
 * và validate cả Spine cho một lượt đọc baseline. Chưa có Spine, hoặc phần này sai schema ⇒ `[]`
 * (người gọi trả 404), không để ZodError lọt ra HTTP.
 */
export const listBaselineRefs = async (projectId: string): Promise<BaselineRef[]> => {
  const doc = await SpineModel.findOne({ projectId }, { "baselines.id": 1, "baselines.snapshot_ref": 1 }, { lean: true })
  const parsed = baselineRefsSchema.safeParse(doc?.baselines ?? [])
  return parsed.success ? parsed.data : []
}

/**
 * Trả Spine của project, tạo Spine rỗng nếu chưa có. Idempotent:
 * upsert với `$setOnInsert` nên gọi lại không ghi đè dữ liệu đã có.
 */
export const getOrCreate = async (projectId: string, init: SpineInit = {}): Promise<SpineRecord> => {
  try {
    const doc = await SpineModel.findOneAndUpdate(
      { projectId },
      { $setOnInsert: createEmptySpine(init) },
      { upsert: true, returnDocument: "after", lean: true }
    )
    return parseRecord(doc)
  } catch (err) {
    // Hai request cùng upsert lần đầu: một bên dính unique index — đọc lại bản đã tạo
    if (!isDuplicateKeyError(err)) throw err
    const existing = await get(projectId)
    if (!existing) throw err
    return existing
  }
}

/**
 * Ghi toàn bộ nội dung Spine nếu DB còn ở `baseVersion`; `spine_version` thành
 * `baseVersion + 1`. Nội dung được validate bằng `spineSchema` trước khi ghi.
 */
export const saveWithVersion = async (
  spine: SpineRecord,
  baseVersion: number,
  session?: ClientSession
): Promise<SpineRecord> => {
  const parsed = spineRecordSchema.safeParse({ ...spine, spine_version: baseVersion + 1 })
  if (!parsed.success) {
    throw new ApiError(422, `Spine không hợp lệ: ${z.prettifyError(parsed.error)}`, SPINE_SCHEMA_INVALID)
  }

  const { projectId, ...content } = parsed.data
  const updated = await SpineModel.findOneAndUpdate(
    { projectId, spine_version: baseVersion },
    { $set: content },
    { returnDocument: "after", runValidators: true, lean: true, ...sessionOptions(session) }
  )

  if (!updated) {
    const exists = await SpineModel.findOne({ projectId }, { _id: 1 }, { lean: true, ...sessionOptions(session) })
    if (!exists) {
      throw new ApiError(404, "Không tìm thấy Spine của dự án", SPINE_NOT_FOUND)
    }
    throw new ApiError(
      409,
      "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.",
      SPINE_VERSION_CONFLICT
    )
  }

  return parseRecord(updated)
}

// ─── changes ─────────────────────────────────────────────────────

/** `seq` kế tiếp cho project, bắt đầu từ 1. */
export const nextSeq = async (projectId: string): Promise<number> => {
  const last = await ChangeModel.findOne({ projectId }, { seq: 1 }, { sort: { seq: -1 }, lean: true })
  return last ? seqOnlySchema.parse(last).seq + 1 : 1
}

export type NewChange = Omit<Change, "projectId">

/**
 * Ghi một lô change. `seq` trong lô phải liên tục tăng dần; trùng `seq` với
 * bản đã có (hai writer cùng lúc) ⇒ 409 CHANGE_SEQ_CONFLICT nhờ unique index.
 */
export const appendChanges = async (
  projectId: string,
  changes: NewChange[],
  session?: ClientSession
): Promise<Change[]> => {
  if (changes.length === 0) return []

  const docs: Change[] = []
  for (const [i, change] of changes.entries()) {
    const parsed = changeSchema.safeParse({ ...change, projectId })
    if (!parsed.success) {
      throw new ApiError(422, `Change #${i} không hợp lệ: ${z.prettifyError(parsed.error)}`, CHANGE_INVALID)
    }
    if (i > 0 && parsed.data.seq !== docs[i - 1].seq + 1) {
      throw new ApiError(422, `seq trong lô phải liên tục (vị trí ${i})`, CHANGE_INVALID)
    }
    docs.push(parsed.data)
  }

  try {
    // Không dùng lean: cần Mongoose cast projectId → ObjectId, at → Date và validate
    const inserted = await ChangeModel.insertMany(docs, { ordered: true, ...sessionOptions(session) })
    return inserted.map(parseChange)
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err
    throw new ApiError(409, "seq của change đã tồn tại", CHANGE_SEQ_CONFLICT)
  }
}

export interface ApplyAndSaveInput {
  spine: SpineRecord
  baseVersion: number
  /** Change của MỘT txn, seq liên tục bắt đầu từ `nextSeq`. */
  changes: NewChange[]
}

/** Số lần cấp lại dải seq khi ghi change không có transaction. */
const MAX_SEQ_RETRIES = 5

const versionConflict = () =>
  new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", SPINE_VERSION_CONFLICT)

const isSeqConflict = (err: unknown): boolean => err instanceof ApiError && err.code === CHANGE_SEQ_CONFLICT

/**
 * Ghi kết quả một transaction của op engine (T08): Spine (khoá lạc quan) + `changes[]` của txn.
 *
 * - Có Mongo transaction (replica set): ghi change rồi Spine trong cùng transaction — lỗi ở đâu cũng
 *   không để lại gì. Trùng seq ⇒ writer khác vừa ghi ⇒ 409 SPINE_VERSION_CONFLICT.
 * - Không có (Mongo standalone): `saveWithVersion` TRƯỚC — khoá version quyết người thắng, nên chỉ
 *   writer đã thắng mới ghi change. Trùng seq (hai writer nối tiếp cùng đọc `nextSeq`) ⇒ cấp lại dải
 *   seq rồi thử lại. Không còn bù trừ xoá theo txn, nên không có lỗ seq và không xoá nhầm change của
 *   txn khác. Giới hạn: process chết giữa hai bước làm mất change của lô đã ghi (Spine vẫn đúng).
 */
export const applyAndSave = async (
  projectId: string,
  { spine, baseVersion, changes }: ApplyAndSaveInput
): Promise<{ spine: SpineRecord; changes: Change[] }> => {
  const transactional = await runInTransaction(async (session) => {
    try {
      const written = await appendChanges(projectId, changes, session)
      const saved = await saveWithVersion({ ...spine, projectId }, baseVersion, session)
      return { spine: saved, changes: written }
    } catch (err) {
      if (isSeqConflict(err)) throw versionConflict()
      throw err
    }
  })
  if (transactional !== TRANSACTION_UNAVAILABLE) return transactional

  const saved = await saveWithVersion({ ...spine, projectId }, baseVersion)
  let batch = changes
  for (let attempt = 1; ; attempt++) {
    try {
      return { spine: saved, changes: await appendChanges(projectId, batch) }
    } catch (err) {
      if (!isSeqConflict(err) || attempt >= MAX_SEQ_RETRIES) throw err
      const start = await nextSeq(projectId)
      batch = batch.map((change, i) => ({ ...change, seq: start + i }))
    }
  }
}

export interface ChangeRange {
  fromSeq?: number
  toSeq?: number
}

/** Change theo `seq` tăng dần; `fromSeq`/`toSeq` bao gồm hai đầu. */
export const listChanges = async (projectId: string, range: ChangeRange = {}): Promise<Change[]> => {
  const seq: { $gte?: number; $lte?: number } = {}
  if (range.fromSeq !== undefined) seq.$gte = range.fromSeq
  if (range.toSeq !== undefined) seq.$lte = range.toSeq

  const filter = Object.keys(seq).length > 0 ? { projectId, seq } : { projectId }
  const docs = await ChangeModel.find(filter, null, { sort: { seq: 1 }, lean: true })
  return docs.map(parseChange)
}
