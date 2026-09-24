/**
 * Vị trí "sơ đồ gốc" của CR (§4.13, `found_by: diagram`) — đề xuất do **code** tính, không qua AI.
 * Người dùng upload SRS có hình vẽ sẵn (draw.io…): hình giữ y nguyên cho tới khi một CR làm dữ liệu hình thể hiện đổi đi.
 * Lúc đó đề xuất bỏ ảnh gốc khỏi phần nối ⇒ bản render in sơ đồ FlintFlow vẽ từ Spine (PlantUML, vẽ lại ở 3.14). Người duyệt
 * từ chối group đó ⇒ giữ hình gốc, cờ vàng `original_diagram_stale` nhắc hình đã lệch.
 * Tính lại mỗi lần đề xuất / kiểm (C-4, C-5): phụ thuộc đề xuất của các vị trí khác trong cùng CR.
 */

import { planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import { ORIGINAL_DIAGRAM_LABELS, isOriginalStale, originalDiagramOf } from "../spine/original-diagram.js"
import type { CustomSection, Spine } from "../spine/spine.types.js"
import type { IChangeLocation, LocationProposal } from "./change-location.model.js"
import { elementValue, valueText } from "./spine-location.js"

export const isDiagramLocation = (l: Pick<IChangeLocation, "found_by">): boolean => l.found_by.includes("diagram")

export interface RedrawDecision {
  conclusion: "edit" | "not_related"
  reason: string
  proposal: LocationProposal
}

/** Op `edit` của các vị trí khác trong CR — dữ liệu Spine sau CR. Op sai định dạng bị bỏ (C-5 báo ở vị trí của nó). */
const otherEditOps = (locations: readonly Pick<IChangeLocation, "path" | "conclusion" | "proposal" | "found_by">[]): Op[] =>
  locations
    .filter((l) => !isDiagramLocation(l) && l.conclusion === "edit")
    .flatMap((l) => l.proposal?.spine_ops ?? [])
    .flatMap((raw) => {
      const parsed = userOpSchema.safeParse(raw)
      return parsed.success ? [parsed.data] : []
    })

/** Spine sau khi áp đề xuất của CR (chạy khô); op của CR hỏng ⇒ Spine hiện tại (C-5 báo lỗi ở vị trí gây ra). */
const spineAfter = (spine: Spine, ops: Op[]): Spine => {
  if (!ops.length) return spine
  try {
    return planTransaction(spine, { base_version: spine.spine_version, ops, by: "preview" }, { startSeq: 1 }).spine
  } catch {
    return spine
  }
}

/**
 * Kết luận cho một vị trí sơ đồ gốc: hình nào lệch dữ liệu sau CR ⇒ `edit` bỏ đúng khối ảnh đó khỏi phần nối; không hình
 * nào lệch ⇒ `not_related`. Phần nối không còn ⇒ `null` (C-5 báo `element_missing`).
 */
export const redrawDecision = (
  spine: Spine,
  path: string,
  locations: readonly Pick<IChangeLocation, "path" | "conclusion" | "proposal" | "found_by">[]
): RedrawDecision | null => {
  const custom = elementValue(spine, path) as CustomSection | undefined
  if (!custom) return null
  const after = spineAfter(spine, otherEditOps(locations))
  const stale = new Set(custom.blocks.filter((b) => {
    const d = originalDiagramOf(b)
    return !!d && isOriginalStale(after, d)
  }))
  const old_text = valueText(custom)
  if (!stale.size) {
    return {
      conclusion: "not_related",
      reason: "Change request này không đổi dữ liệu mà hình gốc thể hiện — giữ nguyên hình của tài liệu",
      proposal: { old_text, new_text: null, comment_text: null, spine_ops: [], assumptions: [] }
    }
  }
  const labels = [...new Set([...stale].map((b) => ORIGINAL_DIAGRAM_LABELS[originalDiagramOf(b)!.kind]))].join(", ")
  const blocks = custom.blocks.filter((b) => !stale.has(b))
  return {
    conclusion: "edit",
    reason: `${labels} (hình gốc của tài liệu) không còn khớp dữ liệu sau change request này ⇒ thay bằng sơ đồ FlintFlow vẽ lại từ dữ liệu mới. Không đồng ý ⇒ giữ hình gốc, tài liệu có cờ vàng "Hình gốc lệch dữ liệu".`,
    proposal: {
      old_text,
      new_text: valueText({ ...custom, blocks }),
      comment_text: null,
      // Bỏ từng khối ảnh theo khoá `image_ref` (op engine không cho `set` cả mảng object)
      spine_ops: [...stale].map((b) => ({ op: "remove", path: `${path}.blocks[image_ref=${b.image_ref}]`, reason: `Vẽ lại ${labels} bằng FlintFlow` })),
      assumptions: []
    }
  }
}

/**
 * Ghi kết luận cho mọi vị trí sơ đồ gốc của CR (bỏ qua vị trí người dùng đã tự quyết — `manual`). Gọi sau khi các vị trí
 * khác đã có đề xuất (cuối C-4) và trước khi kiểm (C-5), vì hình lệch hay không tuỳ vào chúng.
 */
export const refreshDiagramLocations = async (spine: Spine, locations: IChangeLocation[]): Promise<void> => {
  for (const loc of locations) {
    if (!isDiagramLocation(loc) || loc.manual) continue
    const decision = redrawDecision(spine, loc.path, locations)
    if (!decision) continue
    const same = loc.conclusion === decision.conclusion && loc.proposal?.new_text === decision.proposal.new_text && loc.proposal?.old_text === decision.proposal.old_text
    if (same) continue
    loc.conclusion = decision.conclusion
    loc.reason = decision.reason
    loc.proposal = decision.proposal
    loc.verify = null
    await loc.save()
  }
}
