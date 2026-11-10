/**
 * Kế hoạch ghi Spine của một lần đổi mẫu — hàm thuần (không DB, không AI): từ migration + Spine + log Change ⇒ các op cần ghi và các
 * Change cần đảo. Bước áp dụng chạy khô kế hoạch này (`planRevert` + `planTransaction`) trước khi lưu bất cứ thứ gì, nên op sai /
 * liên kết gãy lộ ra khi chưa có gì để dọn.
 *
 * Mọi Change của lần đổi mẫu có `txn` bắt đầu bằng `template-migration:<id>` (xem `edited-since.ts`):
 *   `…:<id>`         lô op (xoá mục riêng, thêm mục riêng trống, chữ đã dịch)
 *   `…:<id>:revert`  lô đảo Change của đổi ngược (mục `discard` + chữ gốc của mục chưa sửa)
 *   `…:<id>:undo`    lô đảo toàn bộ lần đổi mẫu khi hoàn tác
 */
import { decidableItems, DROP_FROM_PRINT, type MigrationGroups } from "./classify.js"
import { TEMPLATE_MIGRATION_TXN_PREFIX, sectionKeyResolver, type KeyResolver } from "./edited-since.js"
import type { Follower, OldHeading } from "./pair-sections.js"
import type { PlannedLayoutEntry } from "./build-base-file.js"
import { sectionsOfPath } from "../spine/section-registry.js"
import type { Op } from "../spine/op.types.js"
import type { Change, Spine } from "../spine/spine.types.js"

export const migrationTxn = (id: string, suffix?: "revert" | "undo"): string => `${TEMPLATE_MIGRATION_TXN_PREFIX}${id}${suffix ? `:${suffix}` : ""}`

/** Txn của lần đổi mẫu `id` (cả ba loại lô). `id` là ObjectId hex nên không cần escape. */
export const isMigrationTxn = (txn: string, id: string): boolean => txn === migrationTxn(id) || txn.startsWith(`${migrationTxn(id)}:`)

/** Giá trị suy diễn (cờ, tiến độ) do tính lại tự ghi — không phải thay đổi của người dùng. Cờ có thể trỏ vào mục riêng do đổi mẫu thêm, nên phải đảo cùng. */
export const DERIVED_PATH = /^(flags|progress)(\[|\.|$)/

/** Lý do ghi của waiver / giữ cờ do người dùng bấm (`flags.service#waive` / `keep`) — không phải giá trị suy diễn. */
const USER_FLAG_REASON = /^(Waive |Giữ nguyên )/

/** Cờ / tiến độ do tính lại tự ghi. Waiver / giữ cờ của BA là thay đổi của người dùng: không đảo, và chặn hoàn tác. */
export const isDerivedChange = (c: { path: string; reason: string | null }): boolean => DERIVED_PATH.test(c.path) && !USER_FLAG_REASON.test(c.reason ?? "")

export const isAnyMigrationTxn = (txn: string): boolean => txn.startsWith(TEMPLATE_MIGRATION_TXN_PREFIX)

interface DecisionView {
  decisions: readonly { id: string; choice: string }[]
  groups: MigrationGroups
}

/** Lựa chọn hiệu lực của một mục (quyết định của BA, không có thì mặc định của nhóm). */
export const choiceOf = (doc: DecisionView, id: string): string | null => doc.decisions.find((d) => d.id === id)?.choice ?? decidableItems(doc.groups).get(id)?.default ?? null

/**
 * Mục riêng cũ (`custom:*`) bị BA chọn `delete` ⇒ op xoá khỏi Spine, kèm phần nối đi theo mục đó. Mục khung (`fixed:*`…) chọn `delete`
 * chỉ bị bỏ khỏi file nền: dữ liệu có cấu trúc của nó (use case, bảng…) vẫn là của Spine, không xoá.
 */
export const deleteOps = (doc: DecisionView, oldHeadings: readonly OldHeading[], spine: Pick<Spine, "custom_sections">): Op[] => {
  const byKey = new Map(oldHeadings.map((h) => [h.key, h]))
  const existing = new Set(spine.custom_sections.map((c) => c.id))
  const ids = new Set<string>()
  for (const e of doc.groups.extra) {
    if (choiceOf(doc, e.id) !== "delete") continue
    for (const key of [e.old_key, ...e.follower_keys]) {
      const section = byKey.get(key)?.section_id
      if (section?.startsWith("custom:")) ids.add(section.slice("custom:".length))
    }
  }
  return [...ids].filter((id) => existing.has(id)).map((id) => ({ op: "remove", path: `custom_sections[id=${id}]`, reason: "Xoá mục riêng theo lựa chọn khi đổi mẫu" }))
}

const CUSTOM_ID = /^CS(\d+)$/

/** Bộ cấp id `CS<nn>` kế tiếp chưa dùng trong Spine (cùng khuôn id mục riêng lúc import). */
export const customIdAllocator = (spine: Pick<Spine, "custom_sections">): (() => string) => {
  let max = 0
  for (const c of spine.custom_sections) max = Math.max(max, Number(CUSTOM_ID.exec(c.id)?.[1] ?? 0))
  return () => `CS${String(++max).padStart(2, "0")}`
}

/** Mục riêng trống cho heading riêng của mẫu đích chưa có cặp — BA viết sau (đường soạn mục trống của CR). */
export const addCustomOps = (customs: readonly { section_id: string; heading_text: string; level: number }[]): Op[] =>
  customs.map((c) => ({
    op: "add",
    path: "custom_sections[]",
    value: { id: c.section_id.slice("custom:".length), heading: c.heading_text, level: Math.min(Math.max(c.level, 1), 9), blocks: [], source: "manual" },
    reason: "Thêm mục riêng của mẫu mới (trống, chờ viết)"
  }))

export interface ReverseSelection {
  /** Change cần đảo (chưa sắp xếp — op engine đảo theo seq giảm dần). */
  changes: Change[]
  /** `old_key` mục đã sửa mà BA giữ — chữ của chúng ở ngôn ngữ mẫu cũ cần dịch lại nếu khác ngôn ngữ. */
  keepKeys: Set<string>
}

export interface ReverseInput {
  doc: DecisionView
  /** Lần đổi mẫu trước mà lần này quay về mẫu trước của nó. */
  priorId: string
  priorAppliedAt: Date
  oldHeadings: readonly OldHeading[]
  followers: readonly Follower[]
  spine: Spine
  changes: readonly Change[]
}

/**
 * Đổi ngược (D15): đảo (a) Change do chính lần đổi mẫu trước ghi — trả chữ gốc của mục chưa sửa, khôi phục mục riêng đã xoá —
 * trừ mục đã sửa mà BA giữ (chữ của chúng đã là của người dùng); (b) Change của người dùng ghi sau lần đổi mẫu trước ở mục BA chọn
 * `discard` (lịch sử CR giữ nguyên, việc đảo là một lô mới ghi như hoàn tác). Mục `keep` không bị đụng.
 */
export const selectReverseChanges = (input: ReverseInput): ReverseSelection => {
  const resolve: KeyResolver = sectionKeyResolver(input.oldHeadings, input.followers)
  const keepKeys = new Set<string>()
  const discardKeys = new Set<string>()
  for (const e of input.doc.groups.edited_since) (choiceOf(input.doc, e.id) === "discard" ? discardKeys : keepKeys).add(e.old_key)
  const since = input.priorAppliedAt.getTime()
  const firstOwnSeq = input.changes.filter((c) => isMigrationTxn(c.txn, input.priorId)).reduce((m, c) => Math.min(m, c.seq), Infinity)

  const changes: Change[] = []
  for (const c of input.changes) {
    // Cờ / tiến độ tính lại từ lúc đổi mẫu: đảo hết (tính lại sau khi áp dụng) để cờ không trỏ vào mục riêng đã khôi phục / xoá
    if (isDerivedChange(c) && c.seq >= firstOwnSeq) {
      changes.push(c)
      continue
    }
    const own = isMigrationTxn(c.txn, input.priorId)
    if (!own && (isAnyMigrationTxn(c.txn) || Date.parse(c.at) <= since)) continue
    const owners = sectionsOfPath(input.spine, c.path, { before: c.before, value: c.value }).owner
    const keys = [...new Set(owners.map(resolve).filter((k): k is string => !!k))]
    if (own) {
      // Chỉ giữ lại thay đổi của đổi mẫu ở mục mà mọi chủ đều là mục đã sửa được giữ
      if (keys.length && keys.every((k) => keepKeys.has(k))) continue
      changes.push(c)
    } else if (keys.length && keys.some((k) => discardKeys.has(k)) && !keys.some((k) => keepKeys.has(k))) {
      changes.push(c)
    }
  }
  return { changes, keepKeys }
}

/** Các `old_key` chủ của một đường dẫn Spine — lọc đơn vị dịch theo mục (đổi ngược chỉ dịch mục giữ). */
export const ownerKeysOf = (spine: Spine, path: string, resolve: KeyResolver): string[] =>
  [...new Set(sectionsOfPath(spine, path).owner.map(resolve).filter((k): k is string => !!k))]

/**
 * Mục (theo `section_id`) mà một CR đang mở không được chạm khi áp dụng: mục riêng bị xoá hoặc chuyển đi. CR đang mở trỏ vào mục đã
 * mất thì lúc ghi sẽ mất đích — áp dụng phải dừng, quay về bước phân nhóm.
 */
export const affectedSectionIds = (doc: DecisionView, oldHeadings: readonly OldHeading[], dropped: readonly string[]): Set<string> => {
  const byKey = new Map(oldHeadings.map((h) => [h.key, h]))
  const out = new Set<string>()
  const add = (key: string): void => void (byKey.get(key) && out.add(byKey.get(key)!.section_id))
  for (const e of doc.groups.extra) {
    const choice = choiceOf(doc, e.id)
    if (choice === "delete" || choice === DROP_FROM_PRINT || choice?.startsWith("move_to:")) for (const k of [e.old_key, ...e.follower_keys]) add(k)
  }
  for (const k of dropped) add(k)
  return out
}

/**
 * Đổi ngược: layout lấy từ bản chụp nên heading rỗng (phần nối của mục riêng) của layout cũ không có trong heading của file — đặt lại
 * ngay sau mục cùng `section_id` đứng trước chúng trong layout cũ.
 */
export const withSnapshotContinuations = (entries: readonly PlannedLayoutEntry[], prior: readonly OldHeading[]): PlannedLayoutEntry[] => {
  const after = new Map<string, PlannedLayoutEntry[]>()
  let owner: OldHeading | null = null
  for (const h of prior) {
    if (h.heading_text.trim()) owner = h
    else if (owner) after.set(owner.section_id, [...(after.get(owner.section_id) ?? []), { heading_text: "", level: h.level, section_id: h.section_id, kind: "follower", new_key: null, old_key: h.key, missing: false, guidance: null }])
  }
  const out: PlannedLayoutEntry[] = []
  for (const e of entries) {
    out.push(e)
    const extra = e.kind === "target" ? after.get(e.section_id) : undefined
    if (extra) {
      out.push(...extra)
      after.delete(e.section_id)
    }
  }
  return out
}
