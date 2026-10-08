# Task 24 — Vận hành: docker compose BE/FE, PlantUML, env, health, hardening

**Wave:** 5 · **Người phụ trách:** C · **Effort:** 4 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Chạy trọn hệ thống mới bằng một lệnh `docker compose up`, đủ biến môi trường mới, health check báo Mongo/PlantUML, gỡ URL/secret hardcode.

## Lệch hướng audit cần đóng
Nợ kỹ thuật vận hành (URL Modal hardcode, Google client ID trong repo, compose thiếu BE/FE, replica set cho transaction).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Sửa: `flintflow_be/docker-compose.yml` (thêm `backend`, `frontend`, `mongo` chạy `--replSet rs0` + init job, `plantuml` pin tag `plantuml/plantuml-server:jetty-v1.2025.x`, network, volumes), `flintflow_be/Dockerfile`/`Dockerfile.dev` (copy `assets/`, `fixtures/`), `flintflow_fe/Dockerfile`.
- Sửa: `flintflow_be/src/config/env.ts` (gỡ default URL Modal ở L85; thêm `PAYMENT_WEBHOOK_SECRET`, `CREDIT_RESERVE_TTL_MS`, `REVIEW_LLM_ENABLED`, `E2E_AI`, `AI_PROVIDER_DEFAULT`, `DIAGRAM_STORAGE=gridfs`), `shared/ai/providers/glm.provider.ts:31`, `ai-sdk.provider.ts:35,91` (gỡ default URL), `.env.example` BE/FE đầy đủ, `flintflow_fe/.env.local` gỡ khỏi git (thêm `.gitignore`) và thu hồi client ID nếu đã lộ.
- Sửa: `flintflow_be/src/config/startup-checks.ts` (kiểm `isPlantUmlReachable()` thành warn, không exit), `flintflow_be/src/app.ts` `/health` trả `{mongo, plantuml, version, assets}`.
- Sửa: `.github/workflows/docker-build.yml` (build cả 2 image), `deploy.yml` nếu còn dùng.
### Tạo mới
- `docs/ops.md` (chạy local, compose, env, seed admin/fixture, backup Mongo, xoay secret).
- `flintflow_be/scripts/mongo-init-rs.sh`.

## Các bước implement
1. Compose + replica set + PlantUML pin; kiểm transaction hoạt động (op engine 409 test qua compose).
2. Env + gỡ hardcode; `.env.example`.
3. Health + startup check.
4. CI docker build; docs.
5. Chạy e2e T23 trong compose.

## Dependency
- Phụ thuộc: Wave 4; T23 (e2e để kiểm).
- Chặn: M5.
- Chạy song song với: T21, T22, T23.

## Output kỳ vọng
- `docker compose up` chạy BE/FE/Mongo/PlantUML; health xanh; không còn secret/URL hardcode.

## Tiêu chí hoàn thành (DoD)
- [ ] `docker compose up -d && curl localhost:5000/health` trả `mongo: ok, plantuml: ok`.
- [ ] `grep -rn "modal.direct" flintflow_be/src` rỗng; `git ls-files | grep .env.local` rỗng.
- [ ] e2e T23 pass trong compose.
- [ ] `docs/ops.md` đủ mục.

## Ghi chú / rủi ro
- Nếu replica set 1 node gây chậm dev, giữ fallback standalone đã có trong `ai-action.service.ts`; op engine chỉ cần `findOneAndUpdate` có điều kiện, không cần transaction đa document.
