import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Test colocate cạnh code: src/**/*.test.ts
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Mongo in-memory và PlantUML probe cần thời gian khởi động
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
