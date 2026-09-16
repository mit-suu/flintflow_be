/** Đọc 10 ca op T02 (`fixtures/op-cases/case-XX.json`) và áp `spine_before_overrides` dạng path chấm. */
import { readFixtureJson } from "../setup.js"
import { SYSTEM_MANAGED_ROOTS } from "../../src/modules/spine/change.service.js"

export interface OpCaseFile {
  name: string
  step_id: string
  spine_before_ref: string
  spine_before_overrides?: Record<string, unknown>
  prompt_context: string
  expected_ops: Array<Record<string, unknown> & { op: string; path: string }>
  must_reject?: string
}

export const OP_CASE_FILES = Array.from({ length: 10 }, (_, i) => `case-${String(i + 1).padStart(2, "0")}.json`)

export const loadOpCase = (file: string): OpCaseFile => readFixtureJson<OpCaseFile>("op-cases", file)

export const applyOverrides = (spine: Record<string, unknown>, overrides: Record<string, unknown> | undefined): void => {
  for (const [dotted, value] of Object.entries(overrides ?? {})) {
    const keys = dotted.split(".")
    let node = spine
    for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>
    node[keys[keys.length - 1]] = value
  }
}

/** Bỏ op vào gốc do hệ thống quản lý — /changes từ chối `path_not_writable` (pipeline-contract.md §1). */
export const userWritableOps = <T extends { path: string }>(ops: T[]): T[] =>
  ops.filter((op) => !SYSTEM_MANAGED_ROOTS.has(op.path.split(/[.[]/)[0]))
