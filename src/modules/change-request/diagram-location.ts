/**
 * Vị trí "sơ đồ gốc" của CR (§4.13, `found_by: diagram`) — đề xuất do **code** tính, không qua AI.
 * Người dùng upload SRS có hình vẽ sẵn (draw.io…): hình giữ y nguyên cho tới khi một CR làm dữ liệu hình thể hiện đổi đi.
 * Lúc đó đề xuất bỏ ảnh gốc khỏi phần nối ⇒ bản render in sơ đồ FlintFlow vẽ từ Spine (PlantUML, vẽ lại ở 3.14). Người duyệt
 * từ chối group đó ⇒ giữ hình gốc, cờ vàng `original_diagram_stale` nhắc hình đã lệch.
 * Tính lại mỗi lần đề xuất / kiểm (C-4, C-5): phụ thuộc đề xuất của các vị trí khác trong cùng CR.
 */

import { planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import { ORIGINAL_DIAGRAM_LABELS, isOriginalStale, originalDiagramHash, originalDiagramOf } from "../spine/original-diagram.js"
import type { CustomBlock, CustomSection, Spine } from "../spine/spine.types.js"
import type { IChangeLocation, LocationProposal } from "./change-location.model.js"
import { elementValue, valueText } from "./spine-location.js"

/** Dòng chú thích hình: "H2 · …", "Hình 2 …", "Figure 2 …", "Fig. 3 …" (đoạn ngắn, không phải văn xuôi). */
export const isFigureCaption = (b: CustomBlock): boolean =>
  b.kind === "paragraph" && b.text.trim().length <= 200 && /^(h\d+\b|hình\s*\d+|figure\s*\d+|fig\.?\s*\d+)/i.test(b.text.trim())

export const isDiagramLocation = (l: Pick<IChangeLocation, "found_by">): boolean => l.found_by.includes("diagram")

export interface RedrawDecision {
  conclusion: "edit" | "not_related"
  reason: string
  proposal: LocationProposal
}

/**
 * Op `edit` của các vị trí khác trong CR, gom theo vị trí — dữ liệu Spine sau CR. Op sai định dạng bị bỏ (C-5 báo ở vị
 * trí của nó).
 */
const otherEditOps = (locations: readonly Pick<IChangeLocation, "path" | "conclusion" | "proposal" | "found_by">[]): Op[][] =>
  locations
    .filter((l) => !isDiagramLocation(l) && l.conclusion === "edit")
    .map((l) =>
      (l.proposal?.spine_ops ?? []).flatMap((raw) => {
        const parsed = userOpSchema.safeParse(raw)
        return parsed.success ? [parsed.data] : []
      })
    )
    .filter((ops) => ops.length > 0)

const tryApply = (spine: Spine, ops: Op[]): Spine | null => {
  try {
    return planTransaction(spine, { base_version: spine.spine_version, ops, by: "preview" }, { startSeq: 1 }).spine
  } catch {
    return null
  }
}

/**
 * Spine sau khi áp đề xuất của CR (chạy khô). Áp cả CR một lần trước (các op phụ thuộc nhau — xoá use case cùng chức
 * năng của nó — chỉ hợp lệ khi đi cùng nhau); hỏng ⇒ áp **từng vị trí**, vị trí hỏng thì bỏ riêng nó (C-5 báo ở vị trí
 * gây ra). FLF-375: trước đây một op hỏng làm cả CR coi như không đổi gì ⇒ sơ đồ gốc kết luận nhầm "giữ nguyên".
 */
const spineAfter = (spine: Spine, groups: Op[][]): Spine => {
  if (!groups.length) return spine
  const whole = tryApply(spine, groups.flat())
  if (whole) return whole
  let current = spine
  for (const ops of groups) current = tryApply(current, ops) ?? current
  return current
}

/** Spine sau đề xuất của các vị trí (không kể vị trí sơ đồ gốc) trong CR — chạy khô, dùng chung cho kết luận và hình xem trước. */
export const spineAfterCr = (spine: Spine, locations: readonly Pick<IChangeLocation, "path" | "conclusion" | "proposal" | "found_by">[]): Spine =>
  spineAfter(spine, otherEditOps(locations))

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
  const after = spineAfterCr(spine, locations)
  const stale = new Set(custom.blocks.filter((b) => {
    const d = originalDiagramOf(b)
    return !!d && isOriginalStale(after, d)
  }))
  const old_text = valueText(custom)
  if (!stale.size) {
    return {
      conclusion: "not_related",
      reason: "Change request này không đổi dữ liệu mà hình gốc thể hiện - giữ nguyên hình của tài liệu",
      proposal: { old_text, new_text: null, comment_text: null, spine_ops: [], assumptions: [] }
    }
  }
  const labels = [...new Set([...stale].map((b) => ORIGINAL_DIAGRAM_LABELS[originalDiagramOf(b)!.kind]))].join(", ")
  // FLF-375 (B12): chú thích ngay sau ảnh ("H2 · sơ đồ use case tổng quát: 5 tác nhân, 10 use case") mô tả HÌNH CŨ — thay
  // hình mà giữ chú thích thì tài liệu tự mâu thuẫn (AI kiểm hỏi lại mãi). Bỏ chú thích cùng ảnh; hình vẽ lại có tiêu đề riêng.
  const captions = new Set(custom.blocks.filter((b, i) => i > 0 && stale.has(custom.blocks[i - 1]) && isFigureCaption(b)))
  // Bug #16 (QLHS 11/11): giữ CHỖ của ảnh gốc (khối ảnh không file, còn `diagram`) ⇒ hình vẽ lại in đúng chỗ đó; trước đây xoá
  // hẳn ảnh nên hình mới chạy về mục mặc định của loại sơ đồ (activity ⇒ 2.3) hoặc không in (ngữ cảnh ở mục không có đoạn ghi)
  const blocks = custom.blocks
    .filter((b) => !captions.has(b))
    .map((b): CustomBlock => (stale.has(b) ? { kind: "image", text: "", rows: null, image_ref: null, diagram: b.diagram } : b))
  return {
    conclusion: "edit",
    reason: `${labels} (hình gốc của tài liệu) không còn khớp dữ liệu sau change request này ⇒ thay bằng sơ đồ FlintFlow vẽ lại từ dữ liệu mới. Không đồng ý ⇒ giữ hình gốc, tài liệu có cờ vàng "Hình gốc lệch dữ liệu".`,
    proposal: {
      old_text,
      new_text: valueText({ ...custom, blocks }),
      comment_text: null,
      // Bỏ từng khối ảnh theo khoá `image_ref` (op engine không cho `set` cả mảng object)
      // Cả mảng khối (khối văn bản không có id — op `set` được sau FLF-375): bỏ ảnh lệch + chú thích của nó
      spine_ops: [{ op: "set", path: `${path}.blocks`, value: blocks, reason: `Vẽ lại ${labels} bằng FlintFlow` }],
      assumptions: []
    }
  }
}

/**
 * C-3: vị trí sơ đồ gốc chỉ là ứng viên theo mảng dữ liệu (CR chạm bất kỳ use case nào ⇒ cả sơ đồ ngữ cảnh, use case, luồng
 * màn). CR mang sẵn op (bản xem trước / lô đã duyệt) ⇒ biết trước dữ liệu sau CR: bỏ ngay ứng viên chỉ-sơ-đồ mà không hình
 * nào của nó đổi hash, người dùng không phải xem và bấm từng hình không liên quan. Op không áp được ⇒ giữ nguyên danh sách
 * (C-4 vẫn so hash như cũ). Vị trí đã được tìm theo đường khác (`found_by` có thêm nguồn) luôn giữ.
 */
export const narrowDiagramCandidates = <T extends Pick<IChangeLocation, "path" | "found_by">>(spine: Spine, found: readonly T[], seedOps: readonly unknown[] | undefined): T[] => {
  const ops = (seedOps ?? []).flatMap((raw) => {
    const parsed = userOpSchema.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  })
  if (!ops.length) return [...found]
  const after = tryApply(spine, ops)
  if (!after) return [...found]
  return found.filter((f) => {
    if (!(f.found_by.length === 1 && isDiagramLocation(f))) return true
    const custom = elementValue(spine, f.path) as CustomSection | undefined
    if (!custom) return true
    return custom.blocks.some((b) => {
      const d = originalDiagramOf(b)
      return !!d && isOriginalStale(after, d)
    })
  })
}

/**
 * "Giữ hình gốc" (người dùng tự chọn `not_related` ở vị trí sơ đồ gốc) — lúc ghi CR: hình được người dùng xác nhận là vẫn
 * dùng được cho dữ liệu SAU CR ⇒ đóng dấu `source_hash` của khối ảnh theo dữ liệu đó (ảnh, chú thích giữ nguyên). Không có
 * bước này thì cờ vàng `original_diagram_stale` bật ngay sau khi ghi và mời tạo CR vẽ lại đúng hình vừa chọn giữ; có bước này
 * thì cờ chỉ bật lại khi dữ liệu đổi tiếp. `spine` = Spine sau CR (chạy khô).
 */
export const keptOriginalAckOps = (spine: Spine, locations: readonly Pick<IChangeLocation, "path" | "conclusion" | "manual" | "found_by">[]): Op[] =>
  locations
    .filter((l) => isDiagramLocation(l) && l.manual && l.conclusion === "not_related")
    .flatMap((l): Op[] => {
      const custom = elementValue(spine, l.path) as CustomSection | undefined
      if (!custom) return []
      let changed = false
      const blocks = custom.blocks.map((b): CustomBlock => {
        const d = originalDiagramOf(b)
        if (!d || !isOriginalStale(spine, d)) return b
        changed = true
        return { ...b, diagram: { ...d, source_hash: originalDiagramHash(spine, d.kind, d.owner_id ?? null) } }
      })
      return changed ? [{ op: "set", path: `${l.path}.blocks`, value: blocks, reason: "Giữ hình gốc của tài liệu theo quyết định của người duyệt" }] : []
    })

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
