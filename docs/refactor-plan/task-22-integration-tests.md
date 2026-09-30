# Task 22 — Bộ test tích hợp + đo token end-to-end trên fixture

**Wave:** 5 · **Người phụ trách:** B · **Effort:** 6 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Nâng test từ 2 file lên bộ tích hợp có DB (mongodb-memory-server) và HTTP (supertest) cho toàn bộ lõi mới; chạy 10 ca op với provider thật (gated); đo token end-to-end fixture 19 màn (rủi ro gốc Phases §9.3 và srs-spine §10); coverage threshold cho lõi.

## Lệch hướng audit cần đóng
§6 audit (thiếu test coverage), Phases §9.3 bước 0 (đo token, 10 ca op).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Sửa: `flintflow_be/vitest.config.ts` (setup file, `coverage.thresholds` cho `src/modules/spine/**`, `src/modules/pipeline/**` ≥ 70% lines), `flintflow_be/package.json` (thêm `mongodb-memory-server`, `supertest`, `@vitest/coverage-v8`; script `test:e2e-ai`), `.github/workflows/ci.yml` (test BE + FE, upload coverage).
- Đọc: mọi `*.test.ts` đã có từ T01–T20 (gom vào cấu trúc chung, không viết lại).
### Tạo mới
- `flintflow_be/test/setup.ts` (memory server, seed fixture helper `seedFixture(kind)`, `authAs(user)` trả token).
- `flintflow_be/test/integration/{spine-api.test.ts, op-engine.int.test.ts, flags.int.test.ts, pipeline-s3.int.test.ts, change-flow.int.test.ts, baseline-export.int.test.ts, billing.int.test.ts, notification.int.test.ts}` — qua HTTP với mock provider.
- `flintflow_be/test/e2e-ai/op-cases.e2e.test.ts` — 10 ca op T02 với provider thật (`E2E_AI=1`), báo tỉ lệ pass.
- `flintflow_be/src/scripts/measure-tokens.ts` — chạy fixture minimal qua B-0.1 đến S-9.5 (mock provider cho phần chat trả lời, provider thật cho draft; hoặc toàn provider thật với `--real`), gom `usage[]` theo step/phase/call_kind, ghi `docs/measurements.md` (bảng token in/out, credit, chi phí USD ước tính, so với ngưỡng `docs/measurements.md#threshold` do nhóm đặt).
- `docs/testing.md` (cách chạy unit/integration/e2e-ai, biến môi trường).

## Các bước implement
1. Setup memory server + helper; chuyển test có DB hiện có sang setup chung.
2. Viết integration test theo danh sách; mock provider trả op từ `fixtures/op-cases`.
3. E2E-AI op cases; script đo token; chạy 1 lần `--real` ghi kết quả.
4. Coverage + CI.

## Dependency
- Phụ thuộc: toàn bộ Wave 4; T21 merge trước để test không bám legacy.
- Chặn: M5.
- Chạy song song với: T21, T23, T24.

## Output kỳ vọng
- CI chạy unit + integration BE/FE; `docs/measurements.md` có số end-to-end.

## Tiêu chí hoàn thành (DoD)
- [ ] CI xanh; coverage lõi ≥ 70%.
- [ ] `E2E_AI=1` op cases: ≥ 8/10 pass ở lần chạy ghi nhận (ghi số thật, không làm tròn).
- [ ] `docs/measurements.md` có tổng token và chi phí fixture 19 màn, so với ngưỡng.

## Ghi chú / rủi ro
- Nếu chi phí tăng bậc hai theo step (input tăng theo tiến độ), mở issue cho T11 projection; không sửa trong task này.
