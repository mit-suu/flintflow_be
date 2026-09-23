/**
 * C-5 kiểm đề xuất (nút 3.7–3.9, UC-82). FLF-171, plan §6 2E; mode 1 v2 (FLF-186) theo phần tử Spine.
 * - Code (chặn): phần tử vẫn do CR giữ khoá; giá trị tại path **chưa đổi** kể từ lúc đề xuất (lệch ⇒
 *   `409 CR_VALUE_CHANGED`); `edit` có op và đổi thật; op chỉ chạm phần tử CR đang khoá (thêm phần tử mới thì được);
 *   `comment` có nội dung; toàn bộ op của CR qua `planTransaction` chạy khô + bất biến; Spine giả lập không thêm cờ đỏ
 *   (hồ sơ luật mode 1).
 * - AI `CR_CONSISTENCY` (không chặn): nhận xét vàng trên phạm vi thay đổi (phần tử cùng section), gắn theo `section_id`.
 * Trượt ⇒ AI làm lại vị trí đó (`redo_count` ≤ 2) ⇒ vẫn trượt / vị trí sửa tay trượt ⇒ `manual_fix` (3.9).
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { FindingsOutput } from "../../shared/ai/response-parser.js"
import { stripRecord } from "../import/check.service.js"
import { titleOfSection } from "../import/gap-report.service.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import { flagKey, runDeterministicCheck } from "../spine/deterministic-check.js"
import { TransactionRejectedError, planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { MAX_REDO_PER_LOCATION } from "./change-request.state.js"
import { ChangeLocation, type IChangeLocation, type VerifyViolation } from "./change-location.model.js"
import { crHeader, glossaryText, truncate } from "./cr-context.js"
import { locksOf } from "./lock.service.js"
import { elementValue, isArrayPath, listElements, opElement, sectionOfElement, valueText } from "./spine-location.js"

export const valueChanged = (loc: Pick<IChangeLocation, "location_id" | "path">): Mode1Error =>
  new Mode1Error("CR_VALUE_CHANGED", `${loc.path} đã bị sửa ở chỗ khác kể từ lúc đề xuất`, { location_id: loc.location_id, path: loc.path })

type CheckLocation = Pick<IChangeLocation, "location_id" | "path" | "conclusion" | "proposal">

const opPath = (raw: unknown): string => {
  const path = (raw as { path?: unknown } | null)?.path
  return typeof path === "string" ? path : ""
}

/** Phần tử mà các op của vị trí chạm tới (bỏ op thêm phần tử mới `arr[]`). */
export const opElements = (loc: Pick<IChangeLocation, "proposal">): string[] =>
  (loc.proposal?.spine_ops ?? []).map((o) => opElement(opPath(o))).filter((p): p is string => !!p)

/** Kiểm tất định từng vị trí (không gồm chạy khô op — xem `checkSpineOps`). `locks`: path ⇒ CR giữ khoá. */
export const checkLocation = (cr: Pick<IChangeRequest, "cr_id">, loc: CheckLocation, spine: Spine, locks: ReadonlyMap<string, string>): VerifyViolation[] => {
  if (!loc.conclusion) return [{ rule: "unconcluded", message: "Vị trí chưa có kết luận" }]
  if (loc.conclusion === "not_related") return []
  const current = elementValue(spine, loc.path)
  if (current === undefined) return [{ rule: "element_missing", message: `${loc.path} không còn trong Spine`, path: loc.path }]
  const out: VerifyViolation[] = []
  if (locks.get(loc.path) !== cr.cr_id) out.push({ rule: "path_not_locked", message: `${loc.path} không do ${cr.cr_id} giữ khoá`, path: loc.path })
  const p = loc.proposal
  if (!p) return [...out, { rule: "no_proposal", message: "Thiếu đề xuất" }]
  if (valueText(current) !== p.old_text) throw valueChanged(loc)
  if (loc.conclusion === "edit") {
    if (!p.spine_ops.length) out.push({ rule: "edit_without_ops", message: "Kết luận edit nhưng không có op Spine" })
    else if (p.new_text !== null && p.new_text === p.old_text) out.push({ rule: "edit_no_change", message: "Op không đổi gì ở phần tử này" })
    for (const el of opElements(loc)) {
      if (el !== loc.path && locks.get(el) !== cr.cr_id) out.push({ rule: "op_path_not_locked", message: `Op sửa ${el} — phần tử này không thuộc vị trí CR đang khoá`, path: el })
    }
    // Vị trí "mục trống" (`arr[]`): chỉ được thêm phần tử vào đúng mảng đó, không lấn sang mảng khác
    if (isArrayPath(loc.path)) {
      const array = loc.path.slice(0, -2)
      for (const raw of p.spine_ops) {
        const path = opPath(raw)
        if (!path.startsWith(array)) out.push({ rule: "op_outside_section", message: `Op chạm ${path} — vị trí này chỉ được thêm mới vào ${loc.path}`, path })
      }
    }
  }
  if (loc.conclusion === "comment" && !p.comment_text?.trim()) out.push({ rule: "comment_empty", message: "Kết luận comment nhưng không có nội dung" })
  return out
}

/** Chạy khô toàn bộ op Spine của CR; vi phạm gắn về vị trí sinh ra op. */
export const checkSpineOps = (spine: Spine, cr: Pick<IChangeRequest, "cr_id">, locations: CheckLocation[]): Map<string, VerifyViolation[]> => {
  const out = new Map<string, VerifyViolation[]>()
  const push = (locId: string, v: VerifyViolation) => out.set(locId, [...(out.get(locId) ?? []), v])
  const ops: Op[] = []
  const owner: string[] = []
  for (const l of locations) {
    if (l.conclusion !== "edit") continue
    for (const raw of l.proposal?.spine_ops ?? []) {
      const parsed = userOpSchema.safeParse(raw)
      if (!parsed.success) {
        push(l.location_id, { rule: "op_invalid", message: "Op Spine sai định dạng" })
        continue
      }
      ops.push(parsed.data)
      owner.push(l.location_id)
    }
  }
  if (!ops.length) return out
  try {
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: cr.cr_id }, { startSeq: 1 })
    const before = new Set(runDeterministicCheck(spine, [], { ruleProfile: MODE1_RULE_PROFILE }).filter((c) => c.level === "red").map(flagKey))
    const newRed = runDeterministicCheck(plan.spine, [], { ruleProfile: MODE1_RULE_PROFILE }).filter((c) => c.level === "red" && !before.has(flagKey(c)))
    for (const c of newRed) for (const locId of new Set(owner)) push(locId, { rule: "new_red_flag", message: `Op làm mở cờ đỏ ${c.rule_id}: ${c.message}` })
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) throw err
    for (const v of err.violations) {
      const locId = v.op_index !== undefined ? owner[v.op_index] : undefined
      for (const id of locId ? [locId] : [...new Set(owner)]) push(id, { rule: v.rule, message: v.message, ...(v.path ? { path: v.path } : {}) })
    }
  }
  return out
}

/** Phạm vi đưa AI xem: phần tử khác cùng section với vị trí sửa (tối đa `limit` phần tử). */
const scopeText = (spine: Spine, changed: IChangeLocation[], limit = 20): string => {
  const sections = new Set(changed.map((l) => l.section_id))
  const edited = new Set(changed.map((l) => l.path))
  const neighbours = listElements(spine)
    .filter((e) => !edited.has(e.path) && sections.has(sectionOfElement(spine, e.path)))
    .slice(0, limit)
  return neighbours.map((e) => `[${e.path}] (${sectionOfElement(spine, e.path)}) ${truncate(valueText(e.value), 600)}`).join("\n") || "(none)"
}

export const runVerify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["proposing", "manual_fix", "ready_to_submit", "verifying"], "verifying")
  await transitionCr(cr, "verifying")
  cr.paused = null
  await cr.save()
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new Error("Không tìm thấy Spine của project")
  const spine = stripRecord(record)
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })
  const locks = await locksOf(cr.projectId, [...locations.map((l) => l.path), ...locations.flatMap(opElements)])

  const violations = new Map(locations.map((l) => [l.location_id, checkLocation(cr, l, spine, locks)]))
  for (const [locId, vs] of checkSpineOps(spine, cr, locations)) violations.set(locId, [...(violations.get(locId) ?? []), ...vs])

  // AI consistency trên các vị trí có thay đổi và đã qua kiểm code
  const changed = locations.filter((l) => (l.conclusion === "edit" || l.conclusion === "comment") && !violations.get(l.location_id)?.length)
  const aiFlags = new Map<string, { rule: string; message: string }[]>()
  if (changed.length) {
    const result = await withMeteredAi<FindingsOutput>({ projectId: String(cr.projectId), userId, stepId: `C-5:${cr.cr_id}` }, ActionType.CR_CONSISTENCY, {
      ...crHeader(cr),
      edits: truncate(
        changed
          .map((l) =>
            l.conclusion === "edit"
              ? `[${l.location_id}][${l.path}] (${l.section_id === "misc" ? "-" : `${l.section_id} ${titleOfSection(spine, l.section_id)}`})\n  before: ${truncate(l.proposal?.old_text ?? "", 1500)}\n  after: ${truncate(l.proposal?.new_text ?? "", 1500)}`
              : `[${l.location_id}][${l.path}] (comment) ${l.proposal?.comment_text}`
          )
          .join("\n")
      ),
      scope: truncate(scopeText(spine, changed)),
      glossary: glossaryText(spine)
    })
    if (!result.ok) {
      cr.paused = { reason: result.reason, at: new Date() }
      await cr.save()
      return
    }
    for (const f of result.data.findings) {
      // Nhận xét gắn vào vị trí sửa cùng section; không khớp section nào thì vị trí sửa đầu tiên (người duyệt vẫn thấy)
      const hit = changed.filter((c) => c.section_id === f.section_id)
      for (const l of hit.length ? hit : changed.slice(0, 1)) {
        aiFlags.set(l.location_id, [...(aiFlags.get(l.location_id) ?? []), { rule: f.rule, message: f.message }])
      }
    }
  }

  const at = new Date()
  const failing: IChangeLocation[] = []
  for (const l of locations) {
    const vs = violations.get(l.location_id) ?? []
    l.verify = { code_ok: vs.length === 0, violations: vs, ai_flags: aiFlags.get(l.location_id) ?? [], at }
    if (vs.length) failing.push(l)
  }
  let next: "ready_to_submit" | "proposing" | "manual_fix" = "ready_to_submit"
  if (failing.length) {
    next = failing.some((l) => l.manual || l.redo_count >= MAX_REDO_PER_LOCATION) ? "manual_fix" : "proposing"
    if (next === "proposing") for (const l of failing) l.redo_count += 1
  }
  await Promise.all(locations.map((l) => l.save()))
  await transitionCr(cr, next)
}
