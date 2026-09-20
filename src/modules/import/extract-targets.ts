/**
 * Thực thể cần trích theo section + đoạn schema gửi cho model (I-4). FLF-171, plan §6 2C.
 * Chỉ gửi tên field + enum của mảng đích (không gửi cả JSON Schema — giữ prompt nhỏ, P0 §4.8).
 */

import { PROVISIONAL_SECTION } from "./section-catalog.js"

export const SECTION_TARGETS: Readonly<Record<string, readonly string[]>> = {
  "fixed:1": ["project"],
  "fixed:2.1": ["actors", "roles"],
  "fixed:2.2.1": ["use_cases"],
  "fixed:2.2.2": ["use_cases"],
  "fixed:3.1.1": ["screens"],
  "fixed:3.1.2": ["screens"],
  "fixed:3.1.3": ["permissions"],
  "fixed:3.1.4": ["functions"],
  "fixed:3.1.5": ["entities"],
  "fixed:4.1": ["nfrs"],
  "fixed:4.2.1": ["nfrs"],
  "fixed:4.2.2": ["nfrs"],
  "fixed:4.2.3": ["nfrs"],
  "fixed:4.2.4": ["nfrs"],
  "fixed:5.1": ["business_rules"],
  "fixed:5.2": ["common_requirements"],
  "fixed:5.3": ["messages"],
  "fixed:5.4": ["other_requirements"],
  "fixed:5.5": ["glossary"]
}

/** Category NFR theo section (model không phải đoán). */
export const NFR_CATEGORY_BY_SECTION: Readonly<Record<string, string>> = {
  "fixed:4.1": "interface",
  "fixed:4.2.1": "usability",
  "fixed:4.2.2": "reliability",
  "fixed:4.2.3": "performance",
  "fixed:4.2.4": "other"
}

export const targetsOf = (sectionId: string): readonly string[] => {
  const m = PROVISIONAL_SECTION.exec(sectionId)
  if (m) return m[1] === "function" ? ["functions"] : []
  return SECTION_TARGETS[sectionId] ?? []
}

/** Section có trích (Record of Changes là dẫn xuất, không trích). */
export const isExtractableSection = (sectionId: string): boolean => sectionId !== "fixed:I" && (PROVISIONAL_SECTION.test(sectionId) || sectionId in SECTION_TARGETS)

export const SCHEMA_EXCERPT: Readonly<Record<string, string>> = {
  project: "project: { vision: string, goals: string[], type: string, domain: string } — product-level facts only",
  actors: 'actors[]: { name, kind: "human" | "system" | "time", description }',
  roles: "roles[]: { name, actor_id: <actor id or null> }",
  use_cases: "use_cases[]: { name, actor_ids: <actor ids from known_keys>, description, includes: <use case ids>, extends: <use case ids> }",
  features: "features[]: { name }",
  screens: "screens[]: { name, description, is_popup: boolean, tabs: string[] }",
  permissions: 'permissions[]: { screen_id, role_id, action: "view" | "create" | "update" | "delete" | <verb> }',
  entities: "entities[]: { name, description, relations: <entity ids> }",
  functions:
    'functions[]: { name, trigger, description, normal: string[] (main flow steps), abnormal: string[] (alternative/exception flows), validations: [{ kind: "business" | "format" | "required", statement }], priority: "must" | "should" | "could" | "wont" | null }',
  nfrs: 'nfrs[]: { statement, kind: "quantitative" | "descriptive", metric?, threshold?, priority }',
  business_rules: 'business_rules[]: { statement, tier: "high" | "detail" }',
  common_requirements: "common_requirements[]: { category, statement }",
  messages: "messages[]: { code, text }",
  other_requirements: 'other_requirements[]: { kind: "risk" | "assumption" | "open_question" | "technical_risk", statement }',
  glossary: "glossary[]: { term, definition }"
}

export const schemaExcerptFor = (targets: readonly string[]): string => targets.map((t) => `- ${SCHEMA_EXCERPT[t] ?? t}`).join("\n")
