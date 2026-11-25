import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { ActionType, SKILL_BY_ACTION_TYPE } from "./ai-action.types.js"
import {
  listPromptAssets,
  getPromptAssetIndex,
  invalidatePromptAssetCache,
  listSkillAssets,
  getSkillIndex,
  getSkillsDir,
  computeSkillAssetVersion,
  invalidateSkillCache,
  parseSkill,
  MAX_SKILL_PROMPT_CHARS
} from "./prompt-assets.js"
import { getSkill, getPromptTemplate, REFERENCE_HEADING } from "./prompt-registry.service.js"
import { OUTPUT_SCHEMA_BY_ACTION_TYPE } from "./response-parser.js"
import { UI_TERM_BLACKLIST, USE_CASE_VERB_BLACKLIST } from "../../modules/spine/deterministic-check.js"

beforeEach(() => {
  invalidatePromptAssetCache()
  invalidateSkillCache()
})

describe("prompt phẳng trên đĩa (assets/prompts)", () => {
  it("mọi ActionType có prompt hoặc skill", async () => {
    const missing: string[] = []
    for (const t of Object.values(ActionType)) {
      await getPromptTemplate(t).catch(() => missing.push(t))
    }

    expect(missing, `Thiếu asset cho: ${missing.join(", ")}`).toEqual([])
  })

  it("không có prompt MỒ CÔI (không ứng với ActionType nào)", () => {
    const known = new Set<string>(Object.values(ActionType))
    const orphans = listPromptAssets()
      .filter((a) => !known.has(a.actionType))
      .map((a) => `${a.file} (${a.actionType})`)

    expect(orphans, `Asset mồ côi: ${orphans.join(", ")}`).toEqual([])
  })

  it("không có actionType nào trùng nhau", () => {
    expect(() => getPromptAssetIndex()).not.toThrow()
  })

  it("mọi prompt có frontmatter hợp lệ và template không rỗng", () => {
    for (const asset of listPromptAssets()) {
      expect(asset.provider, `${asset.file}: provider rỗng`).toBeTruthy()
      expect(asset.aiModel, `${asset.file}: aiModel rỗng`).toBeTruthy()
      expect(asset.maxTokens, `${asset.file}: maxTokens không hợp lệ`).toBeGreaterThan(0)
      expect(Number.isFinite(asset.temperature), `${asset.file}: temperature`).toBe(true)
      expect(asset.template.length, `${asset.file}: template rỗng`).toBeGreaterThan(0)
    }
  })

  it("bỏ qua README.md và _archive", () => {
    const assets = listPromptAssets()

    expect(assets.some((a) => a.file.endsWith("README.md"))).toBe(false)
    expect(assets.some((a) => a.file.includes("_archive"))).toBe(false)
  })

  // T21: prompt phẳng chỉ còn cho action ngoài pipeline — prompt section-based cũ đã xoá
  // + GOOGLE_DOCS_AGENT: system prompt của trợ lý Google Docs, cũng ngoài pipeline
  it("chỉ còn prompt của CHAT, SUMMARIZE_DOCUMENT, TRANSLATE, TRANSLATE_DOCUMENT, GOOGLE_DOCS_AGENT", () => {
    expect(listPromptAssets().map((a) => a.actionType).sort()).toEqual(
      [ActionType.CHAT, ActionType.GOOGLE_DOCS_AGENT, ActionType.SUMMARIZE_DOCUMENT, ActionType.TRANSLATE, ActionType.TRANSLATE_DOCUMENT].sort()
    )
  })
})

describe("skill trên đĩa (assets/skills)", () => {
  // Phases §8.2 đếm 29 (12 content); task-03 thêm content/product-brief cho B-0…B-2 (T20)
  // ⇒ 30. Ghi ở docs/spec-gaps.md.
  it("đủ 50 skill: 22 action · 18 content · 8 renderer · 2 output", () => {
    const byKind = (k: string) => listSkillAssets().filter((s) => s.kind === k).length

    // +2 so với 30 ban đầu: content/prioritization (S-9.4, T19) thay UC34/UC35 cũ,
    // và content/brief-analysis (S-1.1/1.3/1.4, T20) tách khỏi project-classifier.
    // +5 action khung mode 1 (FLF-171): import-extract, import-semantic-check, cr-clarify, cr-propose, cr-consistency.
    // +1 action mode 1 v3 phase 5: import-extract-diagram (Gemini đọc ảnh diagram).
    // +1 action mode 1 v3 phase 7: cr-material-image (Gemini đọc ảnh tài liệu bổ sung của CR).
    // +1 action 1.11 map-reduce: import-cross-check (kiểm chéo giữa các section).
    // +1 action FLF-267: knowledge-answer (trả lời câu hỏi tri thức chỉ từ chunk truy hồi, có trích dẫn).
    // +1 action FLF-338: extract-requirements (rút yêu cầu từ tài liệu thô, §3.6.1).
    // +1 action FLF-395: skeleton-generic-names (dạng chung cho mục BA tự đặt trước khi vào khung mẫu org).
    // +1 action FLF-395: template-migration-resolve (D8: chuyển mục riêng vào mục có cấu trúc / giải quyết conflict khi đổi mẫu).
    // +1 renderer FLF-325: renderer/class (class diagram domain, mỗi feature một hình).
    // +1 renderer: renderer/state-machine (state machine diagram, mỗi entity có vòng đời một hình).
    // +1 renderer: renderer/sequence (System Sequence Diagram, mỗi function cần sơ đồ một hình).
    // +3 content FLF-365: references-list, requirement-apportioning, verification-matrix (mục IEEE 29148, Mode 1).
    // +1 renderer FLF-390: renderer/activity (activity diagram, luồng xử lý mỗi function một hình).
    // +1 renderer FLF-390: renderer/deployment (deployment diagram của hệ thống, §4.1).
    expect(listSkillAssets()).toHaveLength(52)
    expect(byKind("action")).toBe(22)
    expect(byKind("content")).toBe(18)
    expect(byKind("renderer")).toBe(10)
    expect(byKind("output")).toBe(2)
  })

  it("không trùng skill_id", () => {
    expect(() => getSkillIndex()).not.toThrow()
    expect(getSkillIndex().size).toBe(listSkillAssets().length)
  })

  it("frontmatter đủ và hợp lệ", () => {
    for (const s of listSkillAssets()) {
      expect(s.version, `${s.dir}: version`).toBeTruthy()
      expect(s.provider, `${s.dir}: provider`).toBeTruthy()
      expect(s.aiModel, `${s.dir}: aiModel`).toBeTruthy()
      expect(s.outputSchema.length, `${s.dir}: output_schema`).toBeGreaterThan(0)
      expect(s.template.length, `${s.dir}: thân rỗng`).toBeGreaterThan(0)
      expect(s.assetVersion, `${s.dir}: asset_version`).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  // XREQ T14→T03, T10→T03 (chốt 2026-09-15), T18/T19/T20→T03 (cùng tiền lệ): skill đã viết thật bỏ
  // `stub`. Sau T20 không còn skill nào là stub.
  const WRITTEN_NON_ACTION = new Set([
    "content/project-classifier",
    "content/product-overview",
    "content/high-level-rules",
    "content/actors-and-usecases",
    "content/screens-and-flow",
    "content/authorization-matrix",
    "content/non-screen-functions",
    "content/entities-erd",
    "content/function-detail",
    "content/nfr-quality-attributes",
    "content/appendix-content",
    "content/glossary",
    "content/prioritization",
    "content/product-brief",
    "content/brief-analysis",
    // FLF-365: mục IEEE 29148 (Mode 1)
    "content/references-list",
    "content/requirement-apportioning",
    "content/verification-matrix",
    "output/srs-completeness-score",
    "renderer/activity",
    "renderer/class",
    "renderer/context",
    "renderer/deployment",
    "renderer/erd",
    "renderer/screen-flow",
    "renderer/screen-layout",
    "renderer/sequence",
    "renderer/state-machine",
    "renderer/usecase"
  ])

  // FLF-171: skill action mode 1 là khung ở P1 (plan mode 1 §5.7); P2 đã viết nội dung cả 5 skill nên tập này rỗng.
  const MODE1_SKELETON_ACTION = new Set<string>([])

  // Skill cần quy trình suy luận dài hơn mức chung (quyết định chiều/bản số từng quan hệ ERD; FLF-311: lô thêm use case kéo
  // theo chức năng / màn / luồng / phân quyền — hai khối theo giai đoạn, model chỉ nhận một khối; entities-erd thêm Pass 8
  // vòng đời entity (states / transitions) cùng hai nhóm luật validator của nó nên nâng 250 → 260)
  // FLF-418: function-detail thêm mục component_interactions (mức thành phần của sơ đồ tuần tự)
  const LINE_LIMIT_OVERRIDE: Readonly<Record<string, number>> = { "content/entities-erd": 260, "action/apply-change-op": 250, "content/function-detail": 165, "action/elicit-loop": 160 }

  // FLF-449 N2: block luật chất lượng chép y hệt vào 9 skill (ba-quality-block.test.ts so từng byte) - không tính vào trần dòng,
  // nếu không thì mỗi skill phân tích phải cắt luật riêng của nó để chứa luật chung.
  const withoutSharedQualityBlock = (text: string): string => {
    const start = text.indexOf("<!-- ba-quality:shared:start -->")
    const endMarker = "<!-- ba-quality:shared:end -->\n"
    const end = text.indexOf(endMarker)
    return start >= 0 && end > start ? text.slice(0, start) + text.slice(end + endMarker.length) : text
  }

  it("skill action + skill đã viết (T10, T14) có nội dung thật, SKILL.md ≤ 150 dòng (trừ LINE_LIMIT_OVERRIDE, không tính block ba-quality); skill còn lại là stub", () => {
    for (const s of listSkillAssets()) {
      const dir = s.dir.replace(/\\/g, "/")
      if ((s.kind === "action" && !MODE1_SKELETON_ACTION.has(dir)) || WRITTEN_NON_ACTION.has(dir)) {
        expect(s.stub, `${s.dir} không được là stub`).toBe(false)
        const text = fs.readFileSync(path.join(getSkillsDir(), s.dir, "SKILL.md"), "utf-8").replace(/\r\n/g, "\n")
        const lines = withoutSharedQualityBlock(text).split("\n")
        expect(lines.length, `${s.dir}: ${lines.length} dòng`).toBeLessThanOrEqual(LINE_LIMIT_OVERRIDE[dir] ?? 150)
      } else {
        expect(s.stub, `${s.dir} phải đánh dấu stub`).toBe(true)
      }
    }
    const dirs = new Set(listSkillAssets().map((s) => s.dir.replace(/\\/g, "/")))
    for (const dir of [...WRITTEN_NON_ACTION, ...MODE1_SKELETON_ACTION]) expect(dirs.has(dir), `${dir} không tồn tại`).toBe(true)
  })

  it("SKILL_BY_ACTION_TYPE trỏ tới skill action có output_schema khớp parser", () => {
    for (const [actionType, skillId] of Object.entries(SKILL_BY_ACTION_TYPE)) {
      const skill = getSkillIndex().get(skillId!)
      expect(skill, `${actionType} → ${skillId} không tồn tại`).toBeDefined()
      expect(skill!.kind).toBe("action")

      const expected = OUTPUT_SCHEMA_BY_ACTION_TYPE[actionType as ActionType]
      expect(skill!.outputSchema, `${actionType} → ${skillId}`).toContain(expected)
    }
  })

  it("getPromptTemplate của ActionType pipeline trả template từ skill kèm asset_version", async () => {
    const loaded = await getPromptTemplate(ActionType.DRAFT)

    expect(loaded.skillId).toBe("draft-to-ops")
    expect(loaded.asset_version).toMatch(/^[0-9a-f]{64}$/)
    expect(loaded.providerConfig.model).toBeTruthy()
  })
})

describe("FLF-449 N3: skill hành động nạp reference khai ở prompt_references", () => {
  it("review-section: template có nguyên lenses.md sau thân skill, đúng một lần", async () => {
    const { template, skillId } = await getPromptTemplate(ActionType.REVIEW)
    expect(skillId).toBe("review-section")
    expect(template).toContain(`${REFERENCE_HEADING}lenses`)
    expect(template).toContain("Weasel words")
    expect(template).toContain("## `goal_coverage` (S-9.3)")
    expect(template.split(`${REFERENCE_HEADING}lenses`)).toHaveLength(2)
    expect(template.indexOf(`${REFERENCE_HEADING}lenses`)).toBeGreaterThan(template.indexOf("## Output"))
    // CONSISTENCY_PASS dùng cùng skill ⇒ cùng template
    expect((await getPromptTemplate(ActionType.CONSISTENCY_PASS)).template).toBe(template)
  })

  it("elicit-loop: template có when-to-offer-choices (luật khuyến nghị theo chốt 03 #3); conversation-style không khai thì không nạp", async () => {
    const { template } = await getPromptTemplate(ActionType.ELICIT)
    expect(template).toContain(`${REFERENCE_HEADING}when-to-offer-choices`)
    expect(template).toContain("**Recommend only when sure**")
    expect(template).toContain("recommendation_reason")
    expect(template).toContain("recommendation from general practice alone")
    expect(template).not.toContain(`${REFERENCE_HEADING}conversation-style`)
    expect((await getPromptTemplate(ActionType.DISCOVERY_STEP)).template).toBe(template)
  })

  it("reference nạp vào prompt không còn chữ nội bộ cũ (đường dẫn code trong chữ, 'Mình đề xuất', FPT)", () => {
    for (const [skillId, name] of [["elicit-loop", "when-to-offer-choices"], ["review-section", "lenses"]] as const) {
      const text = getSkill(skillId, { references: [name] }).references[name]
      expect(text, `${skillId}/${name}`).not.toContain("Mình đề xuất")
      expect(text, `${skillId}/${name}`).not.toMatch(/FPT/)
      expect(text, `${skillId}/${name}`).not.toContain("Round one ships the schema")
      expect(text, `${skillId}/${name}`).not.toContain("{{")
    }
  })

  it("skill hành động không khai prompt_references ⇒ template đúng bằng thân SKILL.md (draft-to-ops)", async () => {
    const { template } = await getPromptTemplate(ActionType.DRAFT)
    expect(template).toBe(getSkill("draft-to-ops").template)
    expect(template).not.toContain(REFERENCE_HEADING)
  })

  it("mọi skill: thân + prompt_references nằm dưới trần MAX_SKILL_PROMPT_CHARS", () => {
    for (const s of listSkillAssets()) {
      const refs = getSkill(s.skillId, { references: s.promptReferences }).references
      const total = s.template.length + Object.values(refs).reduce((n, r) => n + r.length, 0)
      expect(total, s.dir).toBeLessThanOrEqual(MAX_SKILL_PROMPT_CHARS)
    }
  })
})

describe("FLF-449 N3: kiểm prompt_references lúc nạp", () => {
  let tmp: string
  const skillFile = () => path.join(tmp, "action", "review-section", "SKILL.md")
  const replaceInSkill = (from: string, to: string) => {
    const text = fs.readFileSync(skillFile(), "utf-8").replace(/\r\n/g, "\n")
    expect(text).toContain(from)
    fs.writeFileSync(skillFile(), text.replace(from, to))
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"))
    fs.cpSync(path.join(getSkillsDir(), "action", "review-section"), path.join(tmp, "action", "review-section"), { recursive: true })
  })

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("bản gốc nạp được và khai lenses", () => {
    expect(parseSkill(tmp, "action", "review-section").promptReferences).toEqual(["lenses"])
  })

  it("reference khai báo không tồn tại ⇒ lỗi lúc nạp", () => {
    replaceInSkill("prompt_references:\n  - lenses\n", "prompt_references:\n  - lenses\n  - khong-co\n")
    expect(() => parseSkill(tmp, "action", "review-section")).toThrow(/prompt_references trỏ tới reference không có: khong-co/)
  })

  it("file reference bị xoá mà frontmatter vẫn khai ⇒ lỗi lúc nạp", () => {
    fs.rmSync(path.join(tmp, "action", "review-section", "references", "lenses.md"))
    expect(() => parseSkill(tmp, "action", "review-section")).toThrow(/prompt_references trỏ tới reference không có: lenses/)
  })

  it("khai trùng tên ⇒ lỗi lúc nạp (reference bị nối hai lần)", () => {
    replaceInSkill("prompt_references:\n  - lenses\n", "prompt_references:\n  - lenses\n  - lenses\n")
    expect(() => parseSkill(tmp, "action", "review-section")).toThrow(/khai trùng tên/)
  })

  it("thân + reference vượt trần ⇒ lỗi lúc nạp", () => {
    fs.appendFileSync(path.join(tmp, "action", "review-section", "references", "lenses.md"), `\n${"x".repeat(MAX_SKILL_PROMPT_CHARS)}\n`)
    expect(() => parseSkill(tmp, "action", "review-section")).toThrow(/vượt trần/)
  })
})

describe("getSkill", () => {
  it('getSkill("draft-to-ops") trả asset_version ổn định', () => {
    const first = getSkill("draft-to-ops").asset_version
    invalidateSkillCache()
    const second = getSkill("draft-to-ops").asset_version

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toBe(first)
  })

  it("nạp references theo yêu cầu, mặc định không nạp", () => {
    const bare = getSkill("draft-to-ops")
    expect(bare.references).toEqual({})
    expect(bare.referenceNames).toEqual(["invariants", "op-grammar"])

    const withRef = getSkill("draft-to-ops", { references: ["op-grammar"] })
    expect(Object.keys(withRef.references)).toEqual(["op-grammar"])
    expect(withRef.references["op-grammar"]).toContain("renumber")

    expect(Object.keys(getSkill("draft-to-ops", { references: "all" }).references)).toHaveLength(2)
  })

  it("throw khi skill hoặc reference không tồn tại", () => {
    expect(() => getSkill("khong-co")).toThrow(/Không tìm thấy skill/)
    expect(() => getSkill("draft-to-ops", { references: ["khong-co"] })).toThrow(/không có reference/)
  })
})

describe("computeSkillAssetVersion", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-"))
    fs.cpSync(path.join(getSkillsDir(), "action", "draft-to-ops"), tmp, { recursive: true })
  })

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("không đổi khi xuống dòng CRLF (checkout Windows)", () => {
    const refs = ["invariants", "op-grammar"]
    const before = computeSkillAssetVersion(tmp, refs)

    const file = path.join(tmp, "SKILL.md")
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace(/\r?\n/g, "\r\n"))

    expect(computeSkillAssetVersion(tmp, refs)).toBe(before)
  })

  it("đổi khi sửa một reference", () => {
    const refs = ["invariants", "op-grammar"]
    const before = computeSkillAssetVersion(tmp, refs)

    fs.appendFileSync(path.join(tmp, "references", "invariants.md"), "\nextra line\n")

    expect(computeSkillAssetVersion(tmp, refs)).not.toBe(before)
  })
})

describe("provider đọc ảnh", () => {
  it("hai action đọc ảnh dùng Claude, không còn model dự phòng Gemini", async () => {
    for (const action of [ActionType.IMPORT_EXTRACT_DIAGRAM, ActionType.CR_MATERIAL_IMAGE]) {
      const { providerConfig } = await getPromptTemplate(action)
      expect(providerConfig).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" })
      expect(providerConfig.fallbackModels).toBeUndefined()
    }
    expect((await getPromptTemplate(ActionType.CR_PROPOSE)).providerConfig.fallbackModels).toBeUndefined()
  })
})

describe("Brief giữ tầm nhìn/mục tiêu ở addendum, S-1.1 dựng bản tiếng Anh", () => {
  const skill = (dir: string): string => fs.readFileSync(path.join(getSkillsDir(), dir, "SKILL.md"), "utf-8")

  it("product-brief: ví dụ B-1.1 không set project.vision/goals, dùng addendum topic vision + goals", () => {
    const text = skill("content/product-brief")
    expect(text).not.toMatch(/"path": "project\.(vision|goals)"/)
    expect(text).toContain('"topic": "vision"')
    expect(text).toContain('"topic": "goals"')
    expect(text).toContain("B-1 never writes `project.vision`")
    expect(text).toContain('path: "addendum[id=<that vision/goals entry>]"')
  })

  it("brief-analysis: S-1.1 luôn dựng project.vision + goals 1:1 từ addendum và được ghi addendum", () => {
    const text = skill("content/brief-analysis")
    expect(text).toContain("**Always** `set project.vision`")
    expect(text).toContain("1:1")
    expect(getSkillIndex().get("brief-analysis")?.writes).toContain("addendum[]")
  })

  it("draft-to-ops: ví dụ giả định không trỏ project.vision", () => {
    expect(skill("action/draft-to-ops")).not.toMatch(/"path": "project.(vision|goals)"/)
  })

  it("cr-clarify (FLF-318): hỏi ai xử lý yêu cầu khi CR thêm use case; hỏi trước khi xoá use case của một luồng", () => {
    const text = skill("action/cr-clarify")
    expect(text).toContain("A new use case that creates a request needs someone to settle it")
    expect(text).toContain("Removing a use case of a flow is the user's call")
  })

  it("apply-change-op: có luật brief_core cho lệnh sửa ở pha Brief", () => {
    expect(skill("action/apply-change-op")).toContain("brief_core")
  })

  it("FLF-411 (#18): apply-change-op - \"tên hệ thống\" ghi project.system_name, project.name chỉ khi nói tên dự án", () => {
    const text = skill("action/apply-change-op")
    expect(text).toContain("`set project.system_name`")
    expect(text).toContain("tên dự án")
  })

  it("FLF-278: apply-change-op dạy ghi mục riêng của mẫu khách và soạn nháp không bịa, hỏi tối đa 3 câu", () => {
    const text = skill("action/apply-change-op")
    expect(text).toContain("custom_sections[id=…]")
    expect(text).toContain("draft_context")
    expect(text).toContain("up to **3** numbered questions")
  })

  it("apply-change-op: cảnh báo, nhiều ý (ý rõ ra op, ý mơ hồ một câu hỏi), giả định sau khi đã hỏi, soạn mục chưa có step", () => {
    const text = skill("action/apply-change-op")
    expect(text).toContain("{{decisions}}")
    expect(text).toContain("still return the ops plus `warning`")
    expect(text).toContain("ONE `clarification_needed`")
    expect(text).toContain("never hold clear ops back")
    expect(text).toContain("Guess only after asking")
    expect(text).toContain("`assumptions`")
    expect(text).toContain("keep the template's table(s) exactly")
    expect(text).toContain("never an em dash")
  })

  it("chat.md: trả lời câu hỏi nội dung phần tử từ khối chi tiết kèm chỉ mục", async () => {
    const { template } = await getPromptTemplate(ActionType.CHAT)
    expect(template).toContain("Chi tiết các phần tử được nhắc trong câu hỏi")
    expect(template).not.toMatch(/\{\{element_context\}\}/)
  })
})

describe("FLF-243: skill đặt tên use case nêu đủ luật mà cờ vàng usecase_name_* kiểm", () => {
  const skill = (dir: string): string => fs.readFileSync(path.join(getSkillsDir(), dir, "SKILL.md"), "utf-8").replace(/\s+/g, " ")

  it.each(["content/actors-and-usecases", "action/apply-change-op"])("%s liệt kê đủ động từ cấm (U3) và thuật ngữ giao diện (U5)", (dir) => {
    const text = skill(dir)
    for (const term of [...USE_CASE_VERB_BLACKLIST, ...UI_TERM_BLACKLIST]) expect(text, term).toMatch(new RegExp(`\\b${term}\\b`))
    expect(text).toMatch(/at most 5 words/)
  })

  it.each(["content/actors-and-usecases", "action/apply-change-op"])("%s: U4 nói đúng luật code - chỉ cấm actor làm chủ ngữ", (dir) => {
    const text = skill(dir)
    expect(text).toContain("never the subject")
    expect(text).toContain("Create Student Record")
    expect(text).not.toMatch(/no actor name/i)
  })
})

describe("FLF-260: skill chat viết theo ngôn ngữ trả lời nối ở cuối prompt", () => {
  const skill = (dir: string): string => fs.readFileSync(path.join(getSkillsDir(), dir, "SKILL.md"), "utf-8").replace(/\s+/g, " ")

  it.each(["action/elicit-loop", "action/draft-to-ops", "action/apply-change-op"])("%s trỏ tới mục Reply language, thiếu mục đó thì tiếng Việt", (dir) => {
    const text = skill(dir)
    expect(text).toContain("`## Reply language` section")
    expect(text).toContain("Vietnamese when it is absent")
  })

  it("thẻ tuân thủ có cặp nhãn tiếng Anh cố định - server dò chữ 'law' trong câu trả lời đã chốt để ghi project.stakes", () => {
    expect(skill("action/elicit-loop")).toContain('(English reply: "Internal rules only" / "Internal rules and the law")')
    // draft-to-ops phải nhận ra vế nội bộ bằng tiếng Anh: vế này không tự quyết internal hay production
    expect(skill("action/draft-to-ops")).toContain('English reply: "Internal rules only"')
  })

  it("FLF-478: nhắc lịch trên mobile tách 'đẩy trên điện thoại' với 'chỉ trong app'; S-2.3 thêm dịch vụ push", () => {
    const ask = skill("action/elicit-loop")
    expect(ask).toContain("Notification channel on mobile")
    expect(ask).toContain("push notification on the phone")
    expect(ask).toContain("in-app only")
    expect(ask).toContain("never conclude")
    const overview = skill("content/product-overview")
    expect(overview).toContain("Push Notification Service")
    expect(overview).toContain("mobile_app")
  })

  it("trích đoạn chốt câu hỏi mở không bị dịch theo ngôn ngữ trả lời - server chỉ nhận chuỗi con của tin user", () => {
    expect(skill("action/elicit-loop")).toContain("never paraphrased, translated or shortened")
  })
})

describe("skill entities-erd", () => {
  it("P10 (BarberGo #15): khoá chính là mã / số định danh, không phải tên (shop name, service name, display name)", () => {
    const { template } = getSkill("entities-erd")
    expect(template).toMatch(/`key` = the code or number identifying one instance/)
    expect(template).toMatch(/else `<entity> id` \(`shop id`\), never a name or title \(`shop name`, `display name`\)/)
  })
})
