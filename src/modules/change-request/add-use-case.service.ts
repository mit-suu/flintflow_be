/**
 * FLF-318: CR thêm use case kéo theo đủ phần liên quan như chat trước baseline (FLF-311) — chức năng (normal / abnormal /
 * validations), màn, `flow_to`, phân quyền, thông báo. Không viết logic kéo theo thứ hai: lô do `draftUseCaseOps`
 * (cùng prompt + `normalizeUseCaseBatch` của FLF-311, `useCaseMode` luôn `full` sau baseline) soạn trong MỘT lượt.
 *
 * C-4 đề xuất theo từng vị trí (lô 4 vị trí / lượt) nên không soạn được một use case trọn vẹn: màn ↔ chức năng trỏ id tạm
 * của nhau qua các lượt gọi khác nhau. Ở đây:
 * 1. chạy khô lô để có **id thật** (id tạm `$newFn1` ⇒ `FN045`) — bất biến chỉ kiểm ở cuối lô ghi nên thứ tự giữa các
 *    vị trí không còn quan trọng;
 * 2. chia op về vị trí: op thêm / sửa phần tử MỚI ⇒ ô "thêm mới" của mảng (`functions[]`, `screens[]`, `permissions[]`…);
 *    op sửa phần tử có sẵn (nối `flow_to` từ màn cũ) ⇒ vị trí của phần tử đó. Thiếu vị trí ⇒ tạo + khoá;
 * 3. mỗi vị trí mang `new_text` = phần tử sau cả lô ⇒ người duyệt thấy đủ §2.2.x, Functional Requirements, §3.1.1–3.1.3.
 * Lô không soạn được (model vẫn hỏi, lô sai, khoá trùng) ⇒ trả `skipped`, C-4 đề xuất theo vị trí như cũ.
 *
 * CR **xoá** use case đi cùng đường này (luật 3g, như chat trước baseline): lô xoá use case kèm chức năng, màn, thông báo
 * chỉ thuộc nó; mỗi op về vị trí của phần tử bị xoá (thiếu ⇒ tạo + khoá). Use case cùng luồng đã được hỏi ở C-2
 * (`cr-clarify` luật 10) — câu trả lời nằm trong lệnh gửi model.
 */

import { withMeteredAi, type MeteredResult } from "../import/metered-ai.js"
import { ownerStepOf } from "../spine/section-registry.js"
import { draftUseCaseOps, type ChangeExecutor, type ResolvedOps } from "../spine/change.service.js"
import { TransactionRejectedError, planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { useCaseIntent } from "../spine/use-case-propagation.js"
import type { ChangeInstructionOutput } from "../../shared/ai/response-parser.js"
import type { AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { ChangeLocation, type IChangeLocation } from "./change-location.model.js"
import { formatLocationId } from "./cr-impact.service.js"
import { answersText } from "./cr-context.js"
import { lockPaths } from "./lock.service.js"
import { SECTION_FILL_ARRAYS, addedElements, elementPathOf, elementValue, isArrayPath, sectionOfElement, snapshotOf, valueText } from "./spine-location.js"

/** Lý do của vị trí do lô thêm / xoá use case soạn — nhận ra để không soạn lại ở vòng đề xuất sau. */
export const ADD_USE_CASE_REASON = "Thêm use case kèm chức năng, màn, luồng màn và phân quyền liên quan"
export const REMOVE_USE_CASE_REASON = "Xoá use case kèm chức năng, màn và thông báo chỉ thuộc nó"
const BUNDLE_REASONS = new Set([ADD_USE_CASE_REASON, REMOVE_USE_CASE_REASON])

/** Chữ người yêu cầu viết (tiêu đề, mô tả, lệnh gộp thêm, câu trả lời làm rõ). */
const requesterText = (cr: Pick<IChangeRequest, "title" | "description" | "amendments" | "clarifications">): string =>
  [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text), ...cr.clarifications.flatMap((c) => c.answers)].join("\n")

type CrText = Pick<IChangeRequest, "title" | "description" | "amendments" | "clarifications">

/** CR thêm hay xoá use case (động từ đứng trước thắng — như chat); không đụng use case ⇒ `null`. */
export const crUseCaseIntent = (cr: CrText): "add" | "remove" | null => useCaseIntent(requesterText(cr))

export const crAddsUseCase = (cr: CrText): boolean => crUseCaseIntent(cr) === "add"

type Rec = Record<string, unknown>
const rootOf = (path: string): string | null => /^(\w+)\[/.exec(path)?.[1] ?? null

const idsOf = (spine: Spine, collection: string): Set<string> => {
  const list = (spine as unknown as Rec)[collection]
  return new Set(Array.isArray(list) ? list.flatMap((el) => (el && typeof el === "object" && typeof (el as Rec).id === "string" ? [(el as Rec).id as string] : [])) : [])
}

/** Lô sau khi chạy khô: op mang id thật (đúng thứ tự, không gồm op cascade) + Spine sau lô. Lô sai ⇒ `null`. */
export const concreteBatch = (spine: Spine, ops: readonly Op[]): { ops: Op[]; after: Spine } | null => {
  try {
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops: [...ops], by: "cr-add-use-case" }, { startSeq: 1 })
    return { ops: plan.ops.slice(0, ops.length), after: plan.spine }
  } catch (err) {
    if (err instanceof TransactionRejectedError) return null
    throw err
  }
}

export interface BundleLocation {
  path: string
  section_id: string
  ops: Op[]
  /** Phần tử MỚI mà op `set`/`add` con chạm tới (`functions[id=FN045].validations[]`) — C-5 đòi CR giữ khoá. */
  new_elements: string[]
}

/** Section hiển thị ô "thêm mới" của mảng — chức năng mới đi theo mục Functional Requirements của feature. */
const slotSection = (root: string, after: Spine, ops: readonly Op[]): string => {
  if (root === "use_cases") return "fixed:2.2.2"
  if (root === "functions") {
    const added = ops.find((op) => op.op === "add" && op.path === "functions[]")?.value as Rec | undefined
    const feature = typeof added?.feature_id === "string" ? added.feature_id : null
    return feature && idsOf(after, "features").has(feature) ? `feature:${feature}` : "fixed:3.1.4"
  }
  return Object.entries(SECTION_FILL_ARRAYS).find(([, arrays]) => arrays.includes(root))?.[0] ?? "misc"
}

/** Chia lô (đã có id thật) về vị trí; giữ thứ tự op trong từng vị trí. */
export const distributeOps = (spine: Spine, after: Spine, ops: readonly Op[]): BundleLocation[] => {
  const out = new Map<string, BundleLocation>()
  const fresh = new Map<string, Set<string>>()
  const isNew = (root: string, element: string): boolean => {
    if (!fresh.has(root)) {
      const before = idsOf(spine, root)
      fresh.set(root, new Set([...idsOf(after, root)].filter((id) => !before.has(id))))
    }
    const id = /\[id=([^\]]+)\]/.exec(element)?.[1]
    return !!id && fresh.get(root)!.has(id)
  }
  for (const op of ops) {
    const root = rootOf(op.path)
    const element = elementPathOf(op.path)
    const toSlot = !!root && (op.path === `${root}[]` || (!!element && element !== "project" && isNew(root, element)))
    const key = toSlot ? `${root}[]` : (element ?? op.path)
    const loc = out.get(key) ?? { path: key, section_id: "", ops: [], new_elements: [] }
    loc.ops.push(op)
    if (toSlot && element && op.path !== `${root}[]` && !loc.new_elements.includes(element)) loc.new_elements.push(element)
    out.set(key, loc)
  }
  for (const loc of out.values()) {
    loc.section_id = isArrayPath(loc.path) ? slotSection(rootOf(loc.path)!, after, loc.ops) : sectionOfElement(spine, loc.path)
  }
  return [...out.values()]
}

/** Giá trị người duyệt đọc: ô "thêm mới" ⇒ các phần tử được thêm; phần tử ⇒ giá trị sau cả lô. */
export const bundleNewText = (spine: Spine, after: Spine, path: string): string =>
  isArrayPath(path) ? valueText(addedElements(elementValue(spine, path), elementValue(after, path))) : valueText(elementValue(after, path))

class MeteredCallFailed extends Error {
  constructor(readonly result: Extract<MeteredResult<unknown>, { ok: false }>) {
    super(result.message)
  }
}

/** Lượt gọi model của lô đi qua công tơ của CR (giữ credit theo bước `C-4:<cr>`), như các lượt C-4 khác. */
const meteredExecutor =
  (projectId: string, userId: string, stepId: string): ChangeExecutor =>
  async (actionType, input) => {
    const result = await withMeteredAi<ChangeInstructionOutput>({ projectId, userId, stepId }, actionType, input.promptVariables ?? {})
    if (!result.ok) throw new MeteredCallFailed(result)
    return { data: result.data } as AiActionResult<ChangeInstructionOutput>
  }

export type UseCaseBatchOutcome = "done" | "skipped" | "paused"

/**
 * Soạn lô thêm / xoá use case cho CR rồi gắn vào vị trí (tạo + khoá vị trí còn thiếu). Chỉ chạy một lần mỗi CR: vòng đề
 * xuất lại (sau kiểm trượt) đi theo từng vị trí như cũ. Hết credit ⇒ `paused` (caller dừng CR như C-4).
 */
export const proposeUseCaseBatch = async (
  cr: IChangeRequest,
  userId: string,
  spine: Spine,
  locations: readonly IChangeLocation[],
  deps: { changeExecutor?: ChangeExecutor } = {}
): Promise<UseCaseBatchOutcome> => {
  const intent = crUseCaseIntent(cr)
  if (!intent || locations.some((l) => l.reason !== null && BUNDLE_REASONS.has(l.reason))) return "skipped"
  const answers = answersText(cr)
  const instruction = [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text), answers && answers !== "(none)" ? answers : ""].filter(Boolean).join("\n")

  // Bản xem trước người dùng đã duyệt trong chat (vòng hỏi đáp như trước baseline: màn riêng / popup, ai xử lý, giữ / bỏ
  // use case đề xuất, xoá cả luồng) ⇒ dùng đúng lô đó, không soạn lại. Lô không còn áp được (tài liệu đã đổi) ⇒ soạn lại.
  const seeded = cr.amendments?.length ? null : seedBatch(spine, cr)
  const outcome = seeded ? { drafted: { ops: [], clarification: null, notes: null } as ResolvedOps, batch: seeded } : await draftBatch(cr, userId, spine, instruction, intent, deps)
  if (outcome === "paused" || outcome === "skipped") return outcome
  const { drafted, batch } = outcome
  return attachBatch(cr, spine, locations, intent, drafted, batch)
}

/** Lô của bản xem trước đính kèm CR (`seed.ops`, đã chuẩn hoá ở bước xem trước) sau khi chạy khô; không có / sai ⇒ `null`. */
export const seedBatch = (spine: Spine, cr: Pick<IChangeRequest, "seed">): { ops: Op[]; after: Spine } | null => {
  const raw = cr.seed?.ops ?? []
  if (!raw.length) return null
  const ops: Op[] = []
  for (const op of raw) {
    const parsed = userOpSchema.safeParse(op)
    if (!parsed.success) return null
    ops.push(parsed.data)
  }
  return concreteBatch(spine, ops)
}

/** Model soạn lô thêm / xoá use case (luật 3e / 3g) từ lệnh của CR + câu trả lời làm rõ. */
const draftBatch = async (
  cr: IChangeRequest,
  userId: string,
  spine: Spine,
  instruction: string,
  intent: "add" | "remove",
  deps: { changeExecutor?: ChangeExecutor }
): Promise<{ drafted: ResolvedOps; batch: { ops: Op[]; after: Spine } } | "paused" | "skipped"> => {
  const projectId = String(cr.projectId)
  let drafted: ResolvedOps
  try {
    drafted = await draftUseCaseOps(projectId, userId, spine, instruction, {
      changeExecutor: deps.changeExecutor ?? meteredExecutor(projectId, userId, `C-4:${cr.cr_id}`),
      // Chữ CR ghi vào Spine là tiếng Anh như mọi lượt C-4 — không xin bản dịch kèm lô
      documentLanguage: async () => null
    })
  } catch (err) {
    if (!(err instanceof MeteredCallFailed)) throw err
    if (err.result.reason === "credits") {
      cr.paused = { reason: "credits", at: new Date() }
      await cr.save()
      return "paused"
    }
    console.warn(`[C-4] ${cr.cr_id}: soạn lô ${intent === "add" ? "thêm" : "xoá"} use case lỗi (${err.message}) — đề xuất theo từng vị trí`)
    return "skipped"
  }
  if (drafted.clarification || !drafted.ops.length) return "skipped"
  const batch = concreteBatch(spine, drafted.ops)
  if (!batch) {
    console.warn(`[C-4] ${cr.cr_id}: lô ${intent === "add" ? "thêm" : "xoá"} use case không áp thử được — đề xuất theo từng vị trí`)
    return "skipped"
  }
  return { drafted, batch }
}

/** Chia lô về vị trí (tạo + khoá vị trí còn thiếu), ghi đề xuất của từng vị trí. */
const attachBatch = async (
  cr: IChangeRequest,
  spine: Spine,
  locations: readonly IChangeLocation[],
  intent: "add" | "remove",
  drafted: ResolvedOps,
  batch: { ops: Op[]; after: Spine }
): Promise<UseCaseBatchOutcome> => {
  const bundle = distributeOps(spine, batch.after, batch.ops)
  const byPath = new Map(locations.map((l) => [l.path, l]))
  const missing = bundle.filter((b) => !byPath.has(b.path))
  try {
    await lockPaths(cr.projectId, cr.cr_id, [...missing.map((b) => b.path), ...bundle.flatMap((b) => b.new_elements)])
  } catch (err) {
    console.warn(`[C-4] ${cr.cr_id}: không giữ được khoá cho lô use case — đề xuất theo từng vị trí`, err)
    return "skipped"
  }
  let next = locations.reduce((n, l) => Math.max(n, Number(l.location_id.slice(1)) || 0), 0)
  for (const b of missing) {
    const created = await ChangeLocation.create({
      projectId: cr.projectId,
      cr_id: cr.cr_id,
      location_id: formatLocationId(++next),
      path: b.path,
      section_id: b.section_id,
      found_by: ["spine_link"],
      entity_paths: [b.section_id],
      vector_score: null,
      owner_step: b.section_id.startsWith("custom:") || b.section_id === "misc" ? null : ownerStepOf(b.section_id, spine)
    })
    byPath.set(b.path, created)
  }
  // Ghi chú của lô (phần còn thiếu FLF-298 / phần còn sót khi xoá) và use case AI tự đề xuất thêm (luật 3e — chat trước
  // baseline hỏi giữ / bỏ, CR không có lượt hỏi đó) ⇒ giả định của vị trí use case để Lead xác nhận khi duyệt
  const notes = [
    ...(drafted.notes?.trim() ? [drafted.notes.trim()] : []),
    ...(drafted.proposed ?? []).map((name) => `AI đề xuất thêm use case "${name}" để luồng có người xử lý / theo dõi — bỏ nếu không cần`)
  ]
  const noteHolder = bundle.find((b) => b.path === "use_cases[]") ?? bundle.find((b) => b.path.startsWith("use_cases[id="))
  for (const b of bundle) {
    const loc = byPath.get(b.path)!
    loc.conclusion = "edit"
    loc.reason = intent === "add" ? ADD_USE_CASE_REASON : REMOVE_USE_CASE_REASON
    loc.proposal = {
      ...snapshotOf(spine, b.path),
      new_text: bundleNewText(spine, batch.after, b.path),
      comment_text: null,
      spine_ops: b.ops,
      assumptions: b === noteHolder ? notes : []
    }
    loc.verify = null
    loc.markModified("proposal")
    await loc.save()
  }
  return "done"
}
