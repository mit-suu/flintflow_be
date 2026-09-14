/**
 * Fake Mongoose model trong bộ nhớ cho unit test billing/credit/notification.
 * Repo chưa có mongodb-memory-server (T22 sẽ thêm), nên chỉ hỗ trợ đúng
 * tập query mà các service này dùng: so khớp bằng, $gte/$lte/$gt/$lt/$in/$ne,
 * $expr {$gte:[{$subtract:[…]}, n]}, update $set/$inc/$setOnInsert, upsert,
 * options sort/skip/limit.
 */
import mongoose from "mongoose"

type Doc = Record<string, any>

const isObjectId = (v: unknown): boolean => v instanceof mongoose.Types.ObjectId

const isOperatorObject = (v: unknown): v is Record<string, any> =>
  Boolean(v) &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !isObjectId(v) &&
  Object.keys(v as object).some((k) => k.startsWith("$"))

const normalize = (v: any) => (v instanceof Date ? v.getTime() : isObjectId(v) ? String(v) : v)

const equals = (a: any, b: any): boolean => {
  if (b === null) return a === null || a === undefined
  return String(normalize(a)) === String(normalize(b))
}

const evalExpr = (doc: Doc, expr: any): any => {
  if (typeof expr === "string" && expr.startsWith("$")) return doc[expr.slice(1)]
  if (expr && typeof expr === "object") {
    if ("$gte" in expr) return evalExpr(doc, expr.$gte[0]) >= evalExpr(doc, expr.$gte[1])
    if ("$subtract" in expr) return evalExpr(doc, expr.$subtract[0]) - evalExpr(doc, expr.$subtract[1])
  }
  return expr
}

const matches = (doc: Doc, filter: Doc = {}): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === "$expr") return Boolean(evalExpr(doc, cond))
    const value = doc[key]
    if (!isOperatorObject(cond)) return equals(value, cond)
    return Object.entries(cond).every(([op, arg]) => {
      const v = normalize(value)
      const a = normalize(arg)
      switch (op) {
        case "$gte": return v >= a
        case "$gt": return v > a
        case "$lte": return v <= a
        case "$lt": return v < a
        case "$ne": return !equals(value, arg)
        case "$in": return (arg as any[]).some((x) => equals(value, x))
        default: throw new Error(`fake-mongo: operator ${op} chưa hỗ trợ`)
      }
    })
  })

const applyUpdate = (doc: Doc, update: Doc, inserting: boolean) => {
  const hasOperators = Object.keys(update).some((k) => k.startsWith("$"))
  if (!hasOperators) {
    Object.assign(doc, update)
    return
  }
  if (update.$set) Object.assign(doc, update.$set)
  if (inserting && update.$setOnInsert) Object.assign(doc, update.$setOnInsert)
  if (update.$inc) {
    for (const [k, n] of Object.entries(update.$inc)) doc[k] = (doc[k] ?? 0) + (n as number)
  }
  doc.updatedAt = new Date()
}

let clock = 0

export const createFakeModel = () => {
  const docs: Doc[] = []

  const materialize = (input: Doc): Doc => {
    const now = new Date(Date.now() + clock++)
    const doc: Doc = { _id: new mongoose.Types.ObjectId(), createdAt: now, updatedAt: now, ...input }
    Object.defineProperty(doc, "save", { enumerable: false, value: async () => doc })
    docs.push(doc)
    return doc
  }

  const query = (filter: Doc, options: Doc = {}) => {
    let result = docs.filter((d) => matches(d, filter))
    if (options.sort) {
      const [[field, dir]] = Object.entries(options.sort as Record<string, number>)
      result = [...result].sort((a, b) => (normalize(a[field]) > normalize(b[field]) ? dir : -dir))
    }
    if (options.skip) result = result.slice(options.skip)
    if (options.limit) result = result.slice(0, options.limit)
    return result
  }

  function create(input: Doc[], options?: unknown): Promise<Doc[]>
  function create(input: Doc, options?: unknown): Promise<Doc>
  async function create(input: Doc | Doc[], _options?: unknown): Promise<Doc | Doc[]> {
    if (Array.isArray(input)) return input.map(materialize)
    return materialize(input)
  }

  return {
    docs,
    reset: () => {
      docs.length = 0
    },
    create,
    async insertMany(input: Doc[]) {
      return input.map(materialize)
    },
    async findOne(filter: Doc, _projection?: unknown, _options?: unknown) {
      return query(filter)[0] ?? null
    },
    async find(filter: Doc, _projection?: unknown, options?: Doc) {
      return query(filter, options)
    },
    async countDocuments(filter: Doc) {
      return query(filter).length
    },
    async findOneAndUpdate(filter: Doc, update: Doc, options: Doc = {}) {
      const doc = query(filter)[0]
      if (doc) {
        applyUpdate(doc, update, false)
        return doc
      }
      if (!options.upsert) return null
      const seed = Object.fromEntries(Object.entries(filter).filter(([, v]) => !isOperatorObject(v)))
      const created = materialize(seed)
      applyUpdate(created, update, true)
      return created
    },
    async updateMany(filter: Doc, update: Doc) {
      const targets = query(filter)
      targets.forEach((d) => applyUpdate(d, update, false))
      return { modifiedCount: targets.length }
    }
  }
}

export type FakeModel = ReturnType<typeof createFakeModel>

const models = new Map<string, FakeModel>()

export const fakeDb = {
  model(name: string): FakeModel {
    if (!models.has(name)) models.set(name, createFakeModel())
    return models.get(name)!
  },
  reset() {
    models.forEach((m) => m.reset())
  }
}

/** Mongo standalone: startSession ném lỗi ⇒ service chạy nhánh không transaction. */
export const TRANSACTION_UNSUPPORTED = new Error(
  "Transaction numbers are only allowed on a replica set member or mongos"
)
