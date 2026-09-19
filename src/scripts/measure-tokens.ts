/**
 * T22 — Đo token/credit end-to-end của pipeline trên fixture (rủi ro gốc Phases §9.3, srs-spine §10).
 *
 * Cách dùng:
 *   npm run measure:tokens                               # estimate, fixture 19 màn, ghi docs/measurements.md
 *   npm run measure:tokens -- --mode real-draft          # elicit giả lập, draft gọi provider thật (tốn credit)
 *   npm run measure:tokens -- --mode real                # mọi lượt gọi provider thật; tự trả lời answer_needed
 *   npm run measure:tokens -- --fixture minimal --no-write --usd-in 0.15 --usd-out 0.6
 *
 * Cách đo: với MỖI step trong `orderedSteps(fixture)` (51 + 5 × N, bỏ vòng S-5 của màn placeholder), nạp lại
 * Spine fixture với mọi step trước đó accepted rồi gọi `runStep` thật. Spine ở trạng thái cuối nên input đo
 * được là **trần** của từng step — đúng thứ cần biết để phát hiện input tăng theo tiến độ.
 *   - estimate:   executor bắt `promptVariables`, dựng prompt bằng đúng `getPromptTemplate` + `interpolatePrompt`
 *                 mà `executeAiAction` dùng ⇒ tokens_in = ký tự / 4. Draft trả `ops: []` (không ghi gì);
 *                 tokens_out ƯỚC LƯỢNG từ op-case fixture của step (S-5.2/S-5.4 nhân số function trong lô).
 *                 Credit theo `getActionCost` (bảng giá lượt gọi thật). Không gọi model, không tốn tiền.
 *   - real-draft / real: executor mặc định (`executeAiAction`) ⇒ token do provider báo, credit trừ thật ở ví seed.
 * Mongo: tự dựng replica set in-memory (devDependency `mongodb-memory-server`), hoặc `--mongo-uri`.
 * KHÔNG trỏ vào DB thật: script xoá/ghi đè Spine của project nó tự tạo.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// ─── Kiểu + hàm thuần (unit test ở measure-tokens.test.ts) ────────────

export type MeasureMode = "estimate" | "real-draft" | "real"
export type CallKind = "elicit" | "draft" | "review"

export interface CallRecord {
  step_id: string
  phase: string
  call_kind: CallKind
  tokens_in: number
  tokens_out: number
  credit: number
  /** Số đo từ provider (true) hay ước lượng ký tự/4 (false). */
  measured: boolean
  error?: string
}

export interface MeasureOptions {
  mode: MeasureMode
  fixture: "full" | "minimal"
  out: string | null
  usdInPer1M: number | null
  usdOutPer1M: number | null
  mongoUri: string | null
  /** Chỉ đo N step đầu (debug). */
  limitSteps: number | null
}

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))

export const parseArgs = (argv: string[]): MeasureOptions => {
  const options: MeasureOptions = {
    mode: "estimate",
    fixture: "full",
    out: "docs/measurements.md",
    usdInPer1M: null,
    usdOutPer1M: null,
    mongoUri: null,
    limitSteps: null
  }
  const number = (flag: string, value: string | undefined): number => {
    const n = Number(value)
    if (value === undefined || !Number.isFinite(n) || n < 0) throw new Error(`${flag} cần một số ≥ 0`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case "--mode":
        if (value !== "estimate" && value !== "real-draft" && value !== "real") throw new Error(`--mode phải là estimate | real-draft | real, nhận: ${value}`)
        options.mode = value
        i++
        break
      case "--real":
        options.mode = "real"
        break
      case "--fixture":
        if (value !== "full" && value !== "minimal") throw new Error(`--fixture phải là full | minimal, nhận: ${value}`)
        options.fixture = value
        i++
        break
      case "--out":
        if (!value) throw new Error("--out cần đường dẫn")
        options.out = value
        i++
        break
      case "--no-write":
        options.out = null
        break
      case "--usd-in":
        options.usdInPer1M = number(flag, value)
        i++
        break
      case "--usd-out":
        options.usdOutPer1M = number(flag, value)
        i++
        break
      case "--mongo-uri":
        if (!value) throw new Error("--mongo-uri cần URI")
        options.mongoUri = value
        i++
        break
      case "--limit-steps":
        options.limitSteps = number(flag, value)
        i++
        break
      default:
        throw new Error(`Tham số không biết: ${flag}`)
    }
  }
  return options
}

/** Nhóm theo phase: vòng S-5 gộp một dòng. */
export const phaseOf = (stepId: string): string => {
  const m = /^([BS]-\d+)/.exec(stepId)
  return m ? m[1] : stepId
}

export interface Totals {
  steps: number
  calls: number
  elicit_calls: number
  draft_calls: number
  tokens_in: number
  tokens_out: number
  credit: number
}

const emptyTotals = (): Totals => ({ steps: 0, calls: 0, elicit_calls: 0, draft_calls: 0, tokens_in: 0, tokens_out: 0, credit: 0 })

export const summarize = (records: CallRecord[], stepIds: string[]): { byPhase: Map<string, Totals>; total: Totals } => {
  const byPhase = new Map<string, Totals>()
  const total = emptyTotals()
  for (const stepId of stepIds) {
    const phase = phaseOf(stepId)
    if (!byPhase.has(phase)) byPhase.set(phase, emptyTotals())
    byPhase.get(phase)!.steps += 1
    total.steps += 1
  }
  for (const r of records) {
    if (!byPhase.has(r.phase)) byPhase.set(r.phase, emptyTotals())
    for (const t of [byPhase.get(r.phase)!, total]) {
      t.calls += 1
      if (r.call_kind === "elicit") t.elicit_calls += 1
      if (r.call_kind === "draft") t.draft_calls += 1
      t.tokens_in += r.tokens_in
      t.tokens_out += r.tokens_out
      t.credit += r.credit
    }
  }
  return { byPhase, total }
}

export const usdOf = (tokensIn: number, tokensOut: number, usdInPer1M: number | null, usdOutPer1M: number | null): number | null =>
  usdInPer1M === null || usdOutPer1M === null ? null : (tokensIn / 1_000_000) * usdInPer1M + (tokensOut / 1_000_000) * usdOutPer1M

/**
 * Input của draft theo thứ tự step: so trung bình 1/3 đầu với 1/3 cuối. Tỉ lệ lớn ⇒ input tăng theo tiến độ
 * (dấu hiệu chi phí bậc hai) ⇒ theo ghi chú rủi ro T22, mở issue cho projection T11.
 */
export const inputGrowth = (records: CallRecord[], stepOrder: string[]): { first: number; last: number; ratio: number } | null => {
  const draftIn = stepOrder
    .map((id) => records.filter((r) => r.step_id === id && r.call_kind === "draft").reduce((s, r) => s + r.tokens_in, 0))
    .filter((n) => n > 0)
  if (draftIn.length < 3) return null
  const third = Math.max(1, Math.floor(draftIn.length / 3))
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  const first = Math.round(avg(draftIn.slice(0, third)))
  const last = Math.round(avg(draftIn.slice(-third)))
  return { first, last, ratio: Number((last / first).toFixed(2)) }
}

/**
 * Fixture để nhiều màn ở `placeholder` ⇒ vòng S-5 của chúng không chạy. Ngoại suy chi phí nếu mọi vòng đều
 * chi tiết: thay phần S-5 đo được bằng trung bình một vòng × tổng số vòng. null khi không đo vòng nào hoặc đã đủ.
 */
export const projectAllLoopsDetailed = (
  records: CallRecord[],
  stepOrder: string[],
  totalLoops: number
): { measuredLoops: number; calls: number; tokens_in: number; tokens_out: number; credit: number } | null => {
  const measuredLoops = new Set(stepOrder.filter((id) => id.startsWith("S-5.") && id.includes("@")).map((id) => id.split("@")[1])).size
  if (measuredLoops === 0 || measuredLoops >= totalLoops) return null
  const { total } = summarize(records, stepOrder)
  const loop = summarize(records.filter((r) => r.phase === "S-5"), [])
  const factor = totalLoops / measuredLoops
  return {
    measuredLoops,
    calls: Math.round(total.calls - loop.total.calls + loop.total.calls * factor),
    tokens_in: Math.round(total.tokens_in - loop.total.tokens_in + loop.total.tokens_in * factor),
    tokens_out: Math.round(total.tokens_out - loop.total.tokens_out + loop.total.tokens_out * factor),
    credit: Math.round(total.credit - loop.total.credit + loop.total.credit * factor)
  }
}

export interface Thresholds {
  credit_per_project: number | null
  usd_per_project: number | null
  tokens_in_per_call: number | null
}

/**
 * Đọc bảng ngưỡng nhóm đặt ở `docs/measurements.md` mục `## Threshold` (dòng `| key | value |`).
 * Ô trống, "—" hoặc chữ ⇒ null (chưa đặt) — script không tự đặt ngưỡng.
 */
export const parseThresholds = (markdown: string): Thresholds => {
  const result: Thresholds = { credit_per_project: null, usd_per_project: null, tokens_in_per_call: null }
  const start = markdown.search(/^## Threshold\b/m)
  if (start < 0) return result
  const rest = markdown.slice(start + 1)
  const end = rest.search(/^## /m)
  const section = end < 0 ? rest : rest.slice(0, end)
  for (const key of Object.keys(result) as Array<keyof Thresholds>) {
    const m = new RegExp(`^\\|\\s*\`?${key}\`?\\s*\\|\\s*([^|]*)\\|`, "m").exec(section)
    const value = m ? Number(m[1].trim().replace(/\s/g, "")) : NaN
    result[key] = m && m[1].trim() !== "" && Number.isFinite(value) ? value : null
  }
  return result
}

const START_MARK = "<!-- T22:measure-tokens:start -->"
const END_MARK = "<!-- T22:measure-tokens:end -->"

/** Thay đúng khối của script (giữa hai marker) — không đụng mục người khác; chưa có thì nối cuối. */
export const upsertSection = (markdown: string, section: string): string => {
  const block = `${START_MARK}\n${section.trim()}\n${END_MARK}`
  const s = markdown.indexOf(START_MARK)
  const e = markdown.indexOf(END_MARK)
  if (s >= 0 && e > s) return `${markdown.slice(0, s)}${block}${markdown.slice(e + END_MARK.length)}`
  return `${markdown.replace(/\s*$/, "")}\n\n${block}\n`
}

const fmt = (n: number): string => n.toLocaleString("en-US").replace(/,/g, " ")
const fmtUsd = (n: number | null): string => (n === null ? "n/a" : `$${n.toFixed(4)}`)

const compare = (label: string, actual: number | null, limit: number | null): string =>
  limit === null ? `| ${label} | ${actual === null ? "n/a" : fmt(Math.round(actual * 10000) / 10000)} | chưa đặt | — |` : `| ${label} | ${actual === null ? "n/a" : fmt(Math.round(actual * 10000) / 10000)} | ${fmt(limit)} | ${actual === null ? "n/a" : actual <= limit ? "đạt" : "**vượt**"} |`

export interface ReportInput {
  options: MeasureOptions
  records: CallRecord[]
  stepOrder: string[]
  shape: { screens: number; functions: number; loops: number; totalSteps: number }
  startedAt: Date
  durationMs: number
  thresholds: Thresholds
}

export const renderReport = ({ options, records, stepOrder, shape, startedAt, durationMs, thresholds }: ReportInput): string => {
  const { byPhase, total } = summarize(records, stepOrder)
  const growth = inputGrowth(records, stepOrder)
  const usd = usdOf(total.tokens_in, total.tokens_out, options.usdInPer1M, options.usdOutPer1M)
  const measured = records.every((r) => r.measured)
  const errors = records.filter((r) => r.error)
  const maxIn = records.reduce((m, r) => Math.max(m, r.tokens_in), 0)
  const fixtureName = options.fixture === "full" ? "spine-fixture-19-screens.json" : "spine-fixture-minimal.json"

  const phaseRows = [...byPhase.entries()].map(([phase, t]) => {
    const phaseUsd = usdOf(t.tokens_in, t.tokens_out, options.usdInPer1M, options.usdOutPer1M)
    return `| ${phase} | ${t.steps} | ${t.calls} (${t.elicit_calls} + ${t.draft_calls}) | ${fmt(t.tokens_in)} | ${fmt(t.tokens_out)} | ${fmt(t.credit)} | ${fmtUsd(phaseUsd)} |`
  })

  const stepRows = stepOrder.map((id) => {
    const rs = records.filter((r) => r.step_id === id)
    const tin = rs.reduce((s, r) => s + r.tokens_in, 0)
    const tout = rs.reduce((s, r) => s + r.tokens_out, 0)
    const credit = rs.reduce((s, r) => s + r.credit, 0)
    const err = rs.find((r) => r.error)?.error
    return `| ${id} | ${rs.length} | ${fmt(tin)} | ${fmt(tout)} | ${fmt(credit)} |${err ? ` ${err.replace(/\|/g, "\\|").slice(0, 120)}` : ""} |`
  })

  const projection = projectAllLoopsDetailed(records, stepOrder, shape.loops)
  const projectionLines = projection
    ? [
        "",
        "### Ngoại suy: mọi vòng S-5 đều chi tiết",
        "",
        `Fixture chỉ có ${projection.measuredLoops}/${shape.loops} vòng S-5 chi tiết (màn placeholder bỏ vòng). Nhân trung bình một vòng đã đo lên ${shape.loops} vòng:`,
        "",
        "| Kịch bản | Lượt gọi | Tokens in | Tokens out | Credit | USD |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
        `| Đo được (${projection.measuredLoops} vòng) | ${total.calls} | ${fmt(total.tokens_in)} | ${fmt(total.tokens_out)} | ${fmt(total.credit)} | ${fmtUsd(usd)} |`,
        `| Ngoại suy (${shape.loops} vòng) | ${fmt(projection.calls)} | ${fmt(projection.tokens_in)} | ${fmt(projection.tokens_out)} | ${fmt(projection.credit)} | ${fmtUsd(usdOf(projection.tokens_in, projection.tokens_out, options.usdInPer1M, options.usdOutPer1M))} |`
      ]
    : []

  return [
    `## End-to-end token measurement — \`${fixtureName}\`, mode \`${options.mode}\` (T22, ${startedAt.toISOString().slice(0, 10)})`,
    "",
    `Sinh bởi \`npm run measure:tokens${options.mode === "estimate" ? "" : ` -- --mode ${options.mode}`}\` (\`src/scripts/measure-tokens.ts\`), ${Math.round(durationMs / 1000)} s.`,
    `Hình fixture: ${shape.screens} màn, ${shape.functions} function, ${shape.loops} vòng S-5 ⇒ \`51 + 5 × ${shape.loops} = ${shape.totalSteps}\` step; đo ${stepOrder.length} step (bỏ vòng của màn placeholder).`,
    "Mỗi step chạy `runStep` thật trên Spine fixture ở trạng thái cuối, mọi step trước đó accepted ⇒ input là **trần** của step.",
    measured
      ? "Token do provider báo; credit trừ thật ở ví seed."
      : "**Số ước lượng**: tokens_in = ký tự/4 của prompt thật (`getPromptTemplate` + `interpolatePrompt`); tokens_out = ký tự/4 của op-case fixture (không gồm reasoning ẩn — lượt chạy thật M3 đo tokens_out gấp 3–5× tokens_in với GLM-5.3-Flash). Credit theo `getActionCost`.",
    "",
    "| Phase | Step | Lượt gọi (elicit + draft) | Tokens in | Tokens out | Credit | USD |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...phaseRows,
    `| **Tổng** | **${total.steps}** | **${total.calls} (${total.elicit_calls} + ${total.draft_calls})** | **${fmt(total.tokens_in)}** | **${fmt(total.tokens_out)}** | **${fmt(total.credit)}** | **${fmtUsd(usd)}** |`,
    "",
    options.usdInPer1M === null ? "USD: n/a — chưa truyền `--usd-in`/`--usd-out` (USD / 1M token); provider GLM trên Modal không có bảng giá trong repo." : `USD theo đơn giá truyền vào: in $${options.usdInPer1M}/1M, out $${options.usdOutPer1M}/1M.`,
    measured ? "" : "Step không có op-case fixture (S-9.3, S-9.4) có tokens_out ≈ 0 trong chế độ estimate — chỉ tokens_in của chúng là số dùng được.",
    ...projectionLines,
    "",
    "### So với ngưỡng (`## Threshold`)",
    "",
    "| Chỉ số | Đo được | Ngưỡng | Kết quả |",
    "| --- | ---: | ---: | --- |",
    compare("credit_per_project", total.credit, thresholds.credit_per_project),
    compare("usd_per_project", usd, thresholds.usd_per_project),
    compare("tokens_in_per_call (max)", maxIn, thresholds.tokens_in_per_call),
    "",
    "### Input tăng theo tiến độ?",
    "",
    growth
      ? `Tokens in trung bình mỗi step có draft: 1/3 đầu **${fmt(growth.first)}**, 1/3 cuối **${fmt(growth.last)}** ⇒ tỉ lệ **${growth.ratio}×**.${growth.ratio >= 2 ? " ≥ 2× ⇒ theo ghi chú rủi ro T22, mở issue cho projection T11 (không sửa trong T22)." : " < 2× ⇒ projection giữ input phẳng, chưa thấy dấu hiệu bậc hai."}`
      : "Không đủ step có draft để so.",
    errors.length > 0 ? `\nLỗi ghi nhận: ${errors.length} lượt (chi tiết ở bảng dưới).` : "",
    "",
    "<details><summary>Chi tiết từng step</summary>",
    "",
    "| Step | Lượt | Tokens in | Tokens out | Credit | Lỗi |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...stepRows,
    "",
    "</details>"
  ].join("\n")
}

// ─── Chạy thật (cần Mongo) ───────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const AUTO_ANSWER = "Use the product brief and your best judgement; keep it consistent with the existing Spine."

interface OpCaseFile {
  ops: unknown[]
  notes?: string
}

const OP_CASE_GROUPS = ["b0-s1", "s2-s3", "s4-s8"]

/** tokens_out ước lượng của một lượt draft: op-case fixture của step (template S-5.2/S-5.4 nhân số function trong lô). */
const estimateDraftOut = (templateId: string, functionsInBatch: number): number => {
  for (const group of OP_CASE_GROUPS) {
    const file = path.join(ROOT, "fixtures", "op-cases", group, `${templateId.toLowerCase()}.json`)
    if (!fs.existsSync(file)) continue
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as OpCaseFile
    const perCall = estimateTokens(JSON.stringify({ ops: raw.ops, notes: raw.notes }))
    return templateId === "S-5.2" || templateId === "S-5.4" ? perCall * Math.max(1, functionsInBatch) : perCall
  }
  return estimateTokens(JSON.stringify({ ops: [] }))
}

export interface MeasureResult {
  records: CallRecord[]
  stepOrder: string[]
  shape: ReportInput["shape"]
}

/**
 * Đo trên kết nối mongoose ĐÃ mở (script tự mở; integration test dùng kết nối của setup).
 * Phải import module app sau khi `MONGO_URI` đã đặt — nên toàn bộ import ở đây là dynamic.
 */
export const measure = async (options: MeasureOptions, log: (line: string) => void = console.log): Promise<MeasureResult> => {
  const [{ spineSchema }, { Spine }, { Change }, { Usage }, { User }, { Project }, { ChatSession }, { CreditWallet }] = await Promise.all([
    import("../modules/spine/spine.schema.js"),
    import("../modules/spine/spine.model.js"),
    import("../modules/spine/change.model.js"),
    import("../modules/spine/usage.model.js"),
    import("../modules/user/user.model.js"),
    import("../modules/project/project.model.js"),
    import("../modules/project/chat-session.model.js"),
    import("../modules/credits/credit-wallet.model.js")
  ])
  const { orderedSteps, getStep } = await import("../modules/pipeline/step-registry.js")
  const { runStep, submitAnswer } = await import("../modules/pipeline/step-runner.service.js")
  const { getPromptTemplate, interpolatePrompt } = await import("../shared/ai/prompt-registry.service.js")
  const { getActionCost } = await import("../shared/ai/credit-reservation.service.js")
  const { ActionType } = await import("../shared/ai/ai-action.types.js")
  const { createMemoryDiagramStore } = await import("../modules/diagram/diagram-file.store.js")

  const fixtureFile = options.fixture === "full" ? "spine-fixture-19-screens.json" : "spine-fixture-minimal.json"
  const fixture = spineSchema.parse(JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", fixtureFile), "utf8")))

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const user = await User.create({ email: `measure-${suffix}@flintflow.test`, password: "measure-password-123", name: "Measure", emailVerified: true })
  const project = await Project.create({ userId: user._id, name: `Measure ${fixtureFile}`, domain: fixture.project.domain })
  const session = await ChatSession.create({ projectId: project._id, messages: [], is_pipeline: true })
  await CreditWallet.create({ userId: user._id, balance: 1_000_000, reserved: 0 })
  const projectId = String(project._id)
  const userId = String(user._id)
  const sessionId = String(session._id)

  const placeholders = new Set(fixture.screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id))
  const all = orderedSteps(fixture)
  const runnable = all.filter((s) => !(s.loop !== null && placeholders.has(s.loop)))
  const stepOrder = (options.limitSteps === null ? runnable : runnable.slice(0, options.limitSteps)).map((s) => s.id)
  const loops = new Set(all.filter((s) => s.loop !== null).map((s) => s.loop)).size
  const shape = { screens: fixture.screens.length, functions: fixture.functions.length, loops, totalSteps: all.length }

  const records: CallRecord[] = []
  const renderStub = {
    store: createMemoryDiagramStore(),
    check: async () => ({ ok: true, method: "svg-scan", render: { format: "svg", data: Buffer.from("<svg/>"), contentType: "image/svg+xml", transport: "post", status: 200, diagnostics: {} } }),
    renderPng: async () => Buffer.from("png")
  }

  for (const [index, stepId] of stepOrder.entries()) {
    const step = getStep(stepId)
    const phase = phaseOf(stepId)
    const idx = all.findIndex((s) => s.id === stepId)

    // Spine cuối, mọi step trước accepted, step này pending
    const spine = structuredClone(fixture)
    spine.steps = all.slice(0, idx).map((s) => ({ id: s.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
    spine.progress.current_phase = step.phase
    spine.progress.current_step = stepId
    spine.progress.elicit_turns_this_phase = 0
    if (step.loop && step.loop !== "nonscreen") spine.progress.screen_cursor = step.loop
    await Promise.all([Spine.deleteMany({ projectId }), Change.deleteMany({ projectId }), Usage.deleteMany({ projectId })])
    await Spine.create({ projectId, ...spine })

    const promptTokens = async (actionType: string, variables: unknown): Promise<number> => {
      const template = await getPromptTemplate(actionType)
      return estimateTokens(interpolatePrompt(template.template, (variables ?? {}) as Record<string, unknown>))
    }
    const batchSize = (variables: Record<string, unknown>): number => {
      const projection = (variables.projection ?? {}) as Record<string, unknown>
      const key = Object.keys(projection).find((k) => k.startsWith("functions"))
      const list = key === undefined ? [] : projection[key]
      return Array.isArray(list) ? list.length : 0
    }
    const fakeResult = <T>(actionType: string, data: T, tokensIn: number, tokensOut: number, cost: number) => ({
      success: true as const,
      data,
      rawText: JSON.stringify(data),
      actionType: actionType as never,
      provider: "estimate",
      aiModel: "estimate",
      tokensUsed: { promptTokens: tokensIn, completionTokens: tokensOut, totalTokens: tokensIn + tokensOut },
      latencyMs: 0,
      logId: "",
      cost
    })

    type Deps = NonNullable<Parameters<typeof runStep>[5]>
    const deps: Deps = { renderDeps: renderStub as unknown as NonNullable<Deps["renderDeps"]> }

    if (options.mode === "estimate") {
      deps.draftExecutor = async (actionType, input) => {
        const vars = (input.promptVariables ?? {}) as Record<string, unknown>
        const tokensIn = await promptTokens(actionType, vars)
        const tokensOut = estimateDraftOut(step.template_id, batchSize(vars))
        const cost = await getActionCost(actionType)
        records.push({ step_id: stepId, phase, call_kind: "draft", tokens_in: tokensIn, tokens_out: tokensOut, credit: cost, measured: false })
        return fakeResult(actionType, { ops: [] }, tokensIn, tokensOut, cost) as never
      }
      deps.reviewExecutor = async (input) => {
        const tokensIn = await promptTokens(ActionType.REVIEW, input.promptVariables)
        const cost = await getActionCost(ActionType.REVIEW)
        records.push({ step_id: stepId, phase, call_kind: "review", tokens_in: tokensIn, tokens_out: estimateTokens('{"findings":[]}'), credit: cost, measured: false })
        return fakeResult(ActionType.REVIEW, { findings: [] }, tokensIn, 4, cost) as never
      }
    }
    if (options.mode !== "real") {
      deps.elicitExecutor = async (input) => {
        const data = { reply: "ok", questions: [] }
        const tokensIn = await promptTokens(ActionType.ELICIT, input.promptVariables)
        const tokensOut = estimateTokens(JSON.stringify(data))
        const cost = await getActionCost(ActionType.ELICIT)
        records.push({ step_id: stepId, phase, call_kind: "elicit", tokens_in: tokensIn, tokens_out: tokensOut, credit: cost, measured: false })
        return fakeResult(ActionType.ELICIT, data, tokensIn, tokensOut, cost) as never
      }
    }

    let error: string | undefined
    try {
      await runStep(projectId, stepId, sessionId, userId, (event) => {
        if (event.type === "answer_needed") {
          const answers = event.questions.map((q) => ({ question_id: q.id, answer: q.options?.[0] ?? AUTO_ANSWER }))
          setImmediate(() => submitAnswer(projectId, stepId, sessionId, answers))
        }
        if (event.type === "error") error = `${event.code}: ${event.message}`
      }, deps)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    if (options.mode !== "estimate") {
      // Lượt gọi provider thật: số lấy từ Usage mà meter ghi (không gồm lượt đã hoàn tiền)
      const usages = await Usage.find({ projectId, state: "deducted" }).lean()
      for (const u of usages) {
        const kind: CallKind = u.call_kind === "elicit" ? "elicit" : u.call_kind === "review" ? "review" : "draft"
        if (options.mode === "real-draft" && kind === "elicit") continue
        records.push({ step_id: stepId, phase, call_kind: kind, tokens_in: u.tokens_in, tokens_out: u.tokens_out, credit: u.cost, measured: true })
      }
    }
    if (error) {
      records.push({ step_id: stepId, phase, call_kind: "draft", tokens_in: 0, tokens_out: 0, credit: 0, measured: options.mode !== "estimate", error })
    }
    log(`[${index + 1}/${stepOrder.length}] ${stepId}${error ? ` — ${error}` : ""}`)
  }

  await Promise.all([
    Spine.deleteMany({ projectId }),
    Change.deleteMany({ projectId }),
    Usage.deleteMany({ projectId }),
    ChatSession.deleteMany({ projectId }),
    Project.deleteOne({ _id: projectId }),
    CreditWallet.deleteOne({ userId }),
    User.deleteOne({ _id: userId })
  ])
  return { records, stepOrder, shape }
}

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = new Date()

  // Dựng Mongo TRƯỚC khi nạp bất kỳ module app nào (env.ts đọc MONGO_URI một lần)
  let stop: (() => Promise<unknown>) | null = null
  let uri = options.mongoUri
  if (!uri) {
    const { MongoMemoryReplSet } = await import("mongodb-memory-server")
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } })
    uri = replSet.getUri("flintflow-measure")
    stop = () => replSet.stop()
  }
  process.env.MONGO_URI = uri
  if (options.mode === "estimate") process.env.PLANTUML_BASE_URL = "http://127.0.0.1:9"

  const { default: mongoose } = await import("mongoose")
  await mongoose.connect(uri)
  try {
    console.log(`measure-tokens: mode=${options.mode} fixture=${options.fixture}${options.mode === "estimate" ? "" : " — GỌI PROVIDER THẬT"}`)
    const result = await measure(options)
    const outPath = options.out ? path.resolve(ROOT, options.out) : null
    const existing = outPath && fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : ""
    const report = renderReport({ options, ...result, startedAt, durationMs: Date.now() - startedAt.getTime(), thresholds: parseThresholds(existing) })
    if (outPath) {
      fs.writeFileSync(outPath, upsertSection(existing || "# Measurements\n", report))
      console.log(`Đã ghi ${path.relative(ROOT, outPath)}`)
    } else {
      console.log(report)
    }
  } finally {
    await mongoose.disconnect()
    if (stop) await stop()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("🔴 measure-tokens lỗi:", err)
      process.exit(1)
    }
  )
}
