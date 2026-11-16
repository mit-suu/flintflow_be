import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { FunctionInteraction, Spine } from "../../spine/spine.types.js"
import { renderKind } from "./index.js"
import { DIAGRAM_LABELS } from "./labels.js"
import { controllerName, hasComponentSequence, isComponentSequenceSource, needsSequence, renderSequence, sequenceSource } from "./sequence.renderer.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const S = "system"
const m = (from: string, to: string, message: string, kind: "request" | "response", flow: "normal" | "abnormal" = "normal", guard?: string): FunctionInteraction => ({
  from,
  to,
  message,
  kind,
  flow,
  ...(guard ? { guard } : {})
})

/** Spine với `interactions` của một function; các function khác không có. */
const withInteractions = (fnId: string, interactions: FunctionInteraction[]): Spine => {
  const spine = structuredClone(FIXTURE)
  for (const fn of spine.functions) delete fn.interactions
  spine.functions.find((f) => f.id === fnId)!.interactions = interactions
  return spine
}

const body = (source: string): string[] => source.split("\n").filter((l) => !l.startsWith("skinparam") && l !== "hide footbox" && l !== "")
const sourceOf = (spine: Spine, fnId: string, labels = DIAGRAM_LABELS.en): string => sequenceSource(spine, spine.functions.find((f) => f.id === fnId)!, labels)

describe("renderSequence - chọn function cần sơ đồ", () => {
  it("fixture: mỗi function có interactions đủ tiêu chí một hình, theo id; chủ = function, section = function:<id>, puml", () => {
    const parts = renderSequence(FIXTURE)
    expect(parts.map((p) => [p.kind, p.format, p.owner_kind, p.owner_id, p.section])).toEqual(
      ["FN001", "FN010", "FN024", "FN028", "FN084", "FN086"].map((id) => ["sequence", "puml", "function", id, `function:${id}`])
    )
    expect(renderKind(FIXTURE, "sequence", null).map((p) => p.owner_id)).toEqual(parts.map((p) => p.owner_id))
  })

  it("function không có interactions (Spine cũ) ⇒ không có hình", () => {
    const old = structuredClone(FIXTURE)
    for (const fn of old.functions) delete fn.interactions
    expect(renderSequence(old)).toEqual([])
  })

  it("tiêu chí: dưới 2 message, hoặc function có màn mà không có actor ngoài / nhánh lỗi / guard ⇒ không vẽ", () => {
    const fn = FIXTURE.functions.find((f) => f.id === "FN001")!
    const plain = [m("A01", S, "Open list", "request"), m(S, "A01", "Show list", "response")]
    expect(needsSequence({ ...fn, interactions: plain }, FIXTURE.actors)).toBe(false)
    expect(needsSequence({ ...fn, interactions: plain.slice(0, 1) }, FIXTURE.actors)).toBe(false)
    expect(needsSequence({ ...fn, interactions: [plain[0], m(S, "A01", "Show error", "response", "abnormal", "list is empty")] }, FIXTURE.actors)).toBe(true)
    expect(needsSequence({ ...fn, interactions: [plain[0], { ...plain[1], guard: "user is admin" }] }, FIXTURE.actors)).toBe(true)
    expect(needsSequence({ ...fn, interactions: [plain[0], m(S, "A08", "Send mail", "request")] }, FIXTURE.actors)).toBe(true)
    expect(needsSequence({ ...fn, screen_id: null, interactions: plain }, FIXTURE.actors)).toBe(true)
  })
})

describe("sequenceSource - ký pháp", () => {
  it("lifeline: actor người (stick figure) rồi :System rồi actor ngoài; actor ngoài gửi stimulus đứng bên trái :System", () => {
    expect(body(sourceOf(FIXTURE, "FN028")).slice(0, 5)).toEqual([
      "@startuml",
      'actor ":Founder" as A01',
      'participant ":System" as SSD_SYSTEM',
      'participant ":LLM Provider" as A06',
      "A01 -> SSD_SYSTEM : 1: Send chat message"
    ])
    expect(body(sourceOf(FIXTURE, "FN086")).slice(1, 3)).toEqual(['participant ":Payment Gateway" as A05', 'participant ":System" as SSD_SYSTEM'])
  })

  it("request có response quay về ⇒ đồng bộ `->` + activation; không có ⇒ bất đồng bộ `->>`; response nét đứt `-->>`", () => {
    const lines = body(sourceOf(FIXTURE, "FN010"))
    expect(lines).toContain("A01 -> SSD_SYSTEM : 1: Submit email address")
    expect(lines).toContain("SSD_SYSTEM ->> A08 : 1.1: Send password reset link")
    expect(lines).toContain("SSD_SYSTEM -->> A01 : 1.2: Confirm reset email sent")
    expect(lines.filter((l) => l.startsWith("activate"))).toEqual(["activate SSD_SYSTEM"])
    expect(lines.filter((l) => l.startsWith("deactivate"))).toEqual(["deactivate SSD_SYSTEM"])
  })

  it("đánh số 1, 1.1, 1.2 …, stimulus kế tiếp là 2, liên tục qua các nhánh", () => {
    const spine = withInteractions("FN001", [
      m("A01", S, "Open form", "request"),
      m(S, "A01", "Show form", "response"),
      m("A01", S, "Submit form", "request"),
      m(S, "A01", "Show error", "response", "abnormal", "form is invalid"),
      m(S, "A01", "Show result", "response")
    ])
    const numbers = body(sourceOf(spine, "FN001")).flatMap((l) => (/ : ([\d.]+): /.exec(l) ? [/ : ([\d.]+): /.exec(l)![1]] : []))
    expect(numbers).toEqual(["1", "1.1", "2", "2.1", "2.2"])
  })

  it("abnormal ⇒ alt <guard> / else <guard>; luồng chính sau đó là else cuối; activation của bên nhận trải qua mọi operand rồi đóng sau khung", () => {
    expect(body(sourceOf(FIXTURE, "FN001"))).toEqual([
      "@startuml",
      'actor ":Founder" as A01',
      'participant ":System" as SSD_SYSTEM',
      "A01 -> SSD_SYSTEM : 1: Submit email and password",
      "activate SSD_SYSTEM",
      "alt credentials do not match",
      "  SSD_SYSTEM -->> A01 : 1.1: Show authentication error",
      "else account is locked",
      "  SSD_SYSTEM -->> A01 : 1.2: Show account locked notice",
      "else else",
      "  SSD_SYSTEM -->> A01 : 1.3: Open project dashboard",
      "end",
      "deactivate SSD_SYSTEM",
      "@enduml"
    ])
  })

  it("activation mở trước khung đóng sau khung; message trong operand không đóng nó", () => {
    const lines = body(sourceOf(FIXTURE, "FN028"))
    const at = (text: string) => lines.findIndex((l) => l.includes(text))
    expect(at("activate A06")).toBeLessThan(at("alt "))
    expect(lines.slice(at("alt "), at("else else"))).toEqual(["alt model call times out", "  SSD_SYSTEM -->> A01 : 1.2: Show retry prompt"])
    expect(lines.slice(-4)).toEqual(["end", "deactivate A06", "deactivate SSD_SYSTEM", "@enduml"])
    // mọi activate có deactivate
    expect(lines.filter((l) => l.startsWith("activate")).length).toBe(lines.filter((l) => l.startsWith("deactivate")).length)
  })

  it("nhánh lỗi lồng nhau (lỗi ở hai bước khác nhau của luồng chính) ⇒ alt trong else của alt, cân bằng activation", () => {
    const spine = withInteractions("FN001", [
      m("A01", S, "Submit", "request"),
      m(S, "A06", "Check content", "request"),
      m(S, "A01", "Show blocked notice", "response", "abnormal", "content is blocked"),
      m("A06", S, "Return verdict", "response"),
      m(S, "A01", "Show quota error", "response", "abnormal", "quota is used up"),
      m(S, "A01", "Show saved", "response")
    ])
    const lines = body(sourceOf(spine, "FN001"))
    expect(lines.filter((l) => /^\s*(alt|opt)\b/.test(l)).map((l) => l.trim())).toEqual(["alt content is blocked", "alt quota is used up"])
    expect(lines.filter((l) => l.trim() === "end")).toHaveLength(2)
    expect(lines.filter((l) => l.trim().startsWith("activate")).length).toBe(lines.filter((l) => l.trim().startsWith("deactivate")).length)
  })

  it("message normal có guard liền nhau ⇒ opt; không đóng activation của phần bao ngoài", () => {
    const spine = withInteractions("FN001", [
      m("A01", S, "Request export", "request"),
      m(S, "A01", "Offer appendix", "response", "normal", "appendix is selected"),
      m(S, "A01", "Confirm appendix", "response", "normal", "appendix is selected"),
      m(S, "A01", "Download file", "response")
    ])
    expect(body(sourceOf(spine, "FN001")).slice(3)).toEqual([
      "A01 -> SSD_SYSTEM : 1: Request export",
      "activate SSD_SYSTEM",
      "opt appendix is selected",
      "  SSD_SYSTEM -->> A01 : 1.1: Offer appendix",
      "  SSD_SYSTEM -->> A01 : 1.2: Confirm appendix",
      "end",
      "SSD_SYSTEM -->> A01 : 1.3: Download file",
      "deactivate SSD_SYSTEM",
      "@enduml"
    ])
  })

  it("không có loop (Spine chưa có dữ liệu loop)", () => {
    for (const p of renderSequence(FIXTURE)) expect(p.source).not.toMatch(/^\s*loop\b/m)
  })

  it("actor người ở lifeline là actor trong Spine (tên đúng), id lạ ⇒ in id", () => {
    const spine = withInteractions("FN001", [m("A99", S, "Ping", "request"), m(S, "A99", "Pong", "response")])
    spine.functions.find((f) => f.id === "FN001")!.screen_id = null
    expect(sourceOf(spine, "FN001")).toContain('actor ":A99" as A99')
  })

  it("theme VP viết thẳng vào nguồn: #7ACFF5, không !include / URL; một @startuml / @enduml; chỉ ASCII ở bản tiếng Anh", () => {
    for (const p of renderSequence(FIXTURE)) {
      expect(p.source).toContain("#7ACFF5")
      // lời gọi đồng bộ: tam giác đặc như VP (UML 2.5.1: filled arrow head)
      expect(p.source).toContain("skinparam style strictuml")
      expect(p.source).not.toMatch(/!include|!import|https?:/)
      expect(p.source.match(/@startuml/g)).toHaveLength(1)
      expect(p.source.endsWith("@enduml\n")).toBe(true)
      // eslint-disable-next-line no-control-regex
      expect(p.source).toMatch(/^[\x00-\x7F]*$/)
    }
  })

  it("ổn định giữa hai lần gọi; nhãn máy theo ngôn ngữ (:Hệ thống, ngược lại)", () => {
    expect(renderSequence(FIXTURE).map((p) => p.source)).toEqual(renderSequence(FIXTURE).map((p) => p.source))
    const vi = sourceOf(FIXTURE, "FN001", DIAGRAM_LABELS.vi)
    expect(vi).toContain('participant ":Hệ thống" as SSD_SYSTEM')
    expect(vi).toContain("else ngược lại")
    expect(DIAGRAM_LABELS.vi.sequenceTitle("Đăng nhập")).toBe("Sơ đồ tuần tự hệ thống - Đăng nhập")
  })
})

describe("FLF-418 - mức thành phần (boundary / control / entity)", () => {
  /** FN001 "Submit Credentials": màn S01 Login, feature F1 "Authentication & Onboarding", entity E01 User. */
  const LOGIN: FunctionInteraction[] = [
    m("A01", "S01", "Submit email and password", "request"),
    m("S01", "control", "Authenticate credentials", "request"),
    m("control", "control", "Validate input", "request"),
    m("control", "E01", "Find user by email", "request"),
    m("E01", "control", "User record", "response"),
    m("control", "S01", "Credentials rejected", "response", "abnormal", "credentials do not match"),
    m("control", "S01", "Session created", "response"),
    m("S01", "A01", "Open project dashboard", "response")
  ]
  const withComponent = (list: FunctionInteraction[] = LOGIN): Spine => {
    const spine = structuredClone(FIXTURE)
    spine.functions.find((f) => f.id === "FN001")!.component_interactions = list
    return spine
  }
  const partOf = (spine: Spine, level?: "system" | "component", labels = DIAGRAM_LABELS.en) =>
    renderSequence(spine, null, labels, level ? { sequenceLevel: level } : {}).find((p) => p.owner_id === "FN001")!.source

  it("lifeline trái → phải: actor, boundary (màn), control (<Feature>Controller), entity", () => {
    const decl = body(partOf(withComponent(), "component")).filter((l) => / as /.test(l) && !l.includes("->"))
    expect(decl).toEqual([
      'actor ":Founder" as A01',
      'boundary ":Login" as S01',
      'control ":AuthenticationOnboardingController" as SD_CONTROL',
      'entity ":User" as E01'
    ])
  })

  it("đánh số: chỉ request từ actor mở số mới; control tự gọi; alt với else; mũi tên đồng bộ / phản hồi", () => {
    const lines = body(partOf(withComponent(), "component"))
    expect(lines).toContain("A01 -> S01 : 1: Submit email and password")
    expect(lines).toContain("S01 -> SD_CONTROL : 1.1: Authenticate credentials")
    expect(lines).toContain("SD_CONTROL ->> SD_CONTROL : 1.2: Validate input")
    expect(lines).toContain("SD_CONTROL -> E01 : 1.3: Find user by email")
    expect(lines).toContain("E01 -->> SD_CONTROL : 1.4: User record")
    expect(lines).toContain("alt credentials do not match")
    expect(lines).toContain("else else")
    expect(lines.filter((l) => l === "end")).toHaveLength(1)
  })

  it("mức system, hoặc function chưa có dữ liệu thành phần ⇒ vẽ hộp đen như cũ", () => {
    const spine = withComponent()
    expect(partOf(spine, "system")).toBe(partOf(spine))
    expect(partOf(spine)).toContain('participant ":System" as SSD_SYSTEM')
    expect(partOf(FIXTURE, "component")).toContain('participant ":System" as SSD_SYSTEM')
    expect(partOf(withComponent([LOGIN[0]]), "component")).toContain("SSD_SYSTEM")
  })

  it("function không màn: actor ngoài gửi thẳng tới control, không có boundary", () => {
    const spine = structuredClone(FIXTURE)
    const fn = spine.functions.find((f) => f.id === "FN084")!
    fn.component_interactions = [m("A09", "control", "Trigger monthly quota reset", "request"), m("control", "A08", "Send quota renewal notice", "request")]
    const source = renderSequence(spine, null, DIAGRAM_LABELS.en, { sequenceLevel: "component" }).find((p) => p.owner_id === "FN084")!.source
    expect(source).not.toMatch(/^boundary /m)
    expect(source).toMatch(/^participant ":.*" as A09$/m)
    expect(source.indexOf("as A09")).toBeLessThan(source.indexOf("as SD_CONTROL"))
    expect(source.indexOf("as SD_CONTROL")).toBeLessThan(source.indexOf("as A08"))
  })

  it("nhận diện hình mức thành phần qua nguồn; nhãn vi; tên controller bỏ dấu", () => {
    const spine = withComponent()
    expect(isComponentSequenceSource(partOf(spine, "component"))).toBe(true)
    expect(isComponentSequenceSource(partOf(spine))).toBe(false)
    expect(DIAGRAM_LABELS.vi.componentSequenceTitle("Đăng nhập")).toBe("Sơ đồ tuần tự - Đăng nhập")
    const vi = structuredClone(spine)
    vi.features.find((f) => f.id === "F1")!.name = "Xác thực & Đăng ký"
    expect(controllerName(vi, vi.functions.find((f) => f.id === "FN001")!)).toBe("XacThucDangKyController")
    expect(hasComponentSequence(spine.functions.find((f) => f.id === "FN001")!)).toBe(true)
  })
})
