/**
 * step-registry.ts
 * ─────────────────────────────────────────────────────────────────
 * Nguồn sự thật về step (Phases §6.4), dùng chung BE/FE — HỢP ĐỒNG ĐÓNG BĂNG tại M2.
 * Dữ liệu: `assets/step-registry.json` (FE copy bằng `npm run sync:registry`).
 *
 *   13 step Brief + 38 step SRS cố định + 5 template vòng S-5 (`S-5.<n>`)
 *   Tổng = 51 + 5 × N,  N = số màn + 1 nếu có non-screen function
 *   Step id của vòng S-5 là `S-5.<n>@<screen_id>` hoặc `S-5.<n>@nonscreen`.
 *
 * `reads` dùng selector projection của T11 (`functions[screen_id=@loop]:id,name`); `documents` nghĩa là
 * step được nạp tài liệu upload. `writes` là gốc path step được ghi.
 */

import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { getAssetsRoot } from "../../config/paths.js"
import type { Spine, StepStatus } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const STEP_NOT_FOUND = "STEP_NOT_FOUND"

/** Token trong `reads`: step được nạp tài liệu upload — không phải selector projection. */
export const DOCUMENTS_READ = "documents"

export const PHASES = Object.freeze(["B-0", "B-1", "B-2", "S-1", "S-2", "S-3", "S-4", "S-5", "S-6", "S-7", "S-8", "S-9"] as const)
export type PhaseId = (typeof PHASES)[number]

export const LOOP_PHASE: PhaseId = "S-5"
export const NONSCREEN_LOOP = "nonscreen"
/** Phases §6.4: 13 Brief + 38 SRS cố định. */
export const FIXED_STEP_COUNT = 51
export const STEPS_PER_LOOP = 5
/** N chốt ở S-4.1 (Phases §1.1); trước đó thanh tiến độ không hiện %. */
export const N_LOCKED_AT_STEP = "S-4.1"

export const stepDefSchema = z.strictObject({
  id: z.string().regex(/^(B-[0-2]|S-[1-9])\.\d+$/),
  phase: z.enum(PHASES),
  phase_label_en: z.string().min(1),
  label_vi: z.string().min(1),
  label_en: z.string().min(1),
  kind: z.enum(["soft", "fixed", "loop", "gate"]),
  reads: z.array(z.string().min(1)),
  writes: z.array(z.string().min(1)),
  renders: z.array(z.enum(["context", "usecase", "screen_flow", "erd", "screen_layout"])),
  uc: z.array(z.string().regex(/^\d+\.\d+$/)),
  deterministic: z.boolean(),
  description: z.string().min(1)
})

export type StepDef = z.infer<typeof stepDefSchema>

export const stepRegistrySchema = z.array(stepDefSchema).superRefine((steps, ctx) => {
  const seen = new Set<string>()
  steps.forEach((step, index) => {
    if (seen.has(step.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `Trùng step id ${step.id}` })
    seen.add(step.id)
    if (!step.id.startsWith(`${step.phase}.`)) ctx.addIssue({ code: "custom", path: [index, "phase"], message: `${step.id} không thuộc phase ${step.phase}` })
    if ((step.kind === "loop") !== (step.phase === LOOP_PHASE)) {
      ctx.addIssue({ code: "custom", path: [index, "kind"], message: `Chỉ step ${LOOP_PHASE} có kind = loop (${step.id})` })
    }
  })
})

export const getStepRegistryPath = (): string => path.join(getAssetsRoot(), "step-registry.json")

let cache: readonly StepDef[] | null = null

export const loadStepRegistry = (): readonly StepDef[] => {
  if (cache) return cache
  const raw: unknown = JSON.parse(fs.readFileSync(getStepRegistryPath(), "utf8"))
  const parsed = stepRegistrySchema.safeParse(raw)
  if (!parsed.success) throw new Error(`assets/step-registry.json không hợp lệ: ${z.prettifyError(parsed.error)}`)
  cache = Object.freeze(parsed.data)
  return cache
}

export const invalidateStepRegistryCache = (): void => {
  cache = null
}

// ─── id ──────────────────────────────────────────────────────────

export interface ParsedStepId {
  base: string
  loop: string | null
}

export const parseStepId = (stepId: string): ParsedStepId => {
  const at = stepId.indexOf("@")
  return at < 0 ? { base: stepId, loop: null } : { base: stepId.slice(0, at), loop: stepId.slice(at + 1) }
}

export interface ExpandedStep extends StepDef {
  /** Id đầy đủ, kèm `@loop` với vòng S-5. */
  id: string
  template_id: string
  loop: string | null
}

const expand = (def: StepDef, loop: string | null): ExpandedStep => ({
  ...def,
  id: loop ? `${def.id}@${loop}` : def.id,
  template_id: def.id,
  loop
})

/** Tra một step; `S-5.x` bắt buộc có `@loop`, step khác không được có. */
export const getStep = (stepId: string): ExpandedStep => {
  const { base, loop } = parseStepId(stepId)
  const def = loadStepRegistry().find((s) => s.id === base)
  if (!def || (def.kind === "loop") !== (loop !== null) || loop === "") {
    throw new ApiError(404, `Không có step ${stepId}`, STEP_NOT_FOUND)
  }
  return expand(def, loop)
}

export const phaseOf = (stepId: string): PhaseId => getStep(stepId).phase

// ─── vòng S-5 ────────────────────────────────────────────────────

/** Khoá vòng S-5 theo thứ tự queue: màn (queue_order rồi id) + `nonscreen` nếu có non-screen function. */
export const loopKeys = (spine: Pick<Spine, "screens" | "functions">): string[] => {
  const screens = [...spine.screens]
    .sort((a, b) => (a.queue_order ?? Number.MAX_SAFE_INTEGER) - (b.queue_order ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1))
    .map((s) => s.id)
  return spine.functions.some((f) => f.screen_id === null) ? [...screens, NONSCREEN_LOOP] : screens
}

export const expandS5 = (spine: Pick<Spine, "screens" | "functions">): ExpandedStep[] => {
  const templates = loadStepRegistry().filter((s) => s.kind === "loop")
  return loopKeys(spine).flatMap((key) => templates.map((t) => expand(t, key)))
}

/** Toàn bộ step theo thứ tự chạy: phase B-0 … S-4, vòng S-5 mở rộng, S-6 … S-9. */
export const orderedSteps = (spine: Pick<Spine, "screens" | "functions">): ExpandedStep[] => {
  const registry = loadStepRegistry()
  return PHASES.flatMap((phase) =>
    phase === LOOP_PHASE ? expandS5(spine) : registry.filter((s) => s.phase === phase).map((s) => expand(s, null))
  )
}

export const totalSteps = (spine: Pick<Spine, "screens" | "functions">): number =>
  FIXED_STEP_COUNT + STEPS_PER_LOOP * loopKeys(spine).length

const statusOf = (spine: Pick<Spine, "steps">, id: string): StepStatus =>
  spine.steps.find((s) => s.id === id)?.status ?? "pending"

/**
 * Step kế tiếp cần làm: step đầu tiên chưa `accepted`. Vòng của màn `placeholder` bị bỏ qua
 * (Phases §6.2: placeholder đã được quyết định để lại, không tính là pending). Hết ⇒ null.
 */
export const nextStep = (spine: Pick<Spine, "screens" | "functions" | "steps">): ExpandedStep | null => {
  const placeholders = new Set(spine.screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id))
  return (
    orderedSteps(spine).find((step) => !(step.loop !== null && placeholders.has(step.loop)) && statusOf(spine, step.id) !== "accepted") ?? null
  )
}
