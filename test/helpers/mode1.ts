/**
 * Helper test mode 1 (FLF-171): tạo project mode import, client HTTP, provider giả trả output đúng schema
 * của các ActionType mode 1 theo nội dung prompt.
 */
import request from "supertest"
import { expect } from "vitest"
import app from "../../src/app.js"
import type { SeededFixture } from "../setup.js"

export const createMode1Project = async (seeded: SeededFixture, name = "Lumen import"): Promise<string> => {
  const res = await request(app).post("/api/v1/projects").set("Authorization", `Bearer ${seeded.token}`).send({ name, mode: "import" })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return String(res.body.data._id)
}

export const mode1Api = (seeded: SeededFixture, projectId: string) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${projectId}`
  return {
    base,
    upload: (buf: Buffer, name = "SRS_Lumen.docx", path = "/import") => request(app).post(`${base}${path}`).set(auth).attach("file", buf, name),
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    patch: (suffix: string, body: object) => request(app).patch(`${base}${suffix}`).set(auth).send(body),
    spineVersion: async () => (await request(app).get(`${base}/spine`).set(auth)).body.data.spine_version as number,
    /**
     * I-4 chạy nền: gọi `/import/extract` (hoặc `/import/resume`) rồi **chờ đúng job** của import đó
     * (`waitForExtraction`) thay vì chờ theo đồng hồ — máy tải nặng (chạy cả suite song song) không còn làm test
     * trượt vì hết hạn poll. Job chạy xong / dừng mới đọc `GET /import`; poll chỉ còn là lưới an toàn cho trường
     * hợp job không nằm trong tiến trình này. `run` có hình `extractResponseSchema` (import + sections).
     */
    extractAndWait: async (importId: string, path = "/import/extract", timeoutMs = 60_000) => {
      const res = await request(app).post(`${base}${path}`).set(auth).send({ import_id: importId })
      if (res.status !== 200) return { res, run: null }
      const { waitForExtraction } = await import("../../src/modules/import/extract-jobs.js")
      await waitForExtraction(importId)
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const view = (await request(app).get(`${base}/import`).set(auth)).body.data
        if (view.import.status !== "extracting" || view.import.paused) return { res, run: { import: view.import, sections: view.extraction.sections } }
        if (Date.now() >= deadline) throw new Error("I-4 chạy nền quá lâu")
        await new Promise((r) => setTimeout(r, 25))
      }
    }
  }
}

const firstBlock = (prompt: string, after: string): string => {
  const tail = prompt.slice(prompt.indexOf(after))
  return /\[(B\d{4,})\]/.exec(tail)?.[1] ?? "B0001"
}

/** Output I-4 giả theo section trong prompt (khớp `makeSrsDocx`). */
export const fakeImportExtract = (prompt: string): string | undefined => {
  if (!prompt.includes("# Import Extract")) return undefined
  const section = /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "fixed:1"
  const b = firstBlock(prompt, "Blocks of the section")
  const item = (entity: string, key: string | null, value: object, confidence = 0.9, field_confidence: object = {}) => ({
    entity,
    key,
    value,
    confidence,
    field_confidence,
    source_block_ids: [b]
  })
  let items: object[] = []
  if (section === "fixed:1") items = [item("project", null, { vision: "Lumen is an online learning platform for small training centers." })]
  else if (section === "fixed:2.2.1") items = [item("use_cases", "UC-02", { name: "Log in", actor_ids: ["Learner"] })]
  else if (section === "fixed:3.1.2") items = [item("screens", "SCR-01", { name: "Login screen", description: "Lets the learner sign in." })]
  else if (section === "fixed:4.2.3")
    items = [item("nfrs", "NFR-01", { statement: "The system shall respond within 2 seconds for 95% of requests.", kind: "quantitative", metric: "response time", threshold: "2 s" })]
  else if (section.startsWith("function:"))
    items = [item("functions", null, { trigger: "Learner submits the form", normal: ["Enter email", "Submit"], abnormal: ["Wrong password"] }, 0.85, { trigger: 0.5 })]
  return JSON.stringify({ section_id: section, items, unmapped_block_ids: [] })
}

export const fakeSemanticCheck = (prompt: string): string | undefined => {
  if (!prompt.includes("# Import Semantic Check")) return undefined
  const b = /\[(B\d{4,})\] \(fixed:4\.2\.3\)/.exec(prompt)?.[1] ?? "B0001"
  return JSON.stringify({ findings: [{ rule: "ambiguity", section_id: "fixed:4.2.3", message: "\"95% of requests\" needs a load profile.", block_ids: [b] }] })
}

export const fakeMode1 = (prompt: string): string | undefined => fakeImportExtract(prompt) ?? fakeSemanticCheck(prompt)

// ─── change request ─────────────────────────────────────────────

/** C-2: CR có chữ "AMBIGUOUS-CR" trong mô tả ⇒ hỏi lại ở vòng đầu; còn lại trả đích theo `targets`. */
export const fakeCrClarify =
  (targets: { entity_paths: string[]; keywords: string[] }) =>
  (prompt: string): string | undefined => {
    if (!prompt.includes("# CR Clarify")) return undefined
    const round = Number(/Round (\d+) of at most 3/.exec(prompt)?.[1] ?? 1)
    if (prompt.includes("AMBIGUOUS-CR") && round === 1) return JSON.stringify({ ambiguous: true, questions: ["Which screen?"], targets: { entity_paths: [], keywords: [] } })
    return JSON.stringify({ ambiguous: false, questions: [], targets })
  }

/** Vị trí trong prompt C-4 (FLF-186): `[L001] path (section: …)` rồi giá trị phần tử (JSON, thụt 2 dấu cách). */
export const promptLocations = (prompt: string): { location_id: string; path: string; text: string }[] => {
  const out: { location_id: string; path: string; text: string }[] = []
  const lines = prompt.split("\n")
  lines.forEach((line, i) => {
    const m = /^\[(L\d{3,})\] (\S+) \(section: /.exec(line)
    if (!m) return
    const body: string[] = []
    for (let j = i + 1; j < lines.length && lines[j].startsWith("  "); j++) body.push(lines[j].slice(2))
    out.push({ location_id: m[1], path: m[2], text: body.join("\n") })
  })
  return out
}

/** Giá trị JSON của vị trí (bỏ dòng "Previous proposal failed checks" nếu có). */
const locationValue = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text.split("\nPrevious proposal failed checks")[0]) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** C-4 (FLF-186): NFR nói "2 seconds" ⇒ edit ngưỡng 1 s (op trên chính phần tử); business rule ⇒ comment; còn lại not_related. */
export const fakeCrPropose = (prompt: string): string | undefined => {
  if (!prompt.includes("# CR Propose")) return undefined
  const locations = promptLocations(prompt).map((l) => {
    if (l.path.startsWith("nfrs[") && l.text.includes("2 seconds"))
      return {
        location_id: l.location_id,
        conclusion: "edit",
        reason: "Threshold changes",
        spine_ops: [
          { op: "set", path: `${l.path}.threshold`, value: "1 s" },
          { op: "set", path: `${l.path}.statement`, value: "The system shall respond within 1 second for 95% of requests." }
        ]
      }
    if (l.path.startsWith("business_rules[")) return { location_id: l.location_id, conclusion: "comment", reason: "Rule may depend on timing", comment_text: `Check ${l.path}`, spine_ops: [] }
    return { location_id: l.location_id, conclusion: "not_related", reason: "Different meaning", spine_ops: [] }
  })
  return JSON.stringify({ locations })
}

/** C-4 luôn đề xuất "sửa" bằng op đặt lại đúng giá trị cũ ⇒ C-5 trượt (edit_no_change). */
export const fakeCrProposeNoChange = (prompt: string): string | undefined => {
  if (!prompt.includes("# CR Propose")) return undefined
  return JSON.stringify({
    locations: promptLocations(prompt).map((l) => {
      const value = locationValue(l.text)
      const field = Object.keys(value).find((k) => k !== "id" && typeof value[k] === "string") ?? "name"
      return { location_id: l.location_id, conclusion: "edit", reason: "noop", spine_ops: [{ op: "set", path: `${l.path}.${field}`, value: value[field] ?? "" }] }
    })
  })
}
