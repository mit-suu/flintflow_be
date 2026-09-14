/**
 * T02 — kiểm fixture Spine và 10 ca thử op.
 *
 * Kiểm 8 bất biến của srs-spine.md §6 cùng các yêu cầu đếm của task 02 trên
 * fixture JSON đã commit. Tại M1, bổ sung `spineSchema.parse(fixture)` từ T01
 * (không thay thế các kiểm này — schema không kiểm được bất biến chéo mảng).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures")

const readJson = (...segments: string[]): any =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, ...segments), "utf8"))

const spine = readJson("spine-fixture-19-screens.json")
const minimal = readJson("spine-fixture-minimal.json")

const byId = (arr: any[]): Record<string, any> =>
  Object.fromEntries(arr.map((x: any) => [x.id, x]))

const screensById = byId(spine.screens)
const featuresById = byId(spine.features)
const actorsById = byId(spine.actors)
const fnsById = byId(spine.functions)
const rolesById = byId(spine.roles)
const ucById = byId(spine.use_cases)
const entitiesById = byId(spine.entities)
const sectionIds = new Set<string>(spine.sections.map((s: any) => s.id))
const validationIds = new Set<string>(
  spine.functions.flatMap((f: any) => f.validations.map((v: any) => v.id))
)

describe("spine-fixture-19-screens: yêu cầu đếm của task 02", () => {
  it("có đủ actor: >=8, gồm system Payment/LLM/PlantUML và time cron", () => {
    expect(spine.actors.length).toBeGreaterThanOrEqual(8)
    const systems = spine.actors.filter((a: any) => a.kind === "system")
    expect(systems.some((a: any) => /payment/i.test(a.name))).toBe(true)
    expect(systems.some((a: any) => /llm/i.test(a.name))).toBe(true)
    expect(systems.some((a: any) => /plantuml/i.test(a.name))).toBe(true)
    expect(spine.actors.some((a: any) => a.kind === "time")).toBe(true)
  })

  it("có >=20 use case với >=2 cặp include và >=2 cặp extend", () => {
    expect(spine.use_cases.length).toBeGreaterThanOrEqual(20)
    expect(spine.use_cases.filter((u: any) => u.includes.length > 0).length).toBeGreaterThanOrEqual(2)
    expect(spine.use_cases.filter((u: any) => u.extends.length > 0).length).toBeGreaterThanOrEqual(2)
  })

  it("có 19 màn: 2 popup, >=1 màn tabs, 5 signed_off còn lại placeholder", () => {
    expect(spine.screens).toHaveLength(19)
    expect(spine.screens.filter((s: any) => s.is_popup)).toHaveLength(2)
    expect(spine.screens.filter((s: any) => s.tabs.length > 0).length).toBeGreaterThanOrEqual(1)
    expect(spine.screens.filter((s: any) => s.detail_status === "signed_off")).toHaveLength(5)
    expect(
      spine.screens.filter((s: any) => !["signed_off", "placeholder"].includes(s.detail_status))
    ).toHaveLength(0)
  })

  it("mỗi màn có 4–6 function; >=6 non-screen function; validation có id", () => {
    for (const s of spine.screens) {
      const count = spine.functions.filter((f: any) => f.screen_id === s.id).length
      expect(count, `screen ${s.id}`).toBeGreaterThanOrEqual(4)
      expect(count, `screen ${s.id}`).toBeLessThanOrEqual(6)
    }
    expect(spine.functions.filter((f: any) => f.screen_id === null).length).toBeGreaterThanOrEqual(6)
    for (const f of spine.functions) {
      expect(f.priority, `fn ${f.id}`).toBeTruthy()
      for (const v of f.validations) {
        expect(v.id, `fn ${f.id}`).toBeTruthy()
        expect(["business", "format", "required"]).toContain(v.kind)
      }
    }
  })

  it("nfrs phủ 5 category; reliability/performance có metric + threshold", () => {
    expect(new Set(spine.nfrs.map((n: any) => n.category)).size).toBe(5)
    for (const n of spine.nfrs) {
      if (["reliability", "performance"].includes(n.category)) {
        expect(n.metric, `nfr ${n.id}`).toBeTruthy()
        expect(n.threshold, `nfr ${n.id}`).toBeTruthy()
      }
    }
  })

  it("các mảng còn lại đạt ngưỡng: entities>=10, glossary>=15, addendum>=5, 4 kind other_requirements", () => {
    expect(spine.entities.length).toBeGreaterThanOrEqual(10)
    expect(spine.glossary.length).toBeGreaterThanOrEqual(15)
    expect(spine.addendum.length).toBeGreaterThanOrEqual(5)
    expect(new Set(spine.other_requirements.map((o: any) => o.kind)).size).toBe(4)
    expect(spine.business_rules.some((b: any) => b.tier === "high")).toBe(true)
    expect(spine.business_rules.some((b: any) => b.tier === "detail")).toBe(true)
  })

  it("5 diagram đủ 5 kind, render_status ok, puml viết tay, source_hash TBD", () => {
    expect(spine.diagrams).toHaveLength(5)
    expect(new Set(spine.diagrams.map((d: any) => d.kind)).size).toBe(5)
    for (const d of spine.diagrams) {
      expect(d.render_status).toBe("ok")
      expect(d.puml).toContain("@startuml")
      expect(d.source_hash).toBe("TBD")
    }
  })

  it("steps đủ 38 + 5×6 = 68, toàn bộ accepted, dải seq không chồng lấn", () => {
    expect(spine.steps).toHaveLength(68)
    let prevLast = 0
    for (const st of spine.steps) {
      expect(st.status, st.id).toBe("accepted")
      expect(st.first_seq, st.id).toBe(prevLast + 1)
      expect(st.last_seq, st.id).toBeGreaterThanOrEqual(st.first_seq)
      prevLast = st.last_seq
    }
    expect(spine.steps.filter((s: any) => s.id.includes("@"))).toHaveLength(30)
  })

  it("progress ở S-9.5, spine_version=1, flags rỗng, >=3 assumption confirmed", () => {
    expect(spine.progress.current_step).toBe("S-9.5")
    expect(spine.spine_version).toBe(1)
    expect(spine.flags).toHaveLength(0)
    expect(spine.assumptions.length).toBeGreaterThanOrEqual(3)
    expect(spine.assumptions.every((a: any) => a.status === "confirmed")).toBe(true)
  })
})

describe("spine-fixture-19-screens: 8 bất biến srs-spine.md §6", () => {
  it("1 — mọi section bắt buộc có mặt trong sections[]", () => {
    const required = [
      "fixed:I", "fixed:1", "fixed:2.1", "fixed:2.2.1", "fixed:2.2.2",
      "fixed:3.1.1", "fixed:3.1.2", "fixed:3.1.3", "fixed:3.1.4", "fixed:3.1.5",
      "fixed:4.1", "fixed:4.2.1", "fixed:4.2.2", "fixed:4.2.3",
      "fixed:5.1", "fixed:5.2", "fixed:5.3", "fixed:5.4", "fixed:5.5"
    ]
    for (const id of required) expect(sectionIds.has(id), id).toBe(true)
    for (const f of spine.features) expect(sectionIds.has(`feature:${f.id}`)).toBe(true)
    for (const f of spine.functions) expect(sectionIds.has(`function:${f.id}`)).toBe(true)
    for (const s of spine.sections) expect(s.asset_version).toBeTruthy()
  })

  it("2 — các mảng bảo vệ không rỗng", () => {
    expect(spine.actors.length).toBeGreaterThan(0)
    expect(spine.actors.filter((a: any) => a.kind === "human").length).toBeGreaterThan(0)
    for (const key of ["screens", "entities", "use_cases", "features", "functions", "roles", "common_requirements"])
      expect(spine[key].length, key).toBeGreaterThan(0)
    expect(spine.nfrs.filter((n: any) => n.category === "reliability").length).toBeGreaterThan(0)
    expect(spine.nfrs.filter((n: any) => n.category === "performance").length).toBeGreaterThan(0)
  })

  it("3 — mọi khoá trong reference_fields[] phân giải được (không có id chết)", () => {
    for (const uc of spine.use_cases) {
      for (const a of uc.actor_ids) expect(actorsById[a], `${uc.id}→${a}`).toBeTruthy()
      for (const f of uc.function_ids) expect(fnsById[f], `${uc.id}→${f}`).toBeTruthy()
      for (const i of uc.includes) expect(ucById[i], `${uc.id}→${i}`).toBeTruthy()
      for (const e of uc.extends) expect(ucById[e], `${uc.id}→${e}`).toBeTruthy()
    }
    for (const s of spine.screens) {
      expect(featuresById[s.feature_id], s.id).toBeTruthy()
      for (const t of s.flow_to) expect(screensById[t], `${s.id}→${t}`).toBeTruthy()
      expect(fnsById[s.primary_function_id], s.id).toBeTruthy()
    }
    for (const p of spine.permissions) {
      expect(screensById[p.screen_id], p.id).toBeTruthy()
      expect(rolesById[p.role_id], p.id).toBeTruthy()
    }
    for (const r of spine.roles)
      expect(r.actor_id === null || Boolean(actorsById[r.actor_id]), r.id).toBe(true)
    for (const f of spine.functions)
      for (const b of f.business_rule_ids)
        expect(spine.business_rules.some((br: any) => br.id === b), `${f.id}→${b}`).toBe(true)
    for (const e of spine.entities)
      for (const rel of e.relations) expect(entitiesById[rel.target_id], e.id).toBeTruthy()
    for (const br of spine.business_rules)
      for (const vid of br.source_validation_ids) expect(validationIds.has(vid), `${br.id}→${vid}`).toBe(true)
    for (const m of spine.messages)
      for (const f of m.function_ids) expect(fnsById[f], `${m.id}→${f}`).toBeTruthy()
    for (const d of spine.diagrams)
      expect(d.owner_id === null || Boolean(screensById[d.owner_id]), d.id).toBe(true)
    for (const a of spine.addendum) expect(sectionIds.has(a.target_section), a.id).toBe(true)
    for (const st of spine.steps) {
      const m = st.id.match(/@(.+)$/)
      if (m && m[1] !== "nonscreen") expect(screensById[m[1]], st.id).toBeTruthy()
    }
    for (const as of spine.assumptions) {
      const m = as.path.match(/^(\w+)\[id=([\w-]+)\]/)
      expect(m, as.id).toBeTruthy()
      expect(spine[m![1]].some((x: any) => x.id === m![2]), as.path).toBe(true)
    }
  })

  it("4 — screen_id thuộc screens hoặc null; feature_id không null", () => {
    for (const f of spine.functions) {
      expect(f.screen_id === null || Boolean(screensById[f.screen_id]), f.id).toBe(true)
      expect(f.feature_id, f.id).toBeTruthy()
    }
    for (const s of spine.screens) expect(s.feature_id, s.id).toBeTruthy()
  })

  it("5 — features order liên tục từ 0; functions order duy nhất/liên tục theo feature, tách screen/non-screen", () => {
    const orders = spine.features.map((f: any) => f.order).sort((a: number, b: number) => a - b)
    orders.forEach((o: number, i: number) => expect(o).toBe(i))
    for (const feat of spine.features) {
      for (const isScreen of [true, false]) {
        const arr = spine.functions
          .filter((f: any) => f.feature_id === feat.id && (f.screen_id !== null) === isScreen)
          .map((f: any) => f.order)
          .sort((a: number, b: number) => a - b)
        arr.forEach((o: number, i: number) =>
          expect(o, `${feat.id} screen=${isScreen}`).toBe(i)
        )
      }
    }
  })

  it("6 — function kế thừa feature của màn nó thuộc về", () => {
    for (const f of spine.functions)
      if (f.screen_id !== null)
        expect(f.feature_id, f.id).toBe(screensById[f.screen_id].feature_id)
  })

  it("7 — đúng một session is_pipeline=true (cả fixture minimal)", () => {
    expect(spine.sessions.filter((s: any) => s.is_pipeline)).toHaveLength(1)
    expect(minimal.sessions.filter((s: any) => s.is_pipeline)).toHaveLength(1)
  })

  it("8 — screen_cursor và screen_queue trỏ tới màn tồn tại", () => {
    const cursor = spine.progress.screen_cursor
    expect(cursor === null || Boolean(screensById[cursor])).toBe(true)
    for (const q of spine.progress.screen_queue) expect(screensById[q], q).toBeTruthy()
  })
})

describe("spine-fixture-minimal", () => {
  it("chỉ có nội dung ở project và addendum; các mảng khác rỗng", () => {
    expect(minimal.project.name).toBe("FlintFlow")
    expect(minimal.project.working_mode).toBeTruthy()
    expect(minimal.addendum.length).toBeGreaterThanOrEqual(5)
    for (const key of ["actors", "screens", "functions", "use_cases", "steps", "sections", "flags"])
      expect(minimal[key], key).toHaveLength(0)
    expect(minimal.spine_version).toBe(1)
    expect(minimal.progress.current_step).toBe("S-1.1")
  })
})

// ---------- op cases ----------

/** Phân giải path dạng khoá (srs-spine.md §1) trên object spine. */
const resolvePath = (root: any, opPath: string): boolean => {
  const segments = opPath.match(/[a-z_]+(\[[^\]]*\])?/gi)
  if (!segments) return false
  let node: any = root
  for (const seg of segments) {
    const m = seg.match(/^([a-z_]+)(\[([^\]]*)\])?$/i)
    if (!m || node == null) return false
    node = node[m[1]]
    if (node === undefined) return false
    if (m[2] === undefined) continue // field thường
    if (!Array.isArray(node)) return false
    const selector = m[3]
    if (selector === "") continue // "arr[]" — đích là chính mảng (op add)
    if (selector.startsWith("=")) {
      // phần tử vô hướng: arr[=value]
      if (!node.includes(selector.slice(1))) return false
      continue
    }
    const pairs = selector.split(",").map(p => p.split("="))
    const found = node.find((el: any) => pairs.every(([k, v]) => String(el[k]) === v))
    if (!found) return false
    node = found
  }
  return true
}

const applyOverrides = (base: any, overrides: Record<string, any> | undefined): any => {
  if (!overrides) return base
  const clone = structuredClone(base)
  for (const [dotted, value] of Object.entries(overrides)) {
    const keys = dotted.split(".")
    let node = clone
    for (const k of keys.slice(0, -1)) node = node[k]
    node[keys[keys.length - 1]] = value
  }
  return clone
}

describe("op-cases", () => {
  const caseFiles = Array.from({ length: 10 }, (_, i) => `case-${String(i + 1).padStart(2, "0")}.json`)

  it("đủ 10 file ca thử", () => {
    for (const f of caseFiles)
      expect(fs.existsSync(path.join(FIXTURES_DIR, "op-cases", f)), f).toBe(true)
  })

  for (const file of caseFiles) {
    const opCase = readJson("op-cases", file)

    it(`${file} — cấu trúc hợp lệ theo hợp đồng op`, () => {
      expect(opCase.name).toBeTruthy()
      expect(opCase.step_id).toMatch(/^S-\d\.\d/)
      expect(
        fs.existsSync(path.join(FIXTURES_DIR, opCase.spine_before_ref)),
        opCase.spine_before_ref
      ).toBe(true)
      expect(Array.isArray(opCase.expected_ops)).toBe(true)
      expect(opCase.expected_ops.length).toBeGreaterThan(0)
      for (const op of opCase.expected_ops) {
        expect(["add", "set", "remove"], `${file}: ${op.path}`).toContain(op.op)
        expect(typeof op.path).toBe("string")
        if (op.op !== "remove") expect(op).toHaveProperty("value")
      }
      if (opCase.must_reject !== undefined) expect(typeof opCase.must_reject).toBe("string")
    })

    if (!opCase.must_reject) {
      it(`${file} — mọi path của set/remove phân giải được trên spine_before`, () => {
        const base = applyOverrides(spine, opCase.spine_before_overrides)
        for (const op of opCase.expected_ops) {
          if (op.op === "add") {
            // đích của add là mảng cha — bỏ selector cuối
            const parent = op.path.replace(/\[\]$/, "")
            expect(resolvePath(base, parent), `${file}: ${op.path}`).toBe(true)
          } else {
            expect(resolvePath(base, op.path), `${file}: ${op.path}`).toBe(true)
          }
        }
      })
    }
  }

  it("các ca must_reject phủ đủ 4 loại lỗi của task", () => {
    const rejects = caseFiles
      .map(f => readJson("op-cases", f))
      .filter(c => c.must_reject)
      .map(c => c.must_reject)
    expect(rejects).toHaveLength(4)
    expect(new Set(rejects).size).toBe(4)
  })
})
