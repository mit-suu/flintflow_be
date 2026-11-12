/**
 * Vẽ lại ảnh gốc của dự án import bằng mockup (FLF-410). Trạng thái từng màn ở `Project.screenMockups` (ngoài Spine):
 * kiểu vẽ (`system` / `original`), bật / tắt, ảnh bị thay.
 *
 * - `estimate`: số màn cần gọi model + credit dự tính (màn đã đúng kiểu mà spec còn khớp ⇒ 0).
 * - `run`: kiểm credit TRƯỚC khi chạy (thiếu ⇒ 402 `{ required, available }`, không chạy dở); màn đã vẽ đúng kiểu đang tắt ⇒
 *   bật lại 0 credit; kiểu `original` mà không ảnh nào đọc được ⇒ chuyển màn đó sang `system`. Model lỗi ⇒ màn giữ ảnh gốc.
 *   Màu chủ đạo ảnh gốc ⇒ theme dự án khi chưa chọn màu, không thì trả `suggested_color`.
 * - `disable`: dùng lại ảnh gốc (giữ hình đã vẽ), 0 credit.
 */

import mongoose from "mongoose"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost, getOrCreateWallet, resolveWalletOrg } from "../../shared/ai/credit-reservation.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { resolveScreenTheme, screenMockupsOf, screenThemeOf, type ScreenMockupMode, type ScreenMockupState } from "../../shared/diagram/screen-theme.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { Project } from "../project/project.model.js"
import { screenSpecOf } from "./renderers/screen-mockup.js"
import { aiScreenLayout, layoutContext, type DrawLayout } from "./screen-layout.ai.js"
import { layoutContentHash, type LoadOriginal } from "./screen-layout-parts.js"
import { imageHashOf, loadFunctionOriginals, loadScreenOriginal, originalImages, originalSectionOfScreen, screenLayoutImageIndexes, type FunctionOriginalLite, type LoadImage } from "./screen-originals.js"
import type { ScreenEnvelope } from "./screen-spec.js"

export type MockupScope = "screen" | "all"

export interface MockupRequest {
  mode: ScreenMockupMode
  scope: MockupScope
  screen_id?: string
  /** scope = screen, nhiều màn (thử lại các màn lỗi). */
  screen_ids?: string[]
}

export interface MockupEstimate {
  screens: number
  ai_calls: number
  credits: number
  /** Màn đã vẽ đúng kiểu nhưng đang dùng ảnh gốc ⇒ bật lại, 0 credit. */
  reenable: number
  /**
   * Mỗi màn trong phạm vi rơi vào đúng một nhóm (cộng lại = `screens`): `draw` AI vẽ mới (1 lượt / màn), `reenable` bật lại
   * hình đã vẽ, `skip` đã là mockup đúng kiểu đang hiển thị ⇒ bỏ qua.
   */
  groups: { draw: string[]; reenable: string[]; skip: string[] }
}

export interface MockupRunResult {
  done: string[]
  failed: { screen_id: string; reason: string }[]
  fell_back_to_system: string[]
  suggested_color?: string
}

export const SCREEN_NOT_FOUND = "SCREEN_NOT_FOUND"
export const SCREEN_HAS_NO_ORIGINAL = "SCREEN_HAS_NO_ORIGINAL"
export const INSUFFICIENT_CREDITS = "INSUFFICIENT_CREDITS"

export interface MockupDeps {
  originals: (projectId: string) => Promise<FunctionOriginalLite[]>
  loadImage?: LoadImage
  /** Vẽ (gọi model) các màn — mặc định `renderScreenMockups` với model thật. */
  render: (projectId: string, screenIds: string[], userId: string, onDrawn: OnDrawn, loadOriginal: LoadOriginal) => Promise<void>
  /** Credit khả dụng của ví org sở hữu dự án. */
  available: (projectId: string, userId: string) => Promise<number>
  cost: () => Promise<number>
}

type OnDrawn = (screenId: string, envelope: ScreenEnvelope | null) => void

/**
 * Vẽ các màn bằng model trong một transaction. `force`: hình đang có (kiểu khác, hoặc bảng function) không được giữ chỉ vì
 * `source_hash` còn khớp — kiểu vẽ nằm trong `contentHash` của spec, không trong hash hình.
 */
export const renderScreenMockups = async (projectId: string, screenIds: string[], userId: string, onDrawn: OnDrawn, loadOriginal: LoadOriginal, drawLayout: DrawLayout = aiScreenLayout): Promise<void> => {
  const { renderDiagrams } = await import("./diagram.service.js")
  await renderDiagrams(
    projectId,
    screenIds.map((id) => ({ kind: "screen_layout" as const, owner_id: id })),
    { by: userId, force: true, deps: { drawLayout, loadOriginal }, onLayoutDrawn: onDrawn }
  )
}

const defaultDeps = (): MockupDeps => ({
  originals: loadFunctionOriginals,
  render: (projectId, screenIds, userId, onDrawn, loadOriginal) => renderScreenMockups(projectId, screenIds, userId, onDrawn, loadOriginal),
  available: async (projectId, userId) => {
    const orgId = await resolveWalletOrg(projectId)
    if (!orgId) return 0
    const wallet = await getOrCreateWallet(userId, undefined, orgId)
    return wallet.balance - wallet.reserved
  },
  cost: () => getActionCost(ActionType.RENDER_FIX)
})

const notFound = () => new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")

interface Loaded {
  spine: Spine
  states: ScreenMockupState[]
  themeColor: string | null
  originals: FunctionOriginalLite[]
}

const load = async (projectId: string, orgId: string, deps: MockupDeps): Promise<Loaded> => {
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  const project = await Project.findOne({ _id: projectId, organizationId: orgId }).select("screenMockups screenTheme").lean()
  if (!project) throw notFound()
  const record = await spineRepository.get(projectId)
  if (!record) throw notFound()
  const { projectId: _p, ...spine } = record
  return { spine: spine as Spine, states: screenMockupsOf(project), themeColor: screenThemeOf(project).primaryColor, originals: await deps.originals(projectId) }
}

/** Màn có ảnh gốc trong nguyên văn file (theo thứ tự id). */
export const screensWithOriginal = (spine: Spine, originals: readonly FunctionOriginalLite[]): string[] =>
  spine.screens
    .map((s) => s.id)
    .filter((id) => {
      const section = originalSectionOfScreen(spine, originals, id)
      return section !== null && originalImages(section.blocks).length > 0
    })
    .sort()

const targetsOf = (spine: Spine, originals: readonly FunctionOriginalLite[], req: Pick<MockupRequest, "scope" | "screen_id" | "screen_ids">): string[] => {
  const withOriginal = screensWithOriginal(spine, originals)
  if (req.scope === "all") return withOriginal
  const ids = [...new Set(req.screen_ids ?? [req.screen_id ?? ""])]
  for (const id of ids) {
    if (!spine.screens.some((s) => s.id === id)) throw new ApiError(404, "Không tìm thấy màn hình.", SCREEN_NOT_FOUND, { screen_id: id })
    if (!withOriginal.includes(id)) throw new ApiError(400, "Màn này không có ảnh gốc trong tài liệu.", SCREEN_HAS_NO_ORIGINAL, { screen_id: id })
  }
  return ids
}

/** Hình đang có của màn đã là mockup đúng kiểu và spec còn khớp ngữ cảnh hiện tại ⇒ vẽ lại không cần model. */
const upToDate = (l: Loaded, screenId: string, mode: ScreenMockupMode, themeContext: Parameters<typeof resolveScreenTheme>[0]): boolean => {
  const section = originalSectionOfScreen(l.spine, l.originals, screenId)
  const images = section ? originalImages(section.blocks) : []
  const theme = resolveScreenTheme(themeContext, l.spine.project.form_factor)
  const context = layoutContext(l.spine, screenId, theme.platforms, { mode, images: images.map(({ index, caption, context: c }) => ({ index, caption, context: c })) })
  if (!context) return false
  const hash = layoutContentHash(context, mode, imageHashOf(images))
  return l.spine.diagrams.some((d) => d.kind === "screen_layout" && d.owner_id === screenId && d.format === "svg" && screenSpecOf(d.source)?.contentHash === hash && screenSpecOf(d.source)?.mode === mode)
}

interface Plan {
  reenable: string[]
  ai: string[]
}

const planOf = (l: Loaded, targets: readonly string[], mode: ScreenMockupMode, theme: Parameters<typeof resolveScreenTheme>[0]): Plan => {
  const plan: Plan = { reenable: [], ai: [] }
  for (const id of targets) {
    const state = l.states.find((s) => s.screen_id === id)
    if (state?.mode === mode && upToDate(l, id, mode, theme)) {
      if (!state.enabled) plan.reenable.push(id)
    } else plan.ai.push(id)
  }
  return plan
}

const themeOfProject = async (projectId: string) => screenThemeOf(await Project.findById(projectId).select("screenTheme").lean())

export const estimate = async (projectId: string, orgId: string, req: MockupRequest, deps: MockupDeps = defaultDeps()): Promise<MockupEstimate> => {
  const l = await load(projectId, orgId, deps)
  const targets = targetsOf(l.spine, l.originals, req)
  const plan = planOf(l, targets, req.mode, await themeOfProject(projectId))
  const skip = targets.filter((id) => !plan.ai.includes(id) && !plan.reenable.includes(id))
  return {
    screens: targets.length,
    ai_calls: plan.ai.length,
    credits: plan.ai.length * (await deps.cost()),
    reenable: plan.reenable.length,
    groups: { draw: plan.ai, reenable: plan.reenable, skip }
  }
}

/**
 * Ghi trạng thái màn. Bật / tắt mockup không đổi `spine_version` mà bản tài liệu nháp cache theo version ⇒ bỏ cache nháp của
 * dự án (bản baseline bất biến giữ nguyên) để lượt xem kế dựng lại.
 */
const writeStates = async (projectId: string, states: ScreenMockupState[]) => {
  await Project.updateOne({ _id: projectId }, { $set: { screenMockups: states } })
  const { RenderedDocumentCache } = await import("../render/rendered-document.model.js")
  await RenderedDocumentCache.deleteMany({ projectId, spine_version: { $exists: true } })
}

const upsert = (states: ScreenMockupState[], patch: ScreenMockupState): ScreenMockupState[] => [...states.filter((s) => s.screen_id !== patch.screen_id), patch]

/** Màu xuất hiện nhiều nhất (hoà ⇒ gặp trước). */
const mostFrequent = (colors: readonly string[]): string | null => {
  const counts = new Map<string, number>()
  for (const c of colors) counts.set(c, (counts.get(c) ?? 0) + 1)
  let best: string | null = null
  for (const [c, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = c
  return best
}

/** Kết quả bước chuẩn bị: màn cần gọi model (kèm kiểu đã chốt), màn bật lại 0 credit, màn rơi về kiểu chuẩn. */
export interface PreparedRun {
  ai: { screen_id: string; mode: ScreenMockupMode }[]
  reenabled: string[]
  fellBack: string[]
  /** Màu theme lúc bắt đầu (`null` = chưa chọn ⇒ màu ảnh gốc tự điền). */
  themeColor: string | null
}

/**
 * Chuẩn bị một lượt vẽ: chọn màn cần model, chuyển kiểu `original` không có ảnh đọc được sang `system`, kiểm credit TRƯỚC
 * (thiếu ⇒ 402, chưa ghi gì), rồi ghi trạng thái màn (bật lại màn đã đúng kiểu ngay, 0 credit).
 */
export const prepare = async (projectId: string, orgId: string, userId: string, req: MockupRequest, deps: MockupDeps = defaultDeps()): Promise<PreparedRun> => {
  const l = await load(projectId, orgId, deps)
  const targets = targetsOf(l.spine, l.originals, req)
  const theme = await themeOfProject(projectId)
  const plan = planOf(l, targets, req.mode, theme)

  // Kiểu ảnh gốc: màn không có ảnh đọc được (EMF, mất file) ⇒ kiểu chuẩn cho màn đó
  const modeOf = new Map<string, ScreenMockupMode>(plan.ai.map((id) => [id, req.mode]))
  const fellBack: string[] = []
  if (req.mode === "original") {
    const { loadImportImage } = await import("../render/import-media.js")
    const loadImage: LoadImage = deps.loadImage ?? loadImportImage
    for (const id of plan.ai) {
      const section = originalSectionOfScreen(l.spine, l.originals, id)
      const images = section ? originalImages(section.blocks) : []
      const readable = await Promise.all(images.map((i) => loadImage(projectId, i.image_ref).catch(() => null)))
      if (!readable.some(Boolean)) {
        modeOf.set(id, "system")
        fellBack.push(id)
      }
    }
  }
  // Màn chuyển kiểu chuẩn mà hình chuẩn đã có sẵn ⇒ không tốn lượt model
  const ai = plan.ai.filter((id) => {
    if (modeOf.get(id) === req.mode) return true
    const state = l.states.find((s) => s.screen_id === id)
    if (state?.mode === "system" && upToDate(l, id, "system", theme)) {
      plan.reenable.push(id)
      return false
    }
    return true
  })

  const cost = (await deps.cost()) * ai.length
  if (cost > 0) {
    const available = await deps.available(projectId, userId)
    if (cost > available) throw new ApiError(402, `Cần ${cost} credit, ví còn ${available}.`, INSUFFICIENT_CREDITS, { required: cost, available })
  }

  let states = l.states
  for (const id of plan.reenable) {
    const state = states.find((s) => s.screen_id === id)!
    states = upsert(states, { ...state, enabled: true })
  }
  for (const id of ai) {
    const state = states.find((s) => s.screen_id === id)
    states = upsert(states, { screen_id: id, mode: modeOf.get(id) ?? req.mode, enabled: true, image_indexes: state?.image_indexes ?? [] })
  }
  await writeStates(projectId, states)
  return { ai: ai.map((id) => ({ screen_id: id, mode: modeOf.get(id) ?? req.mode })), reenabled: plan.reenable, fellBack, themeColor: l.themeColor }
}

export interface DrawHooks {
  /** Kiểm trước mỗi màn: `true` ⇒ dừng (màn đang vẽ đã xong, màn còn lại không vẽ, không trừ credit). */
  shouldStop?: () => Promise<boolean>
  /** Sau mỗi màn (để ghi tiến độ). */
  onScreen?: (screenId: string, outcome: { ok: boolean; reason?: string }) => Promise<void>
}

/** Lượt vẽ một màn đụng khoá lạc quan (CR ghi xen giữa) ⇒ đọc lại Spine, thử lại một lần. */
const isVersionConflict = (err: unknown): boolean => err instanceof ApiError && err.code === spineRepository.SPINE_VERSION_CONFLICT

/**
 * Vẽ lần lượt từng màn đã chuẩn bị — mỗi màn một transaction riêng: tài liệu luôn hợp lệ giữa chừng (màn xong có mockup,
 * màn chưa tới giữ ảnh gốc), dừng giữa lượt không để lại trạng thái dở. Màu chủ đạo ảnh gốc: theme chưa có màu ⇒ tự điền và
 * vẽ lại từ spec; có rồi ⇒ trả gợi ý.
 */
export const drawPrepared = async (projectId: string, orgId: string, userId: string, prepared: PreparedRun, deps: MockupDeps = defaultDeps(), hooks: DrawHooks = {}): Promise<MockupRunResult & { cancelled: boolean }> => {
  const result: MockupRunResult & { cancelled: boolean } = { done: [...prepared.reenabled], failed: [], fell_back_to_system: prepared.fellBack, cancelled: false }
  const colors: string[] = []
  const loadOriginal = loadScreenOriginal({ originals: deps.originals, loadImage: deps.loadImage })
  for (const { screen_id: id } of prepared.ai) {
    if (await hooks.shouldStop?.()) {
      result.cancelled = true
      break
    }
    let envelope: ScreenEnvelope | null = null
    const draw = () => deps.render(projectId, [id], userId, (_screen, e) => (envelope = e), loadOriginal)
    let reason: string | undefined
    try {
      await draw().catch(async (err: unknown) => {
        if (!isVersionConflict(err)) throw err
        await draw()
      })
    } catch (err) {
      reason = isVersionConflict(err) ? "conflict" : "render"
      console.warn(`[screen-mockup] vẽ ${id} lỗi (project ${projectId}): ${err instanceof Error ? err.message : String(err)}`)
    }
    // Có mockup ⇒ ghi ảnh bị thay; không ⇒ giữ ảnh gốc (tắt màn)
    const l = await load(projectId, orgId, deps)
    const state = l.states.find((s) => s.screen_id === id)
    const isMockup = l.spine.diagrams.some((d) => d.kind === "screen_layout" && d.owner_id === id && d.format === "svg" && screenSpecOf(d.source) !== null)
    const drawn = envelope as ScreenEnvelope | null
    if (state && isMockup && !reason) {
      const section = originalSectionOfScreen(l.spine, l.originals, id)
      await writeStates(projectId, upsert(l.states, { ...state, image_indexes: screenLayoutImageIndexes(section ? originalImages(section.blocks) : [], drawn?.screenImages) }))
      result.done.push(id)
      if (drawn?.primaryColor) colors.push(drawn.primaryColor)
    } else {
      if (state) await writeStates(projectId, upsert(l.states, { ...state, enabled: false }))
      reason ??= drawn ? "layout" : "model"
      result.failed.push({ screen_id: id, reason })
    }
    await hooks.onScreen?.(id, { ok: !reason, reason })
  }

  const color = mostFrequent(colors)
  if (color) {
    if (prepared.themeColor === null) {
      await Project.updateOne({ _id: projectId, "screenTheme.primaryColor": null }, { $set: { "screenTheme.primaryColor": color } })
      const { redrawScreenLayouts } = await import("../project/project.service.js")
      await redrawScreenLayouts(projectId, userId)
    } else if (color !== prepared.themeColor) result.suggested_color = color
  }
  return result
}

/** Chuẩn bị + vẽ ngay trong lượt gọi (job nền và test dùng). */
export const run = async (projectId: string, orgId: string, userId: string, req: MockupRequest, deps: MockupDeps = defaultDeps()): Promise<MockupRunResult> => {
  const { cancelled: _cancelled, ...result } = await drawPrepared(projectId, orgId, userId, await prepare(projectId, orgId, userId, req, deps), deps)
  return result
}

export const disable = async (projectId: string, orgId: string, req: Pick<MockupRequest, "scope" | "screen_id">, deps: Pick<MockupDeps, "originals"> = defaultDeps()): Promise<{ disabled: string[] }> => {
  const l = await load(projectId, orgId, { ...defaultDeps(), ...deps })
  const targets = new Set(targetsOf(l.spine, l.originals, req))
  const disabled = l.states.filter((s) => targets.has(s.screen_id) && s.enabled).map((s) => s.screen_id)
  await writeStates(projectId, l.states.map((s) => (targets.has(s.screen_id) ? { ...s, enabled: false } : s)))
  return { disabled }
}

export interface MockupSummary {
  with_original: number
  using_mockup: number
  /** Trạng thái đã lưu của các màn đã từng vẽ mockup. */
  screens: ScreenMockupState[]
  /** Màn có ảnh gốc + mục §3.x.y chứa ảnh (trang xem gắn nút "Vẽ lại bằng mockup" theo mục). */
  originals: { screen_id: string; section_id: string; name: string }[]
}

/** Tóm tắt cho cài đặt dự án và trang xem: màn có ảnh gốc (kèm mục), số màn đang dùng mockup. */
export const summary = async (projectId: string, orgId: string, deps: Pick<MockupDeps, "originals"> = defaultDeps()): Promise<MockupSummary> => {
  const l = await load(projectId, orgId, { ...defaultDeps(), ...deps })
  const withOriginal = screensWithOriginal(l.spine, l.originals)
  return {
    with_original: withOriginal.length,
    using_mockup: l.states.filter((s) => s.enabled && withOriginal.includes(s.screen_id)).length,
    screens: l.states,
    originals: withOriginal.map((id) => ({
      screen_id: id,
      section_id: originalSectionOfScreen(l.spine, l.originals, id)!.section_id,
      name: l.spine.screens.find((s) => s.id === id)?.name ?? id
    }))
  }
}

/**
 * Ảnh gốc đầu tiên của màn (ảnh màn hình đã nhận diện, chưa nhận diện ⇒ theo chú thích / ảnh đầu) — hình minh hoạ cho lựa chọn
 * "Theo bố cục ảnh gốc". Không có / EMF ⇒ 404.
 */
export const originalImageOf = async (projectId: string, orgId: string, screenId: string, deps: Pick<MockupDeps, "originals" | "loadImage"> = defaultDeps()): Promise<{ mime: string; data: Buffer }> => {
  const l = await load(projectId, orgId, { ...defaultDeps(), ...deps })
  const section = originalSectionOfScreen(l.spine, l.originals, screenId)
  const images = section ? originalImages(section.blocks) : []
  const state = l.states.find((s) => s.screen_id === screenId)
  const index = (state?.image_indexes.length ? state.image_indexes : screenLayoutImageIndexes(images, null))[0]
  const ref = images.find((i) => i.index === index)?.image_ref
  const { loadImportImage } = await import("../render/import-media.js")
  const image = ref ? await (deps.loadImage ?? loadImportImage)(projectId, ref).catch(() => null) : null
  if (!image) throw new ApiError(404, "Màn này không có ảnh gốc hiển thị được.", SCREEN_HAS_NO_ORIGINAL, { screen_id: screenId })
  return { mime: image.mime, data: Buffer.from(image.data, "base64") }
}

/**
 * Lượt không chạy được (không đưa được vào hàng đợi): màn vừa bật ở bước chuẩn bị mà chưa có mockup ⇒ tắt lại, tài liệu và
 * tóm tắt "đang dùng mockup" không báo sai.
 */
export const revertPrepared = async (projectId: string, orgId: string, prepared: PreparedRun, deps: MockupDeps = defaultDeps()): Promise<void> => {
  const l = await load(projectId, orgId, deps)
  const drawn = (id: string) => l.spine.diagrams.some((d) => d.kind === "screen_layout" && d.owner_id === id && d.format === "svg" && screenSpecOf(d.source) !== null)
  const ids = new Set(prepared.ai.map((a) => a.screen_id).filter((id) => !drawn(id)))
  if (ids.size > 0) await writeStates(projectId, l.states.map((s) => (ids.has(s.screen_id) ? { ...s, enabled: false } : s)))
}
