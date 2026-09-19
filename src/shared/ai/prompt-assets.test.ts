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
  invalidateSkillCache
} from "./prompt-assets.js"
import { getSkill, getPromptTemplate } from "./prompt-registry.service.js"
import { OUTPUT_SCHEMA_BY_ACTION_TYPE } from "./response-parser.js"

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
  it("chỉ còn prompt của CHAT và SUMMARIZE_DOCUMENT", () => {
    expect(listPromptAssets().map((a) => a.actionType).sort()).toEqual([ActionType.CHAT, ActionType.SUMMARIZE_DOCUMENT])
  })
})

describe("skill trên đĩa (assets/skills)", () => {
  // Phases §8.2 đếm 29 (12 content); task-03 thêm content/product-brief cho B-0…B-2 (T20)
  // ⇒ 30. Ghi ở docs/spec-gaps.md.
  it("đủ 37 skill: 15 action · 15 content · 5 renderer · 2 output", () => {
    const byKind = (k: string) => listSkillAssets().filter((s) => s.kind === k).length

    // +2 so với 30 ban đầu: content/prioritization (S-9.4, T19) thay UC34/UC35 cũ,
    // và content/brief-analysis (S-1.1/1.3/1.4, T20) tách khỏi project-classifier.
    // +5 action khung mode 1 (FLF-171): import-extract, import-semantic-check, cr-clarify, cr-propose, cr-consistency.
    expect(listSkillAssets()).toHaveLength(37)
    expect(byKind("action")).toBe(15)
    expect(byKind("content")).toBe(15)
    expect(byKind("renderer")).toBe(5)
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
    "output/srs-completeness-score",
    "renderer/context",
    "renderer/erd",
    "renderer/screen-flow",
    "renderer/screen-layout",
    "renderer/usecase"
  ])

  // FLF-171: skill action mode 1 là khung ở P1 (plan mode 1 §5.7); P2 đã viết nội dung cả 5 skill nên tập này rỗng.
  const MODE1_SKELETON_ACTION = new Set<string>([])

  it("skill action + skill đã viết (T10, T14) có nội dung thật, SKILL.md ≤ 150 dòng; skill còn lại là stub", () => {
    for (const s of listSkillAssets()) {
      const dir = s.dir.replace(/\\/g, "/")
      if ((s.kind === "action" && !MODE1_SKELETON_ACTION.has(dir)) || WRITTEN_NON_ACTION.has(dir)) {
        expect(s.stub, `${s.dir} không được là stub`).toBe(false)
        const lines = fs.readFileSync(path.join(getSkillsDir(), s.dir, "SKILL.md"), "utf-8").split("\n")
        expect(lines.length, `${s.dir}: ${lines.length} dòng`).toBeLessThanOrEqual(150)
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
