/**
 * C-5 kiểm đề xuất (nút 3.7–3.9, UC-82). FLF-171, plan §6 2E; mode 1 v2 (FLF-186) theo phần tử Spine.
 * - Code (chặn): phần tử vẫn do CR giữ khoá; giá trị tại path **chưa đổi** kể từ lúc đề xuất (lệch ⇒
 *   `409 CR_VALUE_CHANGED`); `edit` có op và đổi thật; op chỉ chạm phần tử CR đang khoá (thêm phần tử mới thì được);
 *   `comment` có nội dung; toàn bộ op của CR qua `planTransaction` chạy khô + bất biến; Spine giả lập không thêm cờ đỏ
 *   (hồ sơ luật mode 1).
 * - AI `CR_CONSISTENCY`: nhận xét vàng trên phạm vi thay đổi (phần tử cùng section; FLF-367 thêm phần tử liên quan ở
 *   section khác + đoạn văn giữ nguyên), gắn theo `section_id`. FLF-367: `contradiction` chưa hỏi ⇒ quay lại hỏi người
 *   yêu cầu (`clarifying → awaiting_answers`), không đi tới `ready_to_submit`.
 *   FLF-307: chỉ chạy khi cả CR qua kiểm code và có vị trí đổi đề xuất từ lần trước; nhận xét cũ giữ lại và đưa AI xem
 *   để không nêu lại.
 * Trượt ⇒ AI làm lại vị trí đó (`redo_count` ≤ 2) ⇒ vẫn trượt / vị trí sửa tay trượt ⇒ `manual_fix` (3.9).
 * BF §3.2 C-5: lỗi luật ở vị trí BA đã "Vẫn làm" sau cảnh báo (`kept_intent`) ⇒ hỏi BA ngay, không để AI tự sửa; BA "giữ theo
 * ý mình" (`kept_violations`) ⇒ kiểm coi như qua, cờ đỏ thật hiện sau khi ghi. Mục ngoài phạm vi (`out-of-scope.ts`):
 * sửa chữ thì không kiểm luật Spine, mục trống chỉ nhận ghi chú.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { FindingsOutput } from "../../shared/ai/response-parser.js"
import { stripRecord } from "../import/check.service.js"
import { titleOfSection } from "../import/gap-report.service.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import { flagKey, runDeterministicCheck } from "../spine/deterministic-check.js"
import { humanizeText, internalElementNames, nameElementIds, pathLabel, ruleLabel } from "../spine/human-labels.js"
import { TransactionRejectedError, planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, submitCr, transitionCr } from "./change-request.service.js"
import { recordAutoPass } from "../pipeline/auto-pass.service.js"
import { MAX_REDO_PER_LOCATION } from "./change-request.state.js"
import { ChangeLocation, type IChangeLocation, type VerifyViolation } from "./change-location.model.js"
import { newContradictions } from "./clarify.service.js"
import { answersText, crHeader, glossaryText, plainValues, relatedElements, relatedPassages, truncate } from "./cr-context.js"
import { regroup } from "./group.service.js"
import { crDocumentLanguage, foreignTexts, isForeignText, wrongLanguageMessage } from "./cr-language.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { refreshDiagramLocations } from "./diagram-location.js"
import { fixDuplicateIds } from "./propose.service.js"
import { elementPathOf, elementValue, isArrayPath, listElements, opElement, sectionOfElement, unchangedSince, valueText } from "./spine-location.js"
import { structuralRequest } from "./structural-intent.js"
import { hasRemoveOp } from "./location-display.js"
import { loadOutOfScopeSections, outOfScopeKind, type OutOfScopeKind } from "./out-of-scope.js"

/**
 * Lỗi "luật" BA được phép giữ theo ý mình (C-5): đề xuất vẫn ghi được, chỉ làm Spine có cờ đỏ mới. Lỗi chữ cũ không còn
 * khớp, op sai định dạng, bất biến gãy... không giữ được vì không ghi được.
 */
export const KEEPABLE_RULES: ReadonlySet<string> = new Set(["new_red_flag"])

/** Mọi lỗi của vị trí đều là lỗi luật giữ được (và có ít nhất một lỗi). */
export const isKeepable = (violations: readonly Pick<VerifyViolation, "rule">[]): boolean => violations.length > 0 && violations.every((v) => KEEPABLE_RULES.has(v.rule))

/** Bỏ lỗi mà BA đã giữ theo ý mình. */
export const withoutKept = (violations: readonly VerifyViolation[], kept: readonly string[]): VerifyViolation[] => violations.filter((v) => !kept.includes(v.rule))

/** Vị trí AI cảnh báo mà BA chưa chọn "Vẫn làm" hay bỏ — chặn xác nhận. */
export const hasPendingWarning = (l: Pick<IChangeLocation, "warning" | "kept_intent" | "conclusion">): boolean => !!l.warning && !l.kept_intent && l.conclusion !== "not_related"
import { COUNT_COLLECTIONS, findCountMentionsInText, type CountCollection } from "./count-mentions.js"
import { removedItems } from "./content-removal.js"

export const valueChanged = (loc: Pick<IChangeLocation, "location_id" | "path">): Mode1Error =>
  new Mode1Error("CR_VALUE_CHANGED", `${pathLabel(loc.path)} đã bị sửa ở chỗ khác kể từ lúc đề xuất - tải lại rồi đề xuất lại`, { location_id: loc.location_id, path: loc.path })

type CheckLocation = Pick<IChangeLocation, "location_id" | "path" | "conclusion" | "proposal"> & Partial<Pick<IChangeLocation, "reason">>

const opPath = (raw: unknown): string => {
  const path = (raw as { path?: unknown } | null)?.path
  return typeof path === "string" ? path : ""
}

/** Phần tử mà các op của vị trí chạm tới (bỏ op thêm phần tử mới `arr[]`). */
export const opElements = (loc: Pick<IChangeLocation, "proposal">): string[] =>
  (loc.proposal?.spine_ops ?? []).map((o) => opElement(opPath(o))).filter((p): p is string => !!p)

/** Kiểm tất định từng vị trí (không gồm chạy khô op — xem `checkSpineOps`). `locks`: path ⇒ CR giữ khoá. */
/**
 * FLF-375: phần tử "thuộc" CR (thay bảng khoá đã bỏ) — mọi vị trí của CR + phần tử CR tự thêm bằng op `add` (lô use case
 * tạo use case / chức năng / màn mới rồi sửa tiếp chúng). Op chạm phần tử ngoài tập này ⇒ `op_path_not_locked`.
 */
export const ownedElements = (crId: string, locations: readonly Pick<IChangeLocation, "path" | "proposal">[]): Map<string, string> => {
  const owned = new Map<string, string>()
  for (const l of locations) {
    owned.set(l.path, crId)
    for (const raw of l.proposal?.spine_ops ?? []) {
      const o = raw as { op?: unknown; path?: unknown; value?: unknown }
      const array = typeof o.path === "string" ? /^(\w+)\[\]$/.exec(o.path)?.[1] : undefined
      const id = o.value && typeof o.value === "object" ? (o.value as { id?: unknown }).id : undefined
      if (o.op === "add" && array && typeof id === "string") owned.set(`${array}[id=${id}]`, crId)
    }
  }
  return owned
}

/** Chữ mới của đề xuất viết khác ngôn ngữ tài liệu (QLHS 11/11 bug #17) — `new_text` là JSON giá trị sau khi sửa. */
const languageViolation = (loc: CheckLocation, current: unknown, language: UserLocale): VerifyViolation[] => {
  let after: unknown = null
  try {
    after = JSON.parse(loc.proposal?.new_text ?? "null")
  } catch {
    after = null
  }
  const texts = after === null ? [] : foreignTexts(language, current, after)
  // FLF-480 (ChoViet #12b): ghi chú (thành comment trong file) phải cùng ngôn ngữ tài liệu. Lý do (`reason`) chỉ hiện ở màn CR
  // nên không chặn: chặn làm CR soạn lại nhiều vòng chỉ vì một câu giải thích
  const notes = [loc.proposal?.comment_text]
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter((t) => t && isForeignText(t, language))
  const all = [...texts, ...notes]
  return all.length ? [{ rule: "wrong_language", message: wrongLanguageMessage(pathLabel(loc.path), language, all) }] : []
}

/** `language`: ngôn ngữ chữ của tài liệu (`crDocumentLanguage`) — thiếu ⇒ không kiểm ngôn ngữ. */
export const checkLocation = (
  cr: Pick<IChangeRequest, "cr_id">,
  loc: CheckLocation,
  spine: Spine,
  locks: ReadonlyMap<string, string>,
  language?: UserLocale,
  scope: OutOfScopeKind | null = null
): VerifyViolation[] => {
  if (!loc.conclusion) return [{ rule: "unconcluded", message: "Vị trí chưa có kết luận" }]
  if (loc.conclusion === "not_related") return []
  const current = elementValue(spine, loc.path)
  if (current === undefined) return [{ rule: "element_missing", message: `${pathLabel(loc.path)} không còn trong tài liệu`, path: loc.path }]
  const out: VerifyViolation[] = []
  const p = loc.proposal
  if (!p) return [...out, { rule: "no_proposal", message: "Thiếu đề xuất" }]
  // FLF-375 (§3.2): trước khi xác nhận, đề xuất chưa có giá trị kiểm tra — chữ cũ đã đổi (người khác vừa ghi) ⇒ AI soạn
  // lại trên nội dung hiện tại như một lỗi kiểm thường; lúc xác nhận mới so 3 cột (`concurrent-edit.ts`)
  if (!unchangedSince(spine, loc.path, p)) return [...out, { rule: "value_changed", message: `${pathLabel(loc.path)} vừa được sửa ở chỗ khác - soạn lại trên nội dung hiện tại`, path: loc.path }]
  if (loc.conclusion === "edit") {
    if (scope === "comment") out.push({ rule: "out_of_scope_empty", message: `${pathLabel(loc.path)} nằm ngoài phạm vi và còn trống - chỉ ghi chú, không thêm nội dung`, path: loc.path })
    if (!p.spine_ops.length) out.push({ rule: "edit_without_ops", message: "Kết luận là sửa nhưng chưa có nội dung sửa" })
    else if (p.new_text !== null && p.new_text === p.old_text) out.push({ rule: "edit_no_change", message: "Đề xuất không thay đổi gì ở phần tử này" })
    for (const el of opElements(loc)) {
      if (el !== loc.path && locks.get(el) !== cr.cr_id) out.push({ rule: "op_path_not_locked", message: `Đề xuất sửa cả ${pathLabel(el)} - phần này không thuộc các vị trí của change request`, path: el })
    }
    // Vị trí "mục trống" (`arr[]`): chỉ được thêm phần tử vào đúng mảng đó, không lấn sang mảng khác
    if (isArrayPath(loc.path)) {
      const array = loc.path.slice(0, -2)
      for (const raw of p.spine_ops) {
        const path = opPath(raw)
        if (!path.startsWith(array)) out.push({ rule: "op_outside_section", message: `Đề xuất sửa ${pathLabel(path)} - vị trí này chỉ được thêm mới vào ${pathLabel(loc.path)}`, path })
      }
    } else {
      // Phần tử mới chỉ thêm từ ô "thêm mới" của đúng mục (2026-09-24: AI chèn bảng phân quyền thành mục riêng mới từ vị
      // trí tác nhân A01 / màn SCR-06 — thêm phần tử không qua khoá nên trước đây lọt kiểm)
      for (const raw of p.spine_ops) {
        const path = opPath(raw)
        if (isArrayPath(path)) {
          out.push({ rule: "add_outside_slot", message: `Đề xuất thêm ${pathLabel(path)} từ ${pathLabel(loc.path)} - phần tử mới phải thêm ở ô “thêm mới” của đúng mục`, path })
        }
      }
    }
    if (language) out.push(...languageViolation(loc, current, language))
  }
  if (loc.conclusion === "comment" && !p.comment_text?.trim()) out.push({ rule: "comment_empty", message: "Kết luận là ghi chú nhưng chưa có nội dung ghi chú" })
  return out
}

/**
 * FLF-469 (A.2): phần tử mà một op chạm tới, để tìm vị trí sở hữu của vi phạm không mang `op_index` (lỗi schema / bất biến
 * tính trên cả Spine sau lô). `set` / `remove` ⇒ phần tử của path; `add` ⇒ phần tử mới theo `value.id` (`arr[id=X]`).
 */
const touchedElement = (op: Op): string | null => {
  const array = /^(\w+)\[\]$/.exec(op.path)?.[1]
  if (op.op === "add" && array) {
    const id = (op as { value?: unknown }).value && typeof (op as { value?: unknown }).value === "object" ? ((op as { value: { id?: unknown } }).value.id) : undefined
    return typeof id === "string" ? `${array}[id=${id}]` : null
  }
  return elementPathOf(op.path)
}

/**
 * Vị trí sở hữu của vi phạm có `path` (hoặc cờ đỏ có `target_id`): op `set` / `remove` cùng phần tử, hoặc op `add` có
 * `value.id` khớp. Cờ chỉ mang id (`FN045`) khớp phần tử `…[id=FN045]`. Không tìm được ⇒ rỗng (caller chọn cách dự phòng).
 */
export const ownersOfPath = (ops: readonly Op[], owner: readonly string[], violationPath: string): string[] => {
  const element = elementPathOf(violationPath)
  const byId = element ? null : (/^[\w.-]+$/.test(violationPath) ? `[id=${violationPath}]` : null)
  const hit = new Set<string>()
  ops.forEach((op, i) => {
    const touched = touchedElement(op)
    if (!touched) return
    if ((element && touched === element) || (byId && touched.endsWith(byId))) hit.add(owner[i])
  })
  return [...hit]
}

/**
 * FLF-469 (A.2): lỗi schema của lô sau khi áp (`schema_invalid`) có path dạng Zod `entities.0.attributes.0.kind` - chỉ số
 * trong mảng SAU lô. Đổi `arr.N...` thành `arr[id=X]` bằng cách mô phỏng thứ tự mảng: phần tử có sẵn rồi phần tử op `add`
 * thêm (theo thứ tự op), trừ phần tử op `remove` xoá. Không đổi được ⇒ trả nguyên path.
 */
export const indexPathToElement = (spine: Spine, ops: readonly Op[], violationPath: string): string => {
  const m = /^(\w+)\.(\d+)(?:\.|$)/.exec(violationPath)
  if (!m) return violationPath
  const ids = ((spine as unknown as Record<string, unknown>)[m[1]] as { id?: unknown }[] | undefined)?.map((e) => String(e.id)) ?? []
  for (const op of ops) {
    const touched = touchedElement(op)
    if (!touched?.startsWith(`${m[1]}[id=`)) continue
    const id = /\[id=([^\]]+)\]/.exec(touched)?.[1]
    if (!id) continue
    if (op.op === "add" && !ids.includes(id)) ids.push(id)
    else if (op.op === "remove") ids.splice(0, ids.length, ...ids.filter((x) => x !== id))
  }
  const id = ids[Number(m[2])]
  return id === undefined ? violationPath : `${m[1]}[id=${id}]`
}

/** Chạy khô toàn bộ op Spine của CR; vi phạm gắn về vị trí sinh ra op. */
/** `exempt`: vị trí không chịu kiểm luật (sửa chữ ở mục ngoài phạm vi) — lỗi đỏ mới không gắn vào chúng. */
export const checkSpineOps = (
  spine: Spine,
  cr: Pick<IChangeRequest, "cr_id">,
  locations: CheckLocation[],
  exempt: ReadonlySet<string> = new Set()
): Map<string, VerifyViolation[]> => {
  const out = new Map<string, VerifyViolation[]>()
  const push = (locId: string, v: VerifyViolation) => out.set(locId, [...(out.get(locId) ?? []), v])
  const ops: Op[] = []
  const owner: string[] = []
  for (const l of locations) {
    if (l.conclusion !== "edit") continue
    for (const raw of l.proposal?.spine_ops ?? []) {
      const parsed = userOpSchema.safeParse(raw)
      if (!parsed.success) {
        push(l.location_id, { rule: "op_invalid", message: "Nội dung sửa sai định dạng, không áp dụng được" })
        continue
      }
      ops.push(parsed.data)
      owner.push(l.location_id)
    }
  }
  if (!ops.length) return out
  // FLF-469 (A.1): vị trí có op mà C-4 chạy khô riêng đã hỏng (`new_text = null`) — khi cả lô trượt mà vi phạm không chỉ
  // được vào đâu, đó là nghi can duy nhất; vị trí khác không bị kéo theo (không soạn lại oan).
  const broken = [...new Set(locations.filter((l) => l.conclusion === "edit" && l.proposal && l.proposal.new_text === null && l.proposal.spine_ops.length > 0).map((l) => l.location_id))].filter((id) => owner.includes(id))
  try {
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: cr.cr_id }, { startSeq: 1 })
    const before = new Set(runDeterministicCheck(spine, [], { ruleProfile: MODE1_RULE_PROFILE }).filter((c) => c.level === "red").map(flagKey))
    // `diagram_stale` không tính: sửa dữ liệu hình thể hiện thì hình PlantUML cũ đi là đương nhiên — 3.14 vẽ lại ngay sau
    // khi ghi. Trước đây mọi CR đổi tên use case / actor / màn đều trượt kiểm vì "lỗi đỏ mới" này.
    const newRed = runDeterministicCheck(plan.spine, [], { ruleProfile: MODE1_RULE_PROFILE }).filter(
      (c) => c.level === "red" && c.rule_id !== "diagram_stale" && !before.has(flagKey(c))
    )
    for (const c of newRed) {
      // FLF-469 (A.3): cờ có đích phần tử ⇒ chỉ vị trí sinh ra phần tử đó; không khớp được mới gán cho mọi vị trí
      const mine = c.target_id ? ownersOfPath(ops, owner, c.target_id) : []
      const targets = mine.length ? mine : [...new Set(owner)]
      for (const locId of targets.filter((o) => !exempt.has(o))) push(locId, { rule: "new_red_flag", message: `Đề xuất làm phát sinh lỗi đỏ mới: ${ruleLabel(c.rule_id) ? `${ruleLabel(c.rule_id)} - ` : ""}${c.message}` })
    }
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) throw err
    for (const v of err.violations) {
      const byIndex = v.op_index !== undefined ? owner[v.op_index] : undefined
      // FLF-469 (A.2): không có op_index mà có path ⇒ vị trí sở hữu phần tử đó; rồi tới vị trí chạy khô riêng đã hỏng
      const byPath = byIndex || !v.path ? [] : ownersOfPath(ops, owner, indexPathToElement(spine, ops, v.path))
      const targets = byIndex ? [byIndex] : byPath.length ? byPath : broken.length ? broken : [...new Set(owner)]
      for (const id of targets) push(id, { rule: v.rule, message: humanizeText(v.message), ...(v.path ? { path: v.path } : {}) })
    }
  }
  return out
}

/**
 * C-6 (BF §3.2): kiểm lại toàn bộ op của CR trên nội dung **hiện tại** của Spine ngay trước khi ghi — chạy khô + bất biến +
 * lỗi đỏ mới (so trước / sau, như lúc kiểm C-5). Trả lỗi theo vị trí sau khi trừ lỗi BA đã giữ theo ý mình và vị trí ngoài
 * phạm vi; rỗng ⇒ ghi được. Không gọi AI.
 */
export const recheckBeforeWrite = async (cr: IChangeRequest, locations: IChangeLocation[], spine: Spine): Promise<Map<string, VerifyViolation[]>> => {
  const outOfScope = await loadOutOfScopeSections(String(cr.projectId))
  const exempt = new Set(locations.filter((l) => outOfScopeKind(spine, l, outOfScope) === "text").map((l) => l.location_id))
  const out = new Map<string, VerifyViolation[]>()
  for (const [locId, vs] of checkSpineOps(spine, cr, locations, exempt)) {
    const loc = locations.find((l) => l.location_id === locId)
    const left = withoutKept(vs, loc?.kept_violations ?? [])
    if (left.length) out.set(locId, left)
  }
  return out
}

/** FLF-473: Spine sau khi áp toàn bộ op `edit` của CR (như `checkSpineOps`) — op lỗi ⇒ `null` (bỏ qua câu đếm, lỗi thật đã bắt ở trên). */
const plannedAfterAll = (spine: Spine, locations: readonly CheckLocation[]): Spine | null => {
  const ops: Op[] = []
  for (const l of locations) {
    if (l.conclusion !== "edit") continue
    for (const raw of l.proposal?.spine_ops ?? []) {
      const parsed = userOpSchema.safeParse(raw)
      if (parsed.success) ops.push(parsed.data)
    }
  }
  if (!ops.length) return spine
  try {
    return planTransaction(spine, { base_version: spine.spine_version, ops, by: "cr-verify:count" }, { startSeq: 1 }).spine
  } catch (err) {
    if (err instanceof TransactionRejectedError) return null
    throw err
  }
}

type CountCheckLocation = CheckLocation & Pick<IChangeLocation, "found_by" | "entity_paths">

/**
 * FLF-473 (EduCampus B14): C-5 tất định cho câu đếm (`found_by: "count"`) — đề xuất vẫn ghi số cũ, hoặc AI tự tính sai
 * (vd "10 trừ 1 = 9" thay vì đếm lại trên Spine), là một lỗi code như mọi lỗi khác (AI làm lại), không chỉ cờ vàng.
 * `after`: Spine sau khi áp toàn bộ op `edit` của CR (`plannedAfterAll`).
 */
export const checkCountMentions = (after: Spine, locations: readonly CountCheckLocation[]): Map<string, VerifyViolation[]> => {
  const counts = new Map<CountCollection, number>(COUNT_COLLECTIONS.map((c) => [c, ((after as unknown as Record<string, unknown[]>)[c] ?? []).length]))
  const out = new Map<string, VerifyViolation[]>()
  for (const l of locations) {
    if (l.conclusion !== "edit" || !l.found_by.includes("count")) continue
    const collection = l.entity_paths.find((p): p is CountCollection => counts.has(p as CountCollection))
    if (!collection) continue
    const correct = counts.get(collection)!
    const wrong = [...new Set(findCountMentionsInText(l.proposal?.new_text ?? "").filter((m) => m.collection === collection && m.number !== correct).map((m) => m.number))]
    if (wrong.length) {
      out.set(l.location_id, [{ rule: "count_mismatch", message: `Câu đếm ở đây vẫn ghi ${wrong.join(", ")} - đúng phải là ${correct} theo dữ liệu sau khi ghi, không tự tính` }])
    }
  }
  return out
}

/** FLF-469 (C.1): Spine sau khi áp toàn bộ op `edit` của CR; op lỗi ⇒ `null` (lỗi thật đã báo ở `checkSpineOps`). */
export const afterAllOps = (spine: Spine, _cr: Pick<IChangeRequest, "cr_id">, locations: readonly CheckLocation[]): Spine | null =>
  plannedAfterAll(spine, locations)

type RequestCr = Pick<IChangeRequest, "title" | "description" | "amendments" | "clarifications" | "targets">

/** Đích C-2 của CR về phần tử của `collection` (`functions[id=FN1]`, hoặc mục `function:FN1`). */
const targetElementsOf = (cr: Pick<IChangeRequest, "targets">, collection: string): string[] =>
  [
    ...new Set(
      (cr.targets?.entity_paths ?? []).flatMap((t) => {
        const fn = /^function:(.+)$/.exec(t)?.[1]
        const el = fn ? `functions[id=${fn}]` : elementPathOf(t)
        return el && el.startsWith(`${collection}[`) ? [el] : []
      })
    )
  ]

/**
 * FLF-469 (C.1, ChoViet #2): kiểm "yêu cầu chính đã làm chưa" bằng code. CR có ý cấu trúc (`structural-intent.ts`):
 * - xoá mà phần tử đích (CR nêu mã hoặc tên) vẫn còn sau khi chạy khô cả lô ⇒ `request_not_done` ở vị trí của phần tử;
 * - thêm chức năng / màn mà không op nào `add` vào mảng đó ⇒ `request_not_done` ở ô thêm mới (hoặc vị trí đầu). Ý thêm suy
 *   từ "cho phép…" (yếu) chỉ chặn khi cả CR không có vị trí `edit` nào.
 * `after`: Spine sau cả lô (`afterAllOps`); `null` ⇒ bỏ qua (op lỗi đã bị báo riêng).
 */
export const checkRequestDone = (cr: RequestCr, spine: Spine, after: Spine | null, locations: readonly CheckLocation[]): Map<string, VerifyViolation[]> => {
  const out = new Map<string, VerifyViolation[]>()
  const request = structuralRequest(cr)
  if (!request || !after || !locations.length) return out
  const label = request.collection === "screens" ? "màn hình" : "chức năng"
  const text = [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text), ...cr.clarifications.flatMap((c) => c.answers)].join(" ").toLowerCase()
  const push = (locId: string, message: string) => out.set(locId, [...(out.get(locId) ?? []), { rule: "request_not_done", message }])
  if (request.intent === "remove") {
    for (const path of targetElementsOf(cr, request.collection)) {
      const before = elementValue(spine, path) as { id?: unknown; name?: unknown } | undefined
      if (!before || elementValue(after, path) === undefined) continue
      const id = String(before.id ?? "").toLowerCase()
      const name = typeof before.name === "string" ? before.name.trim().toLowerCase() : ""
      if (!(name.length >= 3 && text.includes(name)) && !(id && text.includes(id))) continue
      const holder = locations.find((l) => l.path === path) ?? locations[0]
      push(holder.location_id, `Yêu cầu chính chưa làm: ${label} “${typeof before.name === "string" ? before.name : String(before.id)}” vẫn còn trong tài liệu - cần xoá hẳn ${label} này (thao tác xoá), không chỉ ghi chú`)
    }
  } else {
    const slot = `${request.collection}[]`
    const edits = locations.filter((l) => l.conclusion === "edit")
    const added = edits.some((l) => (l.proposal?.spine_ops ?? []).some((raw) => (raw as { op?: unknown; path?: unknown }).op === "add" && opPath(raw) === slot))
    if (!added && (request.strong || !edits.length)) {
      const holder = locations.find((l) => l.path === slot) ?? locations[0]
      push(holder.location_id, `Yêu cầu chính chưa làm: chưa có ${label} nào được thêm - cần thêm ${label} mới đầy đủ (thao tác thêm), không chỉ ghi chú nhắc tự làm`)
    }
  }
  return out
}

/** Phần phạm vi cùng section (giữ chỗ cho phần tử section khác + đoạn văn giữ nguyên, FLF-367). */
const NEIGHBOURS_CHARS = 5000

/**
 * Phạm vi đưa AI xem: phần tử khác cùng section với vị trí sửa (tối đa `limit` phần tử); FLF-367 thêm phần tử liên quan ở
 * section khác và đoạn văn giữ nguyên liên quan (theo cụm từ của CR + giá trị sau khi sửa).
 */
export const scopeText = (spine: Spine, changed: readonly Pick<IChangeLocation, "path" | "section_id" | "proposal">[], query: string, limit = 20): string => {
  const sections = new Set(changed.map((l) => l.section_id))
  const edited = new Set(changed.map((l) => l.path))
  const neighbours = listElements(spine)
    .filter((e) => !edited.has(e.path) && sections.has(sectionOfElement(spine, e.path)))
    .slice(0, limit)
  const shown = new Set([...edited, ...neighbours.map((e) => e.path)])
  // Giá trị sau khi sửa là JSON ⇒ chỉ lấy giá trị chữ (tên khoá như "business_rule_ids" kéo mọi phần tử vào)
  const text = `${query}\n${changed.map((l) => plainValues(l.proposal?.new_text ?? l.proposal?.comment_text ?? "")).join("\n")}`
  const others = relatedElements(spine, text, { exclude: [...shown] })
  const passages = relatedPassages(spine, text, { exclude: [...shown] })
  const lines = [
    truncate(neighbours.map((e) => `[${e.path}] (${sectionOfElement(spine, e.path)}) ${truncate(valueText(e.value), 600)}`).join("\n"), NEIGHBOURS_CHARS),
    ...others.map((e) => `[${e.path}] (${e.section_id}) ${e.text}`),
    ...(passages.length ? ["Passages kept verbatim:", ...passages] : [])
  ].filter(Boolean)
  return lines.join("\n") || "(none)"
}

/**
 * FLF-367: mâu thuẫn C-5 thấy ⇒ hỏi người yêu cầu (`verifying → clarifying → awaiting_answers`) thay vì ghi chú vàng.
 * Câu hỏi = nhận xét (trích cả hai phía) + lựa chọn; câu đã hỏi ở vòng trước thì thôi. Vị trí không sửa tay bỏ kết luận
 * để C-4 đề xuất lại theo câu trả lời (khoá giữ nguyên như luồng gộp lệnh `amend`; C-3 tìm lại vị trí như thường).
 */
const askContradictions = async (cr: IChangeRequest, locations: IChangeLocation[], questions: { question: string; suggestions: string[] }[]): Promise<void> => {
  for (const l of locations) {
    if (l.manual) continue
    l.conclusion = null
    l.reason = null
    l.proposal = null
    l.verify = null
    l.redo_count = 0
  }
  await Promise.all(locations.map((l) => l.save()))
  await regroup(cr)
  await transitionCr(cr, "clarifying")
  cr.clarifications.push({
    round: cr.clarifications.length + 1,
    questions: questions.map((q) => q.question),
    answers: [],
    suggestions: questions.map((q) => q.suggestions),
    kinds: questions.map(() => "contradiction" as const)
  })
  cr.markModified("clarifications")
  await transitionCr(cr, "awaiting_answers")
}

type AiFlag = { rule: string; message: string }

/** Nhận xét AI của lần kiểm trước, theo vị trí (vị trí vừa đề xuất lại có `verify = null` ⇒ không còn nhận xét). */
export const previousFlags = (locations: readonly Pick<IChangeLocation, "location_id" | "verify">[]): Map<string, AiFlag[]> =>
  new Map(locations.flatMap((l) => (l.verify?.ai_flags.length ? [[l.location_id, l.verify.ai_flags.map((f) => ({ rule: f.rule, message: f.message }))] as const] : [])))

export const previousFindingsText = (flags: ReadonlyMap<string, readonly AiFlag[]>): string => {
  const messages = [...new Set([...flags.values()].flat().map((f) => `- (${f.rule}) ${f.message}`))]
  return messages.length ? truncate(messages.join("\n"), 3000) : "(none)"
}

/** FLF-474: vị trí đang mang xung đột chưa được người dùng quyết (quyết xong thì `location.service` xoá `conflict`). */
export const hasOpenConflict = (l: Pick<IChangeLocation, "conflict" | "conclusion">): boolean => !!l.conflict && l.conclusion === "edit"

/** Vì sao CR đã qua kiểm mà vẫn dừng chờ BA ở mức "Chỉ ở mốc chốt" (`null` = được tự ghi). */
export type AutoSubmitHold = "content_removed" | "ai_flags" | "pending_warning" | "kept_violations"

/**
 * FLF-483 (M1-a): điều kiện chặn tự ghi, tách riêng để các ticket khác thêm lý do mà không viết lại khối `autoSubmit`
 * (FLF-469 C.3: `request_not_met`; FLF-448: `pending_warning`, `kept_violations`). Thứ tự xét: xoá nội dung, rồi nhận xét AI.
 * "Xoá nội dung" = có op `remove` **hoặc** mục con có id biến mất sau op `set` (`removedItems`). `after`: Spine sau khi áp
 * mọi op `edit` của CR (`plannedAfterAll`); `null` (op không chạy khô được) ⇒ chỉ còn dấu hiệu op `remove`.
 */
export const autoSubmitHold = (
  spine: Spine,
  locations: readonly (CheckLocation & Pick<IChangeLocation, "verify" | "warning" | "kept_intent" | "kept_violations">)[],
  after: Spine | null
): AutoSubmitHold | null => {
  const editing = locations.filter((l) => l.conclusion === "edit")
  if (locations.some((l) => hasRemoveOp(l.proposal))) return "content_removed"
  if (after && removedItems(spine, after, editing.flatMap(opElements)).length) return "content_removed"
  if (locations.some((l) => (l.verify?.ai_flags?.length ?? 0) > 0)) return "ai_flags"
  if (locations.some((l) => hasPendingWarning(l))) return "pending_warning"
  if (locations.some((l) => l.kept_violations.length > 0)) return "kept_violations"
  return null
}

export const runVerify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["proposing", "manual_fix", "ready_to_submit", "verifying"], "verifying")
  await transitionCr(cr, "verifying")
  cr.paused = null
  await cr.save()
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })
  // Sửa tay / "Sửa lại" cũng có thể mang id trùng ⇒ đổi trước khi chạy khô (FLF-307)
  await fixDuplicateIds(spine, locations, String(cr.projectId))
  // Đề xuất của vị trí khác có thể đã đổi (sửa tay, "Sửa lại") ⇒ kết luận vẽ lại sơ đồ gốc tính lại trước khi kiểm (§4.13)
  await refreshDiagramLocations(spine, locations)
  const locks = ownedElements(cr.cr_id, locations)

  // QLHS 11/11 bug #17: chữ mới phải cùng ngôn ngữ tài liệu — lệch ⇒ vi phạm, AI làm lại như mọi lỗi kiểm code
  const language = await crDocumentLanguage(String(cr.projectId), spine)
  const outOfScope = await loadOutOfScopeSections(String(cr.projectId))
  const scopeOf = (l: IChangeLocation) => outOfScopeKind(spine, l, outOfScope)
  // FLF-474 (7a): chỗ còn xung đột (người khác đã sửa, chờ người dùng quyết ở màn 3 cột) không kiểm như chỗ thường —
  // đề xuất của nó đã cũ, kiểm sẽ báo `value_changed` rồi AI tự soạn lại đè phần người khác vừa sửa (BF A5)
  const inConflict = (l: IChangeLocation) => hasOpenConflict(l)
  const checked = locations.filter((l) => !inConflict(l))
  const violations = new Map(locations.map((l) => [l.location_id, inConflict(l) ? [] : checkLocation(cr, l, spine, locks, language, scopeOf(l))]))
  const exempt = new Set(locations.filter((l) => scopeOf(l) === "text").map((l) => l.location_id))
  for (const [locId, vs] of checkSpineOps(spine, cr, checked, exempt)) violations.set(locId, [...(violations.get(locId) ?? []), ...vs])
  // FLF-469 (C.1): yêu cầu chính (xoá / thêm cả chức năng) phải thật sự được làm
  for (const [locId, vs] of checkRequestDone(cr, spine, afterAllOps(spine, cr, locations), locations)) violations.set(locId, [...(violations.get(locId) ?? []), ...vs])
  // C-5 "giữ theo ý mình": lỗi luật BA đã giữ không tính (cờ đỏ thật hiện sau khi ghi)
  for (const l of locations) if (l.kept_violations.length) violations.set(l.location_id, withoutKept(violations.get(l.location_id) ?? [], l.kept_violations))
  // FLF-473 (B14): câu đếm phải khớp số đúng SAU khi ghi cả CR — op đã lỗi thì bỏ qua (checkSpineOps đã báo lỗi thật)
  const countAfter = plannedAfterAll(spine, locations)
  if (countAfter) for (const [locId, vs] of checkCountMentions(countAfter, locations)) violations.set(locId, [...(violations.get(locId) ?? []), ...vs])

  // AI consistency (FLF-307): chỉ khi cả CR đã qua kiểm code — vòng nào còn trượt thì AI làm lại, nhận xét lúc đó vô
  // ích. Không vị trí nào đổi đề xuất kể từ lần kiểm trước (`verify` còn nguyên) ⇒ giữ nhận xét cũ, không gọi lại: mỗi
  // lượt gọi ra một bộ nhận xét khác, người dùng tưởng sửa mãi không hết.
  const previous = previousFlags(locations)
  const codeOk = locations.every((l) => !violations.get(l.location_id)?.length)
  const changed = checked.filter((l) => l.conclusion === "edit" || l.conclusion === "comment")
  const aiFlags = new Map(previous)
  if (codeOk && changed.some((l) => l.verify === null)) {
    // Vị trí vừa đề xuất lại bỏ nhận xét cũ (có thể đã sửa đúng chỗ đó); AI thấy mọi nhận xét cũ để không nêu lại
    for (const l of changed) if (l.verify === null) aiFlags.delete(l.location_id)
    const result = await withMeteredAi<FindingsOutput>({ projectId: String(cr.projectId), userId, stepId: `C-5:${cr.cr_id}` }, ActionType.CR_CONSISTENCY, {
      ...crHeader(cr),
      answers: answersText(cr),
      previous_findings: previousFindingsText(previous),
      edits: truncate(
        changed
          .map((l) =>
            l.conclusion === "edit"
              ? `[${l.location_id}][${l.path}] (${l.section_id === "misc" ? "-" : `${l.section_id} ${titleOfSection(spine, l.section_id)}`})\n  before: ${truncate(l.proposal?.old_text ?? "", 1500)}\n  after: ${truncate(l.proposal?.new_text ?? "", 1500)}`
              : `[${l.location_id}][${l.path}] (comment) ${l.proposal?.comment_text}`
          )
          .join("\n")
      ),
      scope: scopeText(spine, changed, `${cr.title}\n${crHeader(cr).description}\n${answersText(cr)}`),
      glossary: glossaryText(spine)
    })
    if (!result.ok) {
      cr.paused = { reason: result.reason, at: new Date() }
      await cr.save()
      return
    }
    // FLF-367: mâu thuẫn ⇒ hỏi người yêu cầu (câu đã hỏi thì thôi, thành ghi chú vàng như cũ); nhận xét khác vẫn vàng
    const contradictions = newContradictions(
      cr,
      result.data.findings.filter((f) => f.rule === "contradiction").map((f) => ({ question: humanizeText(f.message), suggestions: [] })),
      "vi",
      // FLF-474: so với câu đã lưu (đã đổi mã sang tên) theo độ trùng từ, không nguyên văn
      { name: (text) => nameElementIds(text, spine, internalElementNames(spine)) }
    )
    if (contradictions.length) {
      await askContradictions(cr, locations, contradictions)
      return
    }
    // FLF-469 (C.2): `request_not_met` = yêu cầu chính chưa được làm ⇒ vi phạm chặn (quay về soạn lại, 2 lần rồi sửa tay),
    // không phải ghi chú vàng. Gắn vào vị trí ghi chú (chỗ đáng lẽ phải làm), không có thì vị trí sửa đầu tiên.
    const notMet = result.data.findings.filter((f) => f.rule === "request_not_met")
    if (notMet.length) {
      const holder = changed.find((l) => l.conclusion === "comment") ?? changed[0]
      for (const f of notMet) violations.set(holder.location_id, [...(violations.get(holder.location_id) ?? []), { rule: "request_not_met", message: `Yêu cầu chính chưa làm: ${humanizeText(f.message)}` }])
    }
    for (const f of result.data.findings.filter((x) => x.rule !== "request_not_met")) {
      // Nhận xét gắn vào vị trí sửa cùng section; không khớp section nào thì vị trí sửa đầu tiên (người duyệt vẫn thấy)
      const hit = changed.filter((c) => c.section_id === f.section_id)
      const flag = { rule: f.rule, message: humanizeText(f.message) }
      for (const l of hit.length ? hit : changed.slice(0, 1)) {
        const mine = aiFlags.get(l.location_id) ?? []
        if (!mine.some((x) => x.message === flag.message)) aiFlags.set(l.location_id, [...mine, flag])
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
  const stillConflicting = locations.some(inConflict)
  let next: "ready_to_submit" | "proposing" | "manual_fix" = "ready_to_submit"
  if (stillConflicting) {
    // Còn chỗ xung đột chưa quyết ⇒ dừng ở `manual_fix`, không để AI soạn lại (không tăng `redo_count`)
    next = "manual_fix"
  } else if (failing.length) {
    // Lỗi luật ở chỗ BA đã "Vẫn làm" ⇒ hỏi BA ngay (giữ theo ý mình hoặc đổi hướng), không tốn lượt AI làm lại
    const keptIntentFails = failing.some((l) => l.kept_intent && isKeepable(l.verify?.violations ?? []))
    next = keptIntentFails || failing.some((l) => l.manual || l.redo_count >= MAX_REDO_PER_LOCATION) ? "manual_fix" : "proposing"
    if (next === "proposing") for (const l of failing) l.redo_count += 1
  }
  await Promise.all(locations.map((l) => l.save()))
  await transitionCr(cr, next)
  // FLF-337: mức "Chỉ ở mốc chốt" sau baseline — CR qua C-5 (Code + AI không phàn nàn) tự xác nhận, ghi vào bản nháp (C-6 FLF-330).
  // Nguồn + người yêu cầu đã bắt buộc lúc tạo; Lead duyệt gói (C-7) vẫn là cổng cứng. AI có nhận xét ⇒ để BA xem.
  // BF §3.2 mức duyệt: CR có xoá nội dung, có cảnh báo AI chưa quyết hoặc có lỗi luật BA giữ theo ý mình luôn dừng chờ BA.
  if (next === "ready_to_submit" && spine.project.review_mode === "milestones" && autoSubmitHold(spine, locations, countAfter) === null) {
    await submitCr(cr, userId)
    // Kiểm lại lúc ghi thấy lỗi mới ⇒ CR quay về `manual_fix`, không ghi: không báo "tự ghi"
    if (cr.status !== "written") return
    await recordAutoPass(String(cr.projectId), `C-6:${cr.cr_id}`, "Chỉ ở mốc chốt: change request qua kiểm tự ghi vào bản nháp", `${cr.cr_id} ${cr.title}`)
  }
}
