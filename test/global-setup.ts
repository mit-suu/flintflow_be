/**
 * global-setup.ts (T22)
 * ─────────────────────────────────────────────────────────────────
 * Dựng MỘT Mongo in-memory replica set (1 node ⇒ có transaction, đúng nhánh chạy production) cho cả lượt
 * test, đưa URI xuống worker qua `provide("mongoUri")`. Mỗi worker dùng database riêng (xem `setup.ts`)
 * nên các file test chạy song song không giẫm dữ liệu của nhau.
 */
import type { TestProject } from "vitest/node"
import { MongoMemoryReplSet } from "mongodb-memory-server"

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string
  }
}

let replSet: MongoMemoryReplSet | undefined

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Hai project (integration, e2e-ai) cùng khai global setup: dùng chung một server
  replSet ??= await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } })
  project.provide("mongoUri", replSet.getUri())
  return async () => {
    if (!replSet) return
    const current = replSet
    replSet = undefined
    await current.stop()
  }
}
