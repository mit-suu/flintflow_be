/**
 * FLF-375 — "Hai người sửa cùng lúc" (business-flow §3.2): không khoá chỗ đang sửa; đề xuất chưa xác nhận treo ở người
 * yêu cầu và **không có giá trị kiểm tra**. Lúc xác nhận (C-6) Code kiểm lại từng chỗ trên nội dung **hiện tại**:
 *
 * | Trong lúc chờ, người khác đã…            | Kết quả                                                              |
 * | Sửa đúng như đề xuất                     | `same` — báo "đã được <người> sửa giống đề xuất của bạn", không ghi   |
 * | Sửa đúng chữ mà đề xuất định đổi         | `conflict` — không ghi, màn so sánh 3 cột                             |
 * | Sửa phần khác trong cùng chỗ             | `rebased` — ghép phần người khác sửa + phần đề xuất đổi, rồi ghi      |
 * | Sửa chỗ khác làm đề xuất sai nghĩa       | chạy khô khi ghi (bất biến / tham chiếu) ⇒ cờ đỏ trước khi ghi         |
 *
 * Không có đường "ghi đè": ghi đè sẽ xoá phần người khác vừa sửa mà họ không biết.
 */

import { isDeepStrictEqual } from "node:util"
import mongoose from "mongoose"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation, LocationProposal } from "./change-location.model.js"
import { ChangeLocation } from "./change-location.model.js"
import { ChangeRequest } from "./change-request.model.js"
import type { CrStatus } from "./change-request.state.js"
import { elementValue, isArrayPath, sha256, unchangedSince, valueText } from "./spine-location.js"

type Row = Record<string, unknown>
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v)

const parse = (text: string | null | undefined): unknown => {
  if (text === null || text === undefined || text === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const opsOf = (p: Pick<LocationProposal, "spine_ops">): Row[] => (p.spine_ops ?? []).filter(isRow)

/** Op chỉ chạm chính phần tử của vị trí (không lan sang phần tử khác). */
const onlyTouches = (path: string, ops: Row[]): boolean =>
  ops.every((o) => typeof o.path === "string" && (o.path === path || o.path.startsWith(`${path}.`)))

export type ConfirmOutcome =
  | { kind: "unchanged" }
  | { kind: "same" }
  | { kind: "rebased"; proposal: LocationProposal }
  | { kind: "conflict" }

/**
 * Phân loại một chỗ `edit` lúc xác nhận — hàm thuần. `proposal.old_text` = giá trị lúc AI soạn, `new_text` = giá trị
 * đề xuất (chạy khô), Spine `current` = nội dung hiện tại.
 */
export const classifyAtConfirm = (current: Spine, path: string, proposal: LocationProposal): ConfirmOutcome => {
  if (unchangedSince(current, path, proposal)) return { kind: "unchanged" }
  const ops = opsOf(proposal)

  if (isArrayPath(path)) {
    // Vị trí "thêm mới": người khác thêm / sửa phần tử khác của mảng không đụng phần tử mình thêm
    const array = elementValue(current, path)
    const existing = Array.isArray(array) ? array.filter(isRow) : []
    const adds = ops.filter((o) => o.op === "add" && isRow(o.value))
    if (!adds.length || adds.length !== ops.length) return { kind: "conflict" }
    const found = adds.map((o) => existing.find((e) => typeof e.id === "string" && e.id === (o.value as Row).id))
    if (found.every((f, i) => f !== undefined && isDeepStrictEqual(f, adds[i].value))) return { kind: "same" }
    if (found.some((f) => f !== undefined)) return { kind: "conflict" }
    return { kind: "rebased", proposal: { ...proposal, base_hash: sha256(valueText(array)) } }
  }

  const before = parse(proposal.old_text)
  const now = elementValue(current, path)
  const removes = ops.some((o) => o.op === "remove" && o.path === path)
  if (removes) return now === undefined ? { kind: "same" } : { kind: "conflict" }
  const wanted = parse(proposal.new_text)
  if (now === undefined || wanted === undefined) return { kind: "conflict" }
  if (isDeepStrictEqual(now, wanted)) return { kind: "same" }
  if (!isRow(before) || !isRow(now) || !isRow(wanted) || !onlyTouches(path, ops)) return { kind: "conflict" }

  const keys = new Set([...Object.keys(before), ...Object.keys(now), ...Object.keys(wanted)])
  const mine = [...keys].filter((k) => !isDeepStrictEqual(before[k], wanted[k]))
  const theirs = [...keys].filter((k) => !isDeepStrictEqual(before[k], now[k]))
  if (mine.some((k) => theirs.includes(k))) return { kind: "conflict" }

  const merged: Row = { ...now }
  for (const k of mine) {
    if (wanted[k] === undefined) delete merged[k]
    else merged[k] = wanted[k]
  }
  const reason = ops.find((o) => typeof o.reason === "string")?.reason
  return {
    kind: "rebased",
    proposal: {
      ...proposal,
      old_text: valueText(now),
      new_text: valueText(merged),
      spine_ops: [{ op: "set", path, value: merged, ...(reason ? { reason } : {}) }]
    }
  }
}

// ─── ai đã sửa ───────────────────────────────────────────────────

const userName = async (id: string): Promise<string | null> => {
  if (!mongoose.isValidObjectId(id)) return null
  const user = (await mongoose.connection.db?.collection("users").findOne({ _id: new mongoose.Types.ObjectId(id) }, { projection: { name: 1, email: 1 } })) as
    | { name?: string; email?: string }
    | null
    | undefined
  return user?.name || user?.email || null
}

/** Tên người cho một `by` của change: mã CR ⇒ "CR-003 (người yêu cầu)"; id người dùng ⇒ tên; khác ⇒ nguyên văn. */
export const actorName = async (projectId: mongoose.Types.ObjectId | string, by: string): Promise<string> => {
  if (/^CR-\d+$/.test(by)) {
    const cr = await ChangeRequest.findOne({ projectId, cr_id: by }).select("requester created_by").lean()
    const who = cr?.requester || (cr?.created_by ? await userName(String(cr.created_by)) : null)
    return who ? `${who} (${by})` : by
  }
  return (await userName(by)) ?? by
}

/** Lần sửa gần nhất chạm phần tử `path` (chính nó, field con, hoặc phần tử trong mảng `arr[]`). */
export const lastEditOf = async (projectId: mongoose.Types.ObjectId | string, path: string): Promise<{ by: string; at: Date } | null> => {
  const escaped = (isArrayPath(path) ? path.slice(0, -2) : path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = isArrayPath(path) ? `^${escaped}(\\[|$)` : `^${escaped}(\\.|\\[|$)`
  const row = (await mongoose.connection.db
    ?.collection("changes")
    .find({ projectId: new mongoose.Types.ObjectId(String(projectId)), path: { $regex: pattern } }, { projection: { by: 1, at: 1 } })
    .sort({ seq: -1 })
    .limit(1)
    .next()) as { by?: string; at?: Date } | null | undefined
  return row?.by ? { by: row.by, at: row.at ?? new Date(0) } : null
}

// ─── C-6: kiểm lại trước khi ghi ─────────────────────────────────

export interface ConfirmCheck {
  /** Chỗ người khác đã sửa giống đề xuất (đã đổi thành "không ghi"). */
  same: number
  /** Chỗ đụng phần người khác vừa sửa ⇒ CR không ghi, chờ người dùng quyết. */
  conflicts: number
}

/**
 * Kiểm lại mọi chỗ `edit` của CR trên Spine hiện tại; ghi kết quả vào vị trí (proposal đã ghép / conclusion / conflict).
 * Bên gọi: `conflicts > 0` ⇒ không ghi, CR về "Cần bạn quyết"; ngược lại ghi như thường.
 */
export const checkBeforeWrite = async (cr: { projectId: mongoose.Types.ObjectId; cr_id: string }, locations: IChangeLocation[], current: Spine): Promise<ConfirmCheck> => {
  let same = 0
  let conflicts = 0
  for (const loc of locations) {
    if (loc.conclusion !== "edit" || !loc.proposal) continue
    const outcome = classifyAtConfirm(current, loc.path, loc.proposal)
    if (outcome.kind === "unchanged") continue
    const edit = await lastEditOf(cr.projectId, loc.path)
    const who = edit ? await actorName(cr.projectId, edit.by) : "người khác"
    if (outcome.kind === "same") {
      same++
      loc.conclusion = "not_related"
      loc.reason = `Đã được ${who} sửa giống đề xuất của bạn — không ghi lại`
      loc.conflict = null
    } else if (outcome.kind === "rebased") {
      loc.proposal = outcome.proposal
      loc.conflict = null
    } else {
      conflicts++
      loc.conflict = {
        at_proposal_text: loc.proposal.old_text,
        current_text: valueText(elementValue(current, loc.path)),
        proposal_text: loc.proposal.new_text,
        changed_by: who,
        changed_at: edit?.at ?? null
      }
    }
    loc.markModified("proposal")
    await loc.save()
  }
  return { same, conflicts }
}

// ─── người khác có bản sửa chưa xác nhận ở cùng chỗ ───────────────

const OPEN_STATUSES: CrStatus[] = ["draft", "clarifying", "awaiting_answers", "impact_review", "proposing", "verifying", "manual_fix", "ready_to_submit"]

/** path ⇒ các CR **khác** chưa đóng đang có đề xuất ở đúng phần tử đó (mã CR + người yêu cầu). */
export const othersPending = async (projectId: mongoose.Types.ObjectId, crId: string, paths: string[]): Promise<Map<string, { cr_id: string; requester: string }[]>> => {
  const out = new Map<string, { cr_id: string; requester: string }[]>()
  if (!paths.length) return out
  const rows = await ChangeLocation.find({ projectId, cr_id: { $ne: crId }, path: { $in: paths }, conclusion: { $in: ["edit", "comment"] } })
    .select("cr_id path")
    .lean()
  if (!rows.length) return out
  const crs = await ChangeRequest.find({ projectId, cr_id: { $in: [...new Set(rows.map((r) => r.cr_id))] }, status: { $in: OPEN_STATUSES } })
    .select("cr_id requester")
    .lean()
  const open = new Map(crs.map((c) => [c.cr_id, c.requester ?? ""]))
  for (const r of rows) {
    if (!open.has(r.cr_id)) continue
    const list = out.get(r.path) ?? []
    list.push({ cr_id: r.cr_id, requester: open.get(r.cr_id)! })
    out.set(r.path, list)
  }
  return out
}
