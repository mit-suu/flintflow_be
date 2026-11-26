/**
 * Hoàn tác một CR đã ghi = một CR mới (BF §3.2, hoàn tác qua chat): vị trí dựng từ các `Change` của CR gốc (giá trị `before`),
 * CR mới nguồn `revert` (`source.ref` = mã CR gốc) rồi đi C-5 (kiểm) → xác nhận (C-6) như CR thường — không có đường ghi riêng.
 * Phần bị CR sau đó sửa tiếp thì đề xuất không còn khớp nội dung hiện tại ⇒ kiểm C-5 / xác nhận dùng đúng luật "hai người
 * sửa cùng lúc" (`concurrent-edit.ts`), không ghi đè im lặng. Hoàn tác không tự lan sang CR phụ thuộc: chỗ phụ thuộc ra lỗi ở
 * kiểm C-6 / cờ khi recompute.
 */

import { ApiError } from "../../shared/utils/api-error.js"
import { assertPackageNotPending } from "../doc-version/review-package.service.js"
import { stripRecord } from "../import/check.service.js"
import { Change as ChangeModel } from "../spine/change.model.js"
import { isAbsent } from "../spine/op.types.js"
import { ownerStepOf } from "../spine/section-registry.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { LocationProposal } from "./change-location.model.js"
import { ChangeLocation } from "./change-location.model.js"
import { CR_ID_PATTERN } from "./change-request.constants.js"
import type { IChangeRequest } from "./change-request.model.js"
import { createCr, requireCr, transitionCr } from "./change-request.service.js"
import { PROJECT_PATH, SECTION_FILL_ARRAYS, elementPathOf, elementValue, sectionOfElement, snapshotOf, type FoundLocation } from "./spine-location.js"
import { previewAfter } from "./propose.service.js"
import { runVerify } from "./verify.service.js"

/** "hoàn tác CR-014" / "revert CR-014" trong tin nhắn ⇒ mã CR; không có ý hoàn tác ⇒ `null`. */
export const parseRevertIntent = (text: string): string | null => {
  const m = /(?:ho[aà]n\s*t[aá]c|undo|revert|roll\s*back)\s+(?:l[aạ]i\s+)?(?:change request\s+|cr\s*)?-?\s*0*(\d{1,6})\b/i.exec(text.normalize("NFC"))
  if (!m) return null
  const id = `CR-${m[1].padStart(3, "0")}`
  return CR_ID_PATTERN.test(id) ? id : null
}

/** Một dòng `Change` của CR gốc — chỉ phần cần để dựng nghịch đảo. */
export interface SourceChange {
  seq: number
  op: string
  path: string
  before: unknown
  value: unknown
}

type Row = Record<string, unknown>

interface Group {
  /** Path của vị trí: phần tử, hoặc `arr[]` khi phải thêm lại phần tử bị CR xoá. */
  path: string
  /** Op nghịch đảo, theo thứ tự ngược seq (thay đổi sau hoàn tác trước). */
  inverse: Row[]
  /** Op "như CR đã ghi" (giá trị `value`), theo thứ tự seq — dựng lại nội dung phần tử ngay sau CR để so với hiện tại. */
  written: Row[]
  kind: "add" | "set" | "remove"
}

const ARRAY_OF = /^(\w+)\[/

/** Gom các Change của CR gốc theo vị trí và dựng op nghịch đảo. `revert` / `renumber` / path ngoài phần tử Spine bị bỏ. */
const groupChanges = (changes: readonly SourceChange[]): Group[] => {
  const groups = new Map<string, Group>()
  const at = (path: string, kind: Group["kind"]): Group => {
    const cur = groups.get(path) ?? { path, inverse: [], written: [], kind }
    groups.set(path, cur)
    return cur
  }
  for (const c of [...changes].sort((a, b) => a.seq - b.seq)) {
    if (c.op !== "set" && c.op !== "add" && c.op !== "remove") continue
    const element = elementPathOf(c.path)
    if (!element) continue
    const wholeElement = element === c.path
    if (wholeElement && isAbsent(c.before) && !isAbsent(c.value)) {
      // CR đã thêm phần tử ⇒ xoá
      at(element, "remove").inverse.unshift({ op: "remove", path: c.path })
    } else if (wholeElement && isAbsent(c.value) && !isAbsent(c.before)) {
      // CR đã xoá phần tử ⇒ thêm lại nguyên bản vào đúng mảng
      const array = ARRAY_OF.exec(c.path)?.[1]
      if (!array) continue
      at(`${array}[]`, "add").inverse.unshift({ op: "add", path: `${array}[]`, value: c.before })
    } else {
      const group = at(element, "set")
      group.inverse.unshift(isAbsent(c.before) ? { op: "remove", path: c.path } : { op: "set", path: c.path, value: c.before })
      group.written.push(isAbsent(c.value) ? { op: "remove", path: c.path } : { op: "set", path: c.path, value: c.value })
    }
  }
  // Thêm lại phần tử trước, rồi sửa field, xoá phần tử sau cùng (phần tử khác có thể tham chiếu tới nhau)
  const rank = { add: 0, set: 1, remove: 2 } as const
  return [...groups.values()].sort((a, b) => rank[a.kind] - rank[b.kind])
}

/** Mục hiển thị ô "thêm lại" `arr[]`: mục đầu tiên của bảng điền mảng đó; không có ⇒ `misc`. */
const sectionOfSlot = (path: string): string => {
  const array = path.slice(0, -2)
  return Object.entries(SECTION_FILL_ARRAYS).find(([, arrays]) => arrays.includes(array))?.[0] ?? "misc"
}

export interface RevertLocation extends FoundLocation {
  reason: string
  proposal: LocationProposal
}

/**
 * Dựng vị trí hoàn tác từ Change của CR gốc, trên Spine hiện tại. Nhóm không áp được (phần tử đã bị xoá về sau, op không còn
 * chạy khô được) vào `skipped` để báo người dùng, không tự bịa.
 */
export const buildRevertLocations = (spine: Spine, sourceCrId: string, changes: readonly SourceChange[]): { locations: RevertLocation[]; skipped: string[] } => {
  const locations: RevertLocation[] = []
  const skipped: string[] = []
  for (const group of groupChanges(changes)) {
    const slot = group.kind === "add"
    if (!slot && elementValue(spine, group.path) === undefined) {
      skipped.push(group.path)
      continue
    }
    const after = previewAfter(spine, group.path, group.inverse)
    if (after === null) {
      skipped.push(group.path)
      continue
    }
    // Nội dung phần tử ngay sau CR gốc (hiện tại + các giá trị CR đã ghi): đổi so với hiện tại ⇒ có người sửa tiếp sau CR
    const current = snapshotOf(spine, group.path)
    const justAfterCr = !slot && group.written.length ? previewAfter(spine, group.path, group.written) : null
    const section_id = slot ? sectionOfSlot(group.path) : sectionOfElement(spine, group.path)
    locations.push({
      path: group.path,
      section_id,
      found_by: ["spine_link"],
      entity_paths: [group.path],
      owner_step: section_id.startsWith("custom:") || section_id === "misc" ? null : ownerStepOf(section_id, spine),
      reason: `Hoàn tác ${sourceCrId}`,
      proposal: {
        ...current,
        old_text: justAfterCr ?? current.old_text,
        new_text: after,
        comment_text: null,
        spine_ops: group.inverse,
        assumptions: [],
        proposed_at: new Date()
      }
    })
  }
  return { locations, skipped }
}

/**
 * `POST …/change-requests/:crId/revert`: tạo CR hoàn tác của một CR đã ghi, rồi chạy kiểm C-5. Người tạo chỉ được một CR mở
 * một lúc; gói chờ Lead khoá bản nháp như mọi CR.
 */
export const createRevertCr = async (projectId: string, userId: string, sourceCrId: string, requester: string): Promise<IChangeRequest> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  assertPackageNotPending(record.baseline_submission)
  const source = await requireCr(projectId, sourceCrId)
  if (source.status !== "written" && source.status !== "released") {
    throw new ApiError(409, `${source.cr_id} chưa ghi vào tài liệu nên không có gì để hoàn tác.`, "CR_REVERT_NOT_WRITTEN", { cr_id: source.cr_id, status: source.status })
  }
  const spine = stripRecord(record)
  const changes = (await ChangeModel.find({ projectId, by: source.cr_id }).sort({ seq: 1 }).lean()) as unknown as SourceChange[]
  const { locations, skipped } = buildRevertLocations(spine, source.cr_id, changes)
  if (!locations.length) {
    throw new ApiError(409, `${source.cr_id} không có thay đổi nào hoàn tác được (chỉ ghi chú, hoặc phần đã đổi không còn trong tài liệu).`, "CR_REVERT_NOTHING", { cr_id: source.cr_id, skipped })
  }

  const cr = await createCr(projectId, userId, {
    title: `Hoàn tác ${source.cr_id}: ${source.title}`.slice(0, 200),
    description: `Hoàn tác thay đổi của ${source.cr_id} ("${source.title}"), đưa các chỗ đã đổi về nội dung trước đó.`,
    source: { kind: "revert", ref: source.cr_id, note: null },
    requester
  }, { enforceOwnOpen: true })
  await ChangeLocation.insertMany(
    locations.map((l, i) => ({
      projectId: cr.projectId,
      cr_id: cr.cr_id,
      location_id: `L${String(i + 1).padStart(3, "0")}`,
      path: l.path,
      section_id: l.section_id,
      found_by: l.found_by,
      entity_paths: l.entity_paths,
      owner_step: l.owner_step,
      conclusion: "edit",
      reason: l.reason,
      proposal: l.proposal
    }))
  )
  cr.targets = { entity_paths: locations.map((l) => l.path).filter((p) => p !== PROJECT_PATH), keywords: [] }
  cr.markModified("targets")
  // Vị trí đã có đề xuất (nghịch đảo của Change) ⇒ bỏ qua làm rõ / tìm vị trí / soạn, vào kiểm C-5
  for (const step of ["clarifying", "impact_review", "proposing"] as const) await transitionCr(cr, step)
  await runVerify(cr, userId)
  return cr
}
