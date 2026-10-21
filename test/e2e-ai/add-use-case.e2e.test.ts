/**
 * add-use-case.e2e (FLF-311) — lệnh "thêm use case" qua chat với PROVIDER THẬT. Chỉ chạy khi `E2E_AI=1`
 * (`npm run test:e2e-ai -- test/e2e-ai/add-use-case.e2e.test.ts`).
 *
 * Đo model có soạn đủ lô theo luật 3e/3f của `apply-change-op` (chế độ `full`, fixture 19 màn đã qua S-5 và S-7.3):
 *   1. bản xem trước `ok`, qua schema + 8 bất biến, không còn cảnh báo thiếu chức năng / màn (FLF-298);
 *   2. use case mới gắn chức năng mới có đủ Functional Requirements (trigger, mô tả, normal, abnormal, validations);
 *   3. màn mới nằm trong Screens Flow (không mồ côi), có phân quyền cho vai trò của actor;
 *   4. luồng bất thường có thông báo (§ Messages).
 * Vẽ sơ đồ dùng dep giả (không cần PlantUML). Kết quả ghi `test/e2e-ai/results/add-use-case-<ISO>.md`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { seedFixture } from "../setup.js"

const enabled = process.env.E2E_AI === "1"
const INSTRUCTION =
  'Thêm use case mới "Share Read-Only Link": Business Analyst tạo một đường link chỉ-đọc của tài liệu SRS để gửi stakeholder xem, có thể đặt hạn dùng và thu hồi link.'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, "results")

describe.skipIf(!enabled)("Thêm use case kéo theo đủ phần liên quan — provider thật (E2E_AI=1)", () => {
  it("một bản xem trước đủ UC + chức năng + màn + luồng + phân quyền + thông báo", { timeout: 15 * 60_000 }, async () => {
    const changeService = await import("../../src/modules/spine/change.service.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const { orphanScreens } = await import("../../src/modules/spine/deterministic-check.js")
    type Spine = import("../../src/modules/spine/spine.types.js").Spine

    const { projectId, userId } = await seedFixture("full", { balance: 5000 })
    const before = (await repo.get(projectId))!
    const rendered: string[][] = []
    // Ghi lại output thô của model (bản xem trước bị từ chối trả `ops: []`) và token của từng lượt gọi
    const calls: { ops: unknown; clarification?: string; tokens: number }[] = []
    const real = changeService.defaultChangeDeps().changeExecutor
    const deps = {
      renderAfterChange: async (_p: string, _u: string, ids: string[]) => void rendered.push(ids),
      changeExecutor: (async (...args: Parameters<typeof real>) => {
        const result = await real(...args)
        calls.push({ ops: result.data.ops ?? [], clarification: result.data.clarification_needed, tokens: result.tokensUsed?.totalTokens ?? 0 })
        return result
      }) as typeof real
    }

    const started = Date.now()
    const shown = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction: INSTRUCTION }, {}, deps)
    const previewMs = Date.now() - started

    const lines: string[] = [`# Thêm use case — provider thật (${new Date().toISOString()})`, "", `Lệnh: ${INSTRUCTION}`, ""]
    lines.push(`- preview: ok=${shown.ok}, ${shown.changes.length} thay đổi, ${previewMs} ms`)
    if (shown.clarification) lines.push(`- câu hỏi làm rõ: ${shown.clarification}`)
    if (shown.violations.length) lines.push(`- vi phạm: ${JSON.stringify(shown.violations)}`)
    if (shown.notes) lines.push(`- notes: ${shown.notes.replace(/\n/g, " / ")}`)
    lines.push("", "Op của lô:", "", ...shown.ops.map((o) => `- \`${o.op} ${o.path}\``), "")

    const checks: [string, boolean][] = []
    let spine: Spine | null = null
    if (shown.ok && shown.preview_id) {
      const applied = await changeService.apply(projectId, userId, { base_version: before.spine_version, instruction: INSTRUCTION, preview_id: shown.preview_id }, {}, deps)
      spine = applied.spine as Spine
      const newUcs = spine.use_cases.filter((u) => !before.use_cases.some((b) => b.id === u.id))
      const newFns = spine.functions.filter((f) => !before.functions.some((b) => b.id === f.id))
      const newScreens = spine.screens.filter((s) => !before.screens.some((b) => b.id === s.id))
      const fn = newFns.find((f) => f.screen_id !== null) ?? newFns[0]
      // Hai cách đúng (ticket mục 7): màn MỚI cho use case, hoặc gắn chức năng vào màn CÓ SẴN mà actor dùng được
      const screen = spine.screens.find((s) => s.id === fn?.screen_id)
      const isNewScreen = Boolean(screen && newScreens.some((s) => s.id === screen.id))
      const roleIds = spine.roles.filter((r) => newUcs[0]?.actor_ids.includes(r.actor_id ?? "")).map((r) => r.id)
      const orphan = new Set(orphanScreens(spine).map((o) => o.screen.id))
      lines.push(`- màn của chức năng: ${screen ? `${screen.id} ${screen.name} (${isNewScreen ? "mới" : "có sẵn"})` : "không có"}`, "")
      checks.push(
        ["có đúng 1 use case mới", newUcs.length === 1],
        ["use case gắn chức năng mới", Boolean(fn && newUcs[0]?.function_ids.includes(fn.id))],
        ["chức năng có trigger + mô tả", Boolean(fn?.trigger.trim() && fn?.description.trim())],
        ["chức năng có luồng thường", (fn?.normal.length ?? 0) > 0],
        ["chức năng có luồng bất thường", (fn?.abnormal.length ?? 0) > 0],
        ["chức năng có validation (có id)", (fn?.validations.length ?? 0) > 0 && fn!.validations.every((v) => v.id.startsWith(`${fn!.id}-V`))],
        ["chức năng thuộc một màn (mới hoặc có sẵn)", Boolean(screen)],
        ["màn nằm trong Screens Flow (không mồ côi)", Boolean(screen && !orphan.has(screen.id))],
        ["vai trò của actor có quyền trên màn", Boolean(screen && spine.permissions.some((p) => p.screen_id === screen.id && roleIds.includes(p.role_id)))],
        ["luồng bất thường có thông báo", Boolean(fn && spine.messages.some((m) => m.function_ids.includes(fn.id)))],
        ["không còn cảnh báo thiếu (FLF-298)", !/chưa gắn chức năng|chưa có màn hình/.test(shown.notes ?? "")],
        ["màn mới ⇒ vẽ bố cục sau khi áp", !isNewScreen || rendered.some((ids) => ids.includes(screen!.id))]
      )
      if (fn) lines.push("Chức năng mới:", "", "```json", JSON.stringify(fn, null, 2), "```", "")
      if (screen) lines.push("Màn mới:", "", "```json", JSON.stringify(screen, null, 2), "```", "")
    } else {
      checks.push(["bản xem trước ok", false])
    }

    const tokens = calls.reduce((n, c) => n + c.tokens, 0)
    const passed = checks.filter(([, ok]) => ok).length
    lines.push(`Kết quả: ${passed}/${checks.length} tiêu chí, ${calls.length} lượt gọi model, ${tokens} token`, "", ...checks.map(([name, ok]) => `- [${ok ? "x" : " "}] ${name}`), "")
    calls.forEach((c, i) => lines.push(`Output thô lượt ${i + 1}:`, "", "```json", JSON.stringify(c.clarification ? { clarification_needed: c.clarification } : c.ops, null, 2), "```", ""))

    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    fs.writeFileSync(path.join(OUT_DIR, `add-use-case-${stamp}.md`), lines.join("\n"))
    console.log(lines.join("\n"))

    expect(checks.filter(([, ok]) => !ok).map(([name]) => name)).toEqual([])
  })
})

describe.skipIf(enabled)("Thêm use case kéo theo đủ phần liên quan — provider thật", () => {
  it.skip("bỏ qua: đặt E2E_AI=1 để gọi provider thật (tốn credit)", () => {})
})
