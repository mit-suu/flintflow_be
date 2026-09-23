import { defineConfig } from "vitest/config"

/**
 * Ba project (T22):
 *   - unit:        test colocate cạnh code `src/**\/*.test.ts` — model giả, KHÔNG nối Mongo.
 *                  Không gắn setup Mongo ở đây: nhiều test dựa vào `mongoose.connection.readyState !== 1`
 *                  để đi nhánh `TRANSACTION_UNAVAILABLE` với model giả.
 *   - integration: `test/integration/**` — Mongo in-memory (replica set 1 node, có transaction) + supertest
 *                  qua `app` thật, provider AI giả lập.
 *   - e2e-ai:      `test/e2e-ai/**` — provider thật, chỉ chạy khi `E2E_AI=1` (`npm run test:e2e-ai`).
 * `test/global-setup.ts` chỉ dựng Mongo khi có project cần (integration/e2e-ai được chọn).
 */
const shared = {
  environment: "node",
  // Mongo in-memory và PlantUML probe cần thời gian khởi động
  testTimeout: 30_000,
  hookTimeout: 60_000
} as const

export default defineConfig({
  test: {
    ...shared,
    projects: [
      {
        test: { ...shared, name: "unit", include: ["src/**/*.test.ts"] }
      },
      {
        test: {
          ...shared,
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["test/global-setup.ts"],
          setupFiles: ["test/setup.ts"]
        }
      },
      {
        test: {
          ...shared,
          name: "e2e-ai",
          include: ["test/e2e-ai/**/*.test.ts"],
          globalSetup: ["test/global-setup.ts"],
          setupFiles: ["test/setup.ts"],
          // Gọi model thật: một ca có thể mất cả phút
          testTimeout: 180_000
        }
      }
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/_archive/**", "src/scripts/**"],
      // Ngưỡng cho lõi mới (T22 DoD): Spine + pipeline ≥ 70% lines.
      // Mode 1 v2 (V6 DoD): import / change-request / render ≥ 80% — đo được 97–99% lúc chốt V6, đặt ngưỡng
      // để lần sửa sau không âm thầm tụt xuống chứ không phải để vừa đủ qua.
      thresholds: {
        "src/modules/spine/**": { lines: 70 },
        "src/modules/pipeline/**": { lines: 70 },
        "src/modules/import/**": { lines: 80 },
        "src/modules/change-request/**": { lines: 80 },
        "src/modules/render/**": { lines: 80 }
      }
    }
  }
})
