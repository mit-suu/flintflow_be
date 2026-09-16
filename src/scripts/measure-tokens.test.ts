import { describe, it, expect } from "vitest"
import {
  inputGrowth,
  parseArgs,
  parseThresholds,
  phaseOf,
  projectAllLoopsDetailed,
  renderReport,
  summarize,
  upsertSection,
  usdOf,
  type CallRecord
} from "./measure-tokens.js"

const rec = (step_id: string, call_kind: CallRecord["call_kind"], tokens_in: number, tokens_out = 10, credit = 1): CallRecord => ({
  step_id,
  phase: phaseOf(step_id),
  call_kind,
  tokens_in,
  tokens_out,
  credit,
  measured: false
})

describe("parseArgs", () => {
  it("mặc định estimate trên fixture 19 màn, ghi docs/measurements.md", () => {
    expect(parseArgs([])).toMatchObject({ mode: "estimate", fixture: "full", out: "docs/measurements.md", usdInPer1M: null })
  })

  it("--real là viết tắt của --mode real; --no-write bỏ ghi file; đơn giá USD", () => {
    expect(parseArgs(["--real", "--no-write", "--usd-in", "0.15", "--usd-out", "0.6"])).toMatchObject({
      mode: "real",
      out: null,
      usdInPer1M: 0.15,
      usdOutPer1M: 0.6
    })
  })

  it("giá trị sai ⇒ báo lỗi, không âm thầm dùng mặc định", () => {
    expect(() => parseArgs(["--mode", "cheap"])).toThrow("--mode")
    expect(() => parseArgs(["--fixture", "big"])).toThrow("--fixture")
    expect(() => parseArgs(["--usd-in", "-1"])).toThrow("--usd-in")
    expect(() => parseArgs(["--bogus"])).toThrow("--bogus")
  })
})

describe("gom số", () => {
  it("phaseOf gộp vòng S-5 và step thường theo phase", () => {
    expect(phaseOf("S-5.2@S07")).toBe("S-5")
    expect(phaseOf("B-1.3")).toBe("B-1")
  })

  it("summarize đếm step kể cả step không gọi model, tách elicit/draft", () => {
    const { byPhase, total } = summarize([rec("S-3.1", "elicit", 100), rec("S-3.1", "draft", 300, 50, 4)], ["S-3.1", "S-3.6"])
    expect(total).toEqual({ steps: 2, calls: 2, elicit_calls: 1, draft_calls: 1, tokens_in: 400, tokens_out: 60, credit: 5 })
    expect(byPhase.get("S-3")?.steps).toBe(2)
  })

  it("usdOf cần cả hai đơn giá", () => {
    expect(usdOf(1_000_000, 500_000, 0.2, 1)).toBeCloseTo(0.7)
    expect(usdOf(1_000_000, 500_000, 0.2, null)).toBeNull()
  })

  it("inputGrowth so trung bình input draft 1/3 đầu với 1/3 cuối", () => {
    const order = ["S-1.1", "S-2.1", "S-3.1", "S-4.1", "S-6.1", "S-7.1"]
    const records = order.map((id, i) => rec(id, "draft", i < 2 ? 1000 : i < 4 ? 2000 : 3000))
    expect(inputGrowth(records, order)).toEqual({ first: 1000, last: 3000, ratio: 3 })
    expect(inputGrowth(records.slice(0, 2), order)).toBeNull()
  })

  it("ngoại suy vòng S-5: thay phần S-5 đo được bằng trung bình vòng × tổng vòng", () => {
    const order = ["S-4.1", "S-5.2@S01", "S-5.4@S01", "S-6.1"]
    const records = [rec("S-4.1", "draft", 1000), rec("S-5.2@S01", "draft", 500), rec("S-5.4@S01", "draft", 700), rec("S-6.1", "draft", 1000)]
    expect(projectAllLoopsDetailed(records, order, 4)).toMatchObject({ measuredLoops: 1, calls: 10, tokens_in: 2000 + 1200 * 4 })
    expect(projectAllLoopsDetailed(records, order, 1)).toBeNull()
  })
})

describe("ngưỡng và ghi file", () => {
  it("parseThresholds đọc bảng nhóm đặt; ô trống/— ⇒ null", () => {
    const md = [
      "# Measurements",
      "## Threshold",
      "| Chỉ số | Giá trị |",
      "| --- | --- |",
      "| `credit_per_project` | 600 |",
      "| usd_per_project | — |",
      "| tokens_in_per_call |  |",
      "## Other",
      "| credit_per_project | 1 |"
    ].join("\n")
    expect(parseThresholds(md)).toEqual({ credit_per_project: 600, usd_per_project: null, tokens_in_per_call: null })
    expect(parseThresholds("# none")).toEqual({ credit_per_project: null, usd_per_project: null, tokens_in_per_call: null })
  })

  it("upsertSection chỉ thay khối giữa marker, giữ nguyên mục người khác", () => {
    const first = upsertSection("# Measurements\n\n## T14\nkeep me\n", "## T22\nv1")
    expect(first).toContain("## T14\nkeep me")
    expect(first).toContain("## T22\nv1")
    const second = upsertSection(`${first}\n## T18\nalso keep\n`, "## T22\nv2")
    expect(second).not.toContain("v1")
    expect(second).toContain("v2")
    expect(second).toContain("also keep")
    expect(second.match(/T22:measure-tokens:start/g)).toHaveLength(1)
  })

  it("renderReport: so ngưỡng đạt/vượt, ghi rõ số ước lượng", () => {
    const order = ["S-3.1", "S-4.1", "S-6.1"]
    const report = renderReport({
      options: parseArgs(["--no-write"]),
      records: order.map((id) => rec(id, "draft", 2000, 100, 4)),
      stepOrder: order,
      shape: { screens: 2, functions: 3, loops: 0, totalSteps: 51 },
      startedAt: new Date("2026-09-16T00:00:00Z"),
      durationMs: 1000,
      thresholds: { credit_per_project: 10, usd_per_project: null, tokens_in_per_call: 5000 }
    })
    expect(report).toContain("| credit_per_project | 12 | 10 | **vượt** |")
    expect(report).toContain("| tokens_in_per_call (max) | 2 000 | 5 000 | đạt |")
    expect(report).toContain("| usd_per_project | n/a | chưa đặt | — |")
    expect(report).toContain("**Số ước lượng**")
  })
})
