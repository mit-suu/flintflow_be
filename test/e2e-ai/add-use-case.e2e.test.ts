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
  'Thêm use case mới "Share Read-Only Link": Business Analyst tạo một đường link chỉ-đọc của tài liệu SRS để gửi stakeholder xem, có thể đặt hạn dùng và thu hồi link. Làm màn hình riêng.'

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

/**
 * FAP thật (dữ liệu dev, không commit): `E2E_AI=1 E2E_FAP_SPINE=<file Spine JSON>`. Hai ca người dùng gặp ngày 21/10:
 *   A. use case chồng mục tiêu với use case có sẵn (Suspend Student Account ~ UC20 Deactivate Student Record) ⇒ model hỏi lại,
 *      hoặc ít nhất bản xem trước cảnh báo trùng;
 *   B. use case có tương tác riêng ⇒ màn riêng nối vào Screens Flow (không gắn lặng lẽ vào màn có sẵn).
 */
const fapSpine = process.env.E2E_FAP_SPINE
const fapLog = (line: string): void => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.appendFileSync(path.join(OUT_DIR, `add-use-case-fap-${new Date().toISOString().slice(0, 10)}.md`), `${line}
`)
  console.log(line)
}
describe.skipIf(!enabled || !fapSpine)("FAP thật — kiểm trùng use case + màn riêng (E2E_FAP_SPINE)", () => {
  const CR = { requester: "Phòng đào tạo", source: { kind: "verbal" as const, ref: null } }

  const seedFap = async () =>
    seedFixture("full", {
      balance: 5000,
      mutate: (raw) => {
        // Bản xuất từ Mongo còn field của Mongoose — schema Spine strict không nhận
        const { __v: _v, createdAt: _c, updatedAt: _u, ...fap } = JSON.parse(fs.readFileSync(fapSpine!, "utf8")) as Record<string, unknown>
        for (const key of Object.keys(raw)) delete (raw as Record<string, unknown>)[key]
        Object.assign(raw, fap)
      }
    })

  it("A. Suspend Student Account trùng UC20 Deactivate Student Record ⇒ hỏi lại hoặc cảnh báo", { timeout: 10 * 60_000 }, async () => {
    const changeService = await import("../../src/modules/spine/change.service.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const { projectId, userId } = await seedFap()
    const before = (await repo.get(projectId))!
    const instruction = "thêm use case Suspend Student Account — Phòng quản lý đào tạo khóa tài khoản đăng nhập của sinh viên; chỉ Phòng quản lý đào tạo mở khóa thủ công"
    const shown = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction, change_request: CR }, {}, { renderAfterChange: async () => undefined })
    // Chưa nói màn hay popup ⇒ hỏi trước (FLF-311); hoặc đã soạn thì bản xem trước phải cảnh báo trùng UC20
    const asked = Boolean(shown.clarification)
    const warned = /UC20|Deactivate Student Record/.test(shown.notes ?? "")
    fapLog(`[FAP A] ok=${shown.ok} violations=${JSON.stringify(shown.violations)}`)
    fapLog(`[FAP A] clarification=${shown.clarification ?? "-"}\n[FAP A] notes=${shown.notes ?? "-"}\n[FAP A] ops=${shown.ops.map((o) => `${o.op} ${o.path}`).join(" | ")}`)
    expect(asked || warned, "phải hỏi lại trước khi soạn, hoặc bản xem trước phải cảnh báo trùng UC20").toBe(true)
  })

  it("B. Request Grade Review (sinh viên gửi phúc khảo kèm lý do) ⇒ màn riêng trong Screens Flow", { timeout: 10 * 60_000 }, async () => {
    const changeService = await import("../../src/modules/spine/change.service.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const { orphanScreens } = await import("../../src/modules/spine/deterministic-check.js")
    const { projectId, userId } = await seedFap()
    const before = (await repo.get(projectId))!
    const instruction = "Thêm use case mới Request Grade Review: sinh viên gửi yêu cầu phúc khảo điểm một môn, ghi lý do; Phòng khảo thí nhận yêu cầu. Dạng popup."
    // E2E_REAL_RENDER=1 ⇒ vẽ thật sau khi áp (PlantUML ở PLANTUML_BASE_URL + model vẽ wireframe), không thay bằng hàm giả
    const realRender = process.env.E2E_REAL_RENDER === "1"
    // test/setup.ts cố ý trỏ PlantUML vào cổng chết ⇒ vẽ thật phải lấy lại địa chỉ server trong .env
    if (realRender) {
      const { parse } = await import("dotenv")
      const url = parse(fs.readFileSync(path.resolve(__dirname, "../../.env"))).PLANTUML_BASE_URL
      // `env` của app parse một lần lúc import ⇒ sửa thẳng object đó, đổi process.env không có tác dụng
      const { env } = await import("../../src/config/env.js")
      if (url) Object.assign(env, { PLANTUML_BASE_URL: url, PLANTUML_TIMEOUT_MS: 30000 })
    }
    const deps = realRender ? {} : { renderAfterChange: async () => undefined }
    const shown = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction }, {}, deps)
    fapLog(`[FAP B] ok=${shown.ok} clarification=${shown.clarification ?? "-"}\n[FAP B] notes=${shown.notes ?? "-"}\n[FAP B] ops=${shown.ops.map((o) => `${o.op} ${o.path}`).join(" | ")}`)
    expect(shown.ok, JSON.stringify(shown.violations)).toBe(true)
    const applied = await changeService.apply(projectId, userId, { base_version: before.spine_version, instruction, preview_id: shown.preview_id, reason: "Phúc khảo điểm", change_request: CR }, {}, deps)
    const spine = applied.spine as import("../../src/modules/spine/spine.types.js").Spine
    const newScreens = spine.screens.filter((s) => !before.screens.some((b) => b.id === s.id))
    const orphan = new Set(orphanScreens(spine).map((o) => o.screen.id))
    fapLog(`[FAP B] màn mới: ${newScreens.map((s) => `${s.id} ${s.name} popup=${s.is_popup} từ ${spine.screens.filter((x) => x.flow_to.includes(s.id)).map((x) => x.id)}`).join("; ") || "không"} | cr=${applied.cr_id}`)
    expect(newScreens.length).toBeGreaterThan(0)
    expect(newScreens.every((s) => !orphan.has(s.id))).toBe(true)
    if (realRender) {
      const after = (await repo.get(projectId))!
      for (const s of newScreens) {
        const layout = after.diagrams.find((d) => d.kind === "screen_layout" && d.owner_id === s.id)
        fapLog(`[FAP B] bố cục ${s.id}: ${layout ? `${layout.id} ${layout.render_status}${layout.error ? ` (${layout.error})` : ""}` : "KHÔNG CÓ"}`)
        if (layout) fapLog("```\n" + layout.puml + "\n```")
        expect(layout?.render_status).toBe("ok")
      }
      const flow = after.diagrams.filter((d) => d.kind === "screen_flow")
      fapLog(`[FAP B] screen flow: ${flow.map((d) => `${d.id} ${d.render_status}${d.puml.includes(newScreens[0].name) ? " (có màn mới)" : ""}`).join(", ")}`)
      expect(flow.some((d) => d.puml.includes(newScreens[0].name))).toBe(true)
    }
  })

  it("E. FLF-318 — 'thêm UC phúc khảo điểm cho học sinh' ⇒ hỏi ai xử lý / đề xuất UC xử lý; trả lời xong lô có đủ luồng (không cụt)", { timeout: 15 * 60_000 }, async () => {
    const changeService = await import("../../src/modules/spine/change.service.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const { projectId, userId } = await seedFap()
    const before = (await repo.get(projectId))!
    const deps = { renderAfterChange: async () => undefined }
    const first = "thêm UC phúc khảo điểm cho học sinh"
    const asked = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction: first }, {}, deps)
    fapLog(`[FAP E] lượt 1: clarification=${asked.clarification ?? "-"} | choices=${JSON.stringify(asked.clarification_choices ?? [])}`)
    // Người dùng chỉ nói phía sinh viên ⇒ phải hỏi ai xử lý, hoặc đưa UC xử lý vào nhóm "AI đề xuất thêm" để giữ / bỏ
    expect(asked.clarification).toBeTruthy()
    expect(asked.clarification).toMatch(/xử lý|duyệt|chấm lại|đề xuất|Decide|Approve|Lecturer|Giảng viên|Academic|khảo thí/i)

    // Trả lời tối đa 3 lượt: chọn "cả hai theo thứ tự" nếu có, màn riêng cho từng use case, giữ các use case AI đề xuất
    let history = `User: ${first}\nAI: ${asked.clarification}`
    let shown = asked
    for (let round = 1; round <= 3 && shown.clarification; round++) {
      const choices = shown.clarification_choices ?? []
      const pick = choices.find((c) => /rồi|cả hai|both|then/i.test(c)) ?? choices.find((c) => /riêng|own|separate/i.test(c))
      const answer = `${pick ? `${pick}. ` : ""}Màn hình riêng cho từng use case, giữ các use case AI đề xuất.`
      shown = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction: answer, chat_history: history, clarification_rounds: round }, {}, deps)
      fapLog(`[FAP E] lượt ${round + 1} (${answer}): ok=${shown.ok} clarification=${shown.clarification ?? "-"}`)
      history += `\nUser: ${answer}${shown.clarification ? `\nAI: ${shown.clarification}` : ""}`
    }
    expect(shown.ok, JSON.stringify(shown.violations)).toBe(true)
    const ucs = shown.ops.filter((o) => o.op === "add" && o.path === "use_cases[]").map((o) => o.value as { name: string; actor_ids: string[] })
    fapLog(`[FAP E] use case mới: ${ucs.map((u) => `${u.name} (${u.actor_ids.join(",")})`).join("; ")}`)
    // Không cụt: ngoài use case của sinh viên còn ít nhất một use case của actor khác xử lý yêu cầu
    const studentIds = new Set(ucs[0]?.actor_ids ?? [])
    expect(ucs.length).toBeGreaterThanOrEqual(2)
    expect(ucs.some((u) => u.actor_ids.some((a) => !studentIds.has(a)))).toBe(true)
  })

  // Cần Spine FAP đã có luồng phúc khảo (Request / Decide / Approve / View Status) — bỏ qua khi không có
  it("F. FLF-318 — 'xoá UC phúc khảo điểm' ⇒ hỏi trước về use case cùng luồng; 'Xoá cả luồng' ⇒ xoá 4 UC + chức năng + màn, không sót", { timeout: 15 * 60_000 }, async (ctx) => {
    const changeService = await import("../../src/modules/spine/change.service.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const { removalLeftovers } = await import("../../src/modules/spine/use-case-propagation.js")
    const { projectId, userId } = await seedFap()
    const before = (await repo.get(projectId))!
    const flow = before.use_cases.filter((u) => /grade review/i.test(u.name))
    if (flow.length < 2) return ctx.skip()
    const deps = { renderAfterChange: async () => undefined }
    const first = "xoá UC phúc khảo điểm"
    const asked = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction: first }, {}, deps)
    fapLog(`[FAP F] lượt 1: clarification=${asked.clarification ?? "-"} | choices=${JSON.stringify(asked.clarification_choices ?? [])}`)
    expect(asked.clarification, "phải hỏi trước khi xoá các use case cùng luồng").toBeTruthy()

    const pick = asked.clarification_choices?.find((c) => /cả luồng|whole flow|toàn bộ/i.test(c)) ?? "Xoá cả luồng phúc khảo"
    const shown = await changeService.preview(
      projectId,
      userId,
      { base_version: before.spine_version, instruction: pick, chat_history: `User: ${first}\nAI: ${asked.clarification}`, clarification_rounds: 1 },
      {},
      deps
    )
    fapLog(`[FAP F] lượt 2 (${pick}): ok=${shown.ok} clarification=${shown.clarification ?? "-"} | notes=${shown.notes ?? "-"}\n[FAP F] ops=${shown.ops.map((o) => `${o.op} ${o.path}`).join(" | ")}`)
    expect(shown.ok, JSON.stringify(shown.violations)).toBe(true)
    const removed = (prefix: string) => shown.ops.filter((o) => o.op === "remove" && o.path.startsWith(prefix)).length
    expect(removed("use_cases[")).toBe(flow.length)
    const applied = await changeService.apply(projectId, userId, { base_version: before.spine_version, instruction: pick, preview_id: shown.preview_id }, {}, deps)
    const after = applied.spine as import("../../src/modules/spine/spine.types.js").Spine
    const left = removalLeftovers(before, after)
    fapLog(`[FAP F] sau khi áp: ${after.use_cases.length} UC, ${after.functions.length} chức năng, ${after.screens.length} màn · còn sót: ${JSON.stringify(left)}`)
    expect(after.use_cases.some((u) => /grade review/i.test(u.name))).toBe(false)
    expect(left).toEqual([])
  })

  /** Dự án FAP đã Lead ký baseline ⇒ chuyển sang luồng CR (FLF-318), rồi một CR chạy tới bước làm rõ C-2. */
  const crClarifyQuestions = async (description: string): Promise<string[]> => {
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const { signOff } = await import("../../src/modules/pipeline/s9/baseline.service.js")
    const { convertFromFpt } = await import("../../src/modules/import/convert-from-fpt.service.js")
    const { createCr } = await import("../../src/modules/change-request/change-request.service.js")
    const { runClarify } = await import("../../src/modules/change-request/clarify.service.js")
    const { projectId, userId } = await seedFap()
    await signOff(projectId, userId, { base_version: (await repo.get(projectId))!.spine_version })
    expect(await convertFromFpt(projectId, userId, { quiet: true })).not.toBeNull()
    const cr = await createCr(projectId, userId, { title: description, description, source: { kind: "verbal", ref: null, note: null }, requester: "Phòng đào tạo" })
    await runClarify(cr, userId)
    return cr.clarifications.at(-1)?.questions ?? []
  }

  it("G. FLF-318 — CR 'thêm UC phúc khảo điểm cho học sinh' ⇒ bước làm rõ hỏi ai xử lý (như chat trước baseline)", { timeout: 15 * 60_000 }, async () => {
    const questions = await crClarifyQuestions("thêm UC phúc khảo điểm cho học sinh")
    fapLog(`[FAP G] câu hỏi C-2: ${JSON.stringify(questions)}`)
    expect(questions.join("\n")).toMatch(/xử lý|duyệt|chấm lại|giảng viên|lecturer|academic|phòng/i)
  })

  it("H. FLF-318 — CR 'xoá UC phúc khảo điểm' ⇒ bước làm rõ hỏi có xoá cả luồng không (như chat trước baseline)", { timeout: 15 * 60_000 }, async (ctx) => {
    const flow = (JSON.parse(fs.readFileSync(fapSpine!, "utf8")) as { use_cases: { name: string }[] }).use_cases.filter((u) => /grade review/i.test(u.name))
    if (flow.length < 2) return ctx.skip()
    const questions = await crClarifyQuestions("xoá UC phúc khảo điểm")
    fapLog(`[FAP H] câu hỏi C-2: ${JSON.stringify(questions)}`)
    expect(questions.join("\n")).toMatch(/luồng|Decide|Approve|View Grade Review Status|cả/i)
  })

  it("I. FLF-318 — sau baseline: bản xem trước 'thêm UC phúc khảo điểm' (vòng hỏi đáp như trước baseline) ⇒ Tạo CR kèm preview_id ⇒ đề xuất dùng đúng lô ⇒ BA xác nhận ghi 1.1 đủ luồng", { timeout: 25 * 60_000 }, async () => {
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const changeService = await import("../../src/modules/spine/change.service.js")
    const { signOff } = await import("../../src/modules/pipeline/s9/baseline.service.js")
    const { convertFromFpt } = await import("../../src/modules/import/convert-from-fpt.service.js")
    const { mode1Api } = await import("../helpers/mode1.js")
    const seeded = await seedFap()
    const { projectId, userId } = seeded
    await signOff(projectId, userId, { base_version: (await repo.get(projectId))!.spine_version })
    expect(await convertFromFpt(projectId, userId, { quiet: true })).not.toBeNull()
    const before = (await repo.get(projectId))!
    const deps = { renderAfterChange: async () => undefined }

    // Vòng hỏi đáp như chat trước baseline (FE mode 1 đưa lệnh thêm UC qua /changes/preview)
    const turns = ["thêm UC phúc khảo điểm cho học sinh"]
    let history = ""
    let shown = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction: turns[0] }, {}, deps)
    for (let round = 1; round <= 3 && shown.clarification; round++) {
      fapLog(`[FAP I] hỏi ${round}: ${shown.clarification} | ${JSON.stringify(shown.clarification_choices ?? [])}`)
      history += `${history ? "\n" : ""}User: ${turns[turns.length - 1]}\nAI: ${shown.clarification}`
      const choices = shown.clarification_choices ?? []
      const pick = choices.find((c) => /rồi|cả hai|both|then/i.test(c)) ?? choices.find((c) => /riêng|own|separate/i.test(c))
      const answer = `${pick ? `${pick}. ` : ""}Màn hình riêng cho từng use case, giữ các use case AI đề xuất.`
      turns.push(answer)
      shown = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction: answer, chat_history: history, clarification_rounds: round }, {}, deps)
    }
    expect(shown.ok, JSON.stringify(shown.violations)).toBe(true)
    const previewedUcs = shown.ops.filter((o) => o.op === "add" && o.path === "use_cases[]").length
    fapLog(`[FAP I] bản xem trước: ${shown.ops.length} op, ${previewedUcs} use case mới`)
    expect(previewedUcs).toBeGreaterThanOrEqual(2)

    // "Tạo change request" — CR mang bản xem trước + đoạn hỏi đáp làm mô tả (như FE `startFromPreview`)
    const c = mode1Api(seeded, projectId)
    const description = `${turns[0]}\n\nTrả lời làm rõ:\n${turns.slice(1).map((t) => `- ${t}`).join("\n")}`
    const created = await c.post("/change-requests", { title: turns[0], description, source: { kind: "verbal", ref: null, note: "Tạo từ bản xem trước trong khung chat" }, requester: "Phòng đào tạo", preview_id: shown.preview_id })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const crId = created.body.data.change_request.cr_id as string
    const cr = `/change-requests/${crId}`
    let last: { change_request: { status: string; result_doc_version: string | null }; pending_questions?: string[] } | null = null
    for (const step of ["clarify", "impact", "propose", "verify", "submit"]) {
      const r = await c.post(`${cr}/${step}`)
      fapLog(`[FAP I] ${step}: ${r.status} ${r.body.data?.change_request?.status ?? JSON.stringify(r.body.error)}`)
      expect(r.status, `${step}: ${JSON.stringify(r.body.error)}`).toBe(200)
      last = r.body.data
      // Bước làm rõ không được hỏi lại điều đã chốt trong bản xem trước
      if (step === "clarify") expect(last?.change_request.status, `C-2 hỏi lại: ${JSON.stringify(last?.pending_questions)}`).not.toBe("awaiting_answers")
    }
    expect(last?.change_request).toMatchObject({ status: "written", result_doc_version: "1.1" })
    const after = (await repo.get(projectId))!
    const added = after.use_cases.filter((u) => !before.use_cases.some((b) => b.id === u.id))
    fapLog(`[FAP I] ghi 1.1: ${added.map((u) => `${u.name} (${u.actor_ids.join(",")})`).join("; ")}`)
    expect(added.length).toBe(previewedUcs)
    expect(new Set(added.flatMap((u) => u.actor_ids)).size).toBeGreaterThanOrEqual(2)
    for (const u of added) for (const fnId of u.function_ids) expect(after.functions.some((f) => f.id === fnId)).toBe(true)
  })

  it("C. chưa nói màn hay popup ⇒ hỏi kèm lựa chọn; trả lời 'Popup mở từ My Grades' ⇒ lô có popup mở từ My Grades", { timeout: 10 * 60_000 }, async () => {
    const changeService = await import("../../src/modules/spine/change.service.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")
    const { projectId, userId } = await seedFap()
    const before = (await repo.get(projectId))!
    const deps = { renderAfterChange: async () => undefined }
    const first = "Thêm use case mới Request Grade Review: sinh viên gửi yêu cầu phúc khảo điểm một môn, ghi lý do"
    const asked = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction: first }, {}, deps)
    fapLog(`[FAP C] lượt 1: clarification=${asked.clarification ?? "-"} | choices=${JSON.stringify(asked.clarification_choices ?? [])}`)
    expect(asked.clarification).toBeTruthy()

    const popupChoice = asked.clarification_choices?.find((c) => /popup/i.test(c)) ?? "Popup"
    const history = `User: ${first}\nAI: ${asked.clarification}`
    const answer = `${popupChoice}. Sinh viên chọn môn và nhập lý do, tối đa 500 ký tự.`
    const shown = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction: answer, chat_history: history, clarification_rounds: 1 }, {}, deps)
    fapLog(`[FAP C] lượt 2 (${answer}): ok=${shown.ok} clarification=${shown.clarification ?? "-"} | ops=${shown.ops.map((o) => `${o.op} ${o.path}`).join(" | ")}`)
    expect(shown.ok, JSON.stringify(shown.violations)).toBe(true)
    const screen = shown.ops.find((o) => o.op === "add" && o.path === "screens[]")?.value as { name?: string; is_popup?: boolean } | undefined
    fapLog(`[FAP C] màn mới: ${screen ? `${screen.name} popup=${screen.is_popup}` : "không"}`)
    expect(screen?.is_popup).toBe(true)
  })

  it("D. trọn luồng sửa sau baseline: thêm UC (popup) ⇒ CR ⇒ Viết lại các mục cũ ⇒ hết cờ đỏ ⇒ Lead chốt baseline mới", { timeout: 20 * 60_000 }, async () => {
    const changeService = await import("../../src/modules/spine/change.service.js")
    const { reconcile, isReconcileApplied } = await import("../../src/modules/spine/reconcile.service.js")
    const { signOff, blockingFlags } = await import("../../src/modules/pipeline/s9/baseline.service.js")
    const flagsService = await import("../../src/modules/spine/flags.service.js")
    const repo = await import("../../src/modules/spine/spine.repository.js")
    // PlantUML thật: không vẽ lại được thì cờ đỏ diagram_stale chặn chốt baseline như ngoài app
    const { parse } = await import("dotenv")
    const url = parse(fs.readFileSync(path.resolve(__dirname, "../../.env"))).PLANTUML_BASE_URL
    const { env } = await import("../../src/config/env.js")
    if (url) Object.assign(env, { PLANTUML_BASE_URL: url, PLANTUML_TIMEOUT_MS: 30000 })

    const { projectId, userId } = await seedFap()
    const before = (await repo.get(projectId))!
    const step = (line: string) => fapLog(`[FAP D] ${line}`)
    step(`bắt đầu: v${before.spine_version}, baseline ${before.baselines.map((b) => b.version).join(", ")}`)

    // 1–2. thêm UC dạng popup, áp kèm CR
    const instruction = "Thêm use case mới Request Grade Review: sinh viên gửi yêu cầu phúc khảo điểm một môn, ghi lý do; Phòng khảo thí xử lý. Dạng popup."
    const shown = await changeService.preview(projectId, userId, { base_version: before.spine_version, instruction }, {}, {})
    step(`xem trước: ok=${shown.ok}, ${shown.changes.length} thay đổi${shown.clarification ? `, hỏi: ${shown.clarification}` : ""}`)
    expect(shown.ok, JSON.stringify(shown.violations)).toBe(true)
    const applied = await changeService.apply(projectId, userId, { base_version: before.spine_version, instruction, preview_id: shown.preview_id, reason: "Phúc khảo điểm", change_request: CR }, {}, {})
    step(`áp dụng: ${applied.cr_id}, v${applied.spine_version}`)
    expect(applied.cr_id).toMatch(/^CR-\d{3}$/)

    // 3. Viết lại (hoà giải) tới khi không còn mục cũ — tối đa 3 vòng
    for (let round = 1; round <= 3; round++) {
      const rec = (await repo.get(projectId))!
      const planned = await reconcile(projectId, userId, { base_version: rec.spine_version }, { name: "FAP" })
      if (isReconcileApplied(planned)) throw new Error("hoà giải không có preview_id phải ra bản xem trước")
      step(`viết lại vòng ${round}: ok=${planned.ok}, ${planned.changes.length} thay đổi, no_change=${planned.no_change ?? false}${planned.violations.length ? `, vi phạm ${JSON.stringify(planned.violations)}` : ""}`)
      expect(planned.ok, JSON.stringify(planned.violations)).toBe(true)
      if (!planned.preview_id) break
      const done = await reconcile(projectId, userId, { base_version: rec.spine_version, preview_id: planned.preview_id }, { name: "FAP" })
      step(`  áp vòng ${round}: v${(done as { spine_version: number }).spine_version}`)
    }

    // 4. cờ đỏ
    await flagsService.recompute(projectId, { by: userId })
    const ready = (await repo.get(projectId))!
    const blocking = blockingFlags(ready)
    step(`cờ đỏ chặn chốt: ${blocking.length ? blocking.map((f) => `${f.rule_id}:${f.section_id}`).join(", ") : "không còn"}`)

    // 5. Lead chốt baseline mới
    if (blocking.length === 0) {
      const signed = await signOff(projectId, userId, { base_version: ready.spine_version })
      step(`chốt baseline: ${signed.baseline.version} (v${signed.spine_version})`)
      const after = (await repo.get(projectId))!
      expect(after.baselines.length).toBe(before.baselines.length + 1)
    }
    expect(blocking).toEqual([])
  })
})

