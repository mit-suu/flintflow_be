/**
 * brief-core.ts
 * ─────────────────────────────────────────────────────────────────
 * Tầm nhìn và mục tiêu của Brief là addendum lõi (`topic: "vision"` — 1 entry, `topic: "goals"` — mỗi mục tiêu 1 entry),
 * viết bằng ngôn ngữ của user. `project.vision` / `project.goals[]` (tiếng Anh, render vào SRS §1) chỉ do S-1.1 dựng từ đó.
 *
 * Module này giữ các phép thuần dùng chung cho validator, op engine, bảng cổng và lệnh sửa (`/changes`).
 */

import { isDeepStrictEqual } from "node:util"
import type { Addendum, Spine } from "./spine.types.js"
import type { Op } from "./op.types.js"

export const BRIEF_VISION_TOPIC = "vision"
export const BRIEF_GOALS_TOPIC = "goals"
/** Step dựng `project.vision` / `project.goals[]` tiếng Anh từ addendum lõi. */
export const BRIEF_EXTRACTION_STEP = "S-1.1"

export const isBriefCoreTopic = (topic: unknown): boolean =>
  typeof topic === "string" && [BRIEF_VISION_TOPIC, BRIEF_GOALS_TOPIC].includes(topic.trim().toLowerCase())

/** Cách model hay gọi một mục tiêu kinh doanh — đều là `goals` (FLF-449 D1: `target` làm mục tiêu 20% → 8% rơi khỏi §1). */
const GOALS_TOPIC_ALIASES: ReadonlySet<string> = new Set(["goal", "goals", "target", "targets", "objective", "objectives", "muc tieu"])

/** Chuẩn hoá `topic` của ghi chú Brief: đồng nghĩa của mục tiêu ⇒ `goals` (không phân biệt hoa thường, dấu); topic khác giữ nguyên. */
export const normalizeBriefTopic = (topic: string): string => {
  const key = topic
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
  return GOALS_TOPIC_ALIASES.has(key) ? BRIEF_GOALS_TOPIC : topic
}

const topicOf = (entry: Pick<Addendum, "topic">): string => entry.topic.trim().toLowerCase()

export interface BriefCoreEntries {
  vision: Addendum | null
  goals: Addendum[]
}

export const briefCoreEntries = (spine: Pick<Spine, "addendum">): BriefCoreEntries => {
  // Thứ tự mục tiêu = thứ tự mảng addendum: id do server cấp tăng dần và entry mới luôn nối cuối, nên cũng là thứ tự số của id (FE dùng cùng luật)
  const goals = spine.addendum.filter((a) => topicOf(a) === BRIEF_GOALS_TOPIC)
  return { vision: spine.addendum.find((a) => topicOf(a) === BRIEF_VISION_TOPIC) ?? null, goals }
}

export const hasBriefCore = (spine: Pick<Spine, "addendum">): boolean => {
  const core = briefCoreEntries(spine)
  return core.vision !== null || core.goals.length > 0
}

/** Pha Brief (`B-0`, `B-1`, `B-2`) — hoặc step `B-x.y`. */
export const isBriefPhase = (phaseOrStepId: string | null | undefined): boolean => (phaseOrStepId ?? "").startsWith("B-")

/**
 * Spine đang ở pha Brief: `current_phase` là `B-*`, hoặc project mới chưa chạy step nào (`current_phase` null và chưa step nào
 * accepted). Null mà đã có step accepted (vd import xong hết kế hoạch) không phải Brief.
 */
export const isInBriefPhase = (spine: Pick<Spine, "progress" | "steps">): boolean =>
  spine.progress.current_phase === null ? spine.steps.every((step) => step.status !== "accepted") : isBriefPhase(spine.progress.current_phase)

export const BRIEF_PROJECT_WRITE_MESSAGE =
  "Ở Brief, tầm nhìn/mục tiêu ghi vào addendum topic vision/goals (content ngôn ngữ user + content_en tiếng Anh) - không ghi project.vision/project.goals; S-1.1 sẽ dựng hai field này."

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Op có ĐỔI `project.vision` / `project.goals` so với Spine hiện tại không. `set project` (cả object) bắt buộc mang hai khoá
 * này (schema strict) nên chỉ tính là ghi khi giá trị của chúng khác hiện tại — null / [] giữ nguyên thì qua.
 */
export const writesProjectVisionOrGoals = (op: Pick<Op, "op" | "path" | "value">, spine: Pick<Spine, "project">): boolean => {
  const path = op.path.replace(/\s+/g, "")
  const field = /^project\.(vision|goals)$/.exec(path)?.[1] as "vision" | "goals" | undefined
  if (field) return op.op !== "set" || !isDeepStrictEqual(op.value, spine.project[field])
  if (/^project\.(vision|goals)[.[]/.test(path)) return true
  if (path !== "project" || op.op !== "set" || !isRecord(op.value)) return false
  const value = op.value
  return (["vision", "goals"] as const).some((key) => key in value && !isDeepStrictEqual(value[key], spine.project[key]))
}

const sameCore = (a: readonly Addendum[], b: readonly Addendum[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]
    return x.id === y.id && x.topic === y.topic && x.content === y.content && x.content_en === y.content_en && x.target_section === y.target_section
  })

/** Step của giai đoạn B-2 (rà giả định, phân loại addendum, Approve Brief) — chạy SAU S-1 (FLF-466 P08). */
const isFinalizeStep = (stepId: string | null | undefined): boolean => (stepId ?? "").startsWith("B-2.")
const isInFinalizeBeforeApprove = (spine: Pick<Spine, "progress" | "steps">): boolean =>
  spine.progress.current_phase === "B-2" && spine.steps.find((s) => s.id === "B-2.3")?.status !== "accepted"

/**
 * S-1.1 đã `accepted` mà `addendum[]` đổi trong lô này ⇒ chuyển S-1.1 về `revision_requested` để dựng lại vision/goals.
 * Cùng kiểu `planScreenQueueAppend`: op engine gọi sau cascade, một chốt phủ gate revision, mở lại bước và `/changes`.
 *
 * FLF-466 P08: S-1 chạy TRƯỚC B-2 (business-flow §1.1). Lô do chính B-2.x ghi hoặc sửa qua chat khi còn đang ở B-2 trước
 * lúc Approve Brief (B-2.3 chưa `accepted`) ⇒ KHÔNG mở lại S-1.1 để tránh vòng lặp. Sau khi Approve Brief, sửa Brief từ
 * chat / change flow vẫn mở lại như cũ.
 */
export const planBriefReextract = (after: Spine, before: Spine, byStepId?: string | null): Op[] => {
  if (isFinalizeStep(byStepId) || isInFinalizeBeforeApprove(after)) return []
  const step = after.steps.find((s) => s.id === BRIEF_EXTRACTION_STEP)
  if (step?.status !== "accepted") return []
  if (sameCore(after.addendum, before.addendum)) return []
  return [
    {
      op: "set",
      path: `steps[id=${BRIEF_EXTRACTION_STEP}].status`,
      value: "revision_requested",
      reason: "Brief đổi sau khi đã dựng tầm nhìn/mục tiêu cho SRS"
    }
  ]
}
