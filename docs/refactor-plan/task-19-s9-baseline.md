# Task 19 — S-9 gate cuối + baseline snapshot + export bản sạch + prioritization

**Wave:** 4 · **Người phụ trách:** C · **Effort:** 8 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Pha gate cuối (Phases §6.4 S-9.x, §6.5): completeness & assumption sweep, business goal validation, prioritization (thay UC34/35), baseline sign-off quét lại tất định trên `spine_version` hiện tại, snapshot, `v1.0-conditional` khi có waive; export bản sạch từ snapshot.

## Lệch hướng audit cần đóng
A5 (baselineVersion chuỗi cứng, không snapshot), C5 (không luật kiểm), C7 (baseline theo đủ section thay vì cờ đỏ = 0), B8 (MoSCoW ở phase 3, bỏ qua canModify).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `modules/spine/{flags.service.ts, deterministic-check.ts, section-status.ts, baseline.model.ts}`, `modules/render/assemble.service.ts` (T15), `modules/pipeline/step-runner.service.ts` (T13), `assets/prompts/priority_ranking.md` (nội dung tái dùng).
- Sửa: `flintflow_be/src/modules/pipeline/step-runner.service.ts` (S-9.x là step `deterministic=true` trừ S-9.3/S-9.4: không Meter cho 9.1/9.5).
- Sửa: `flintflow_be/src/modules/render/assemble.service.ts` (`source=baseline` đọc `Baseline.snapshot`).
- Sửa: `flintflow_be/src/modules/notification/notification.service.ts` gọi khi baseline tạo.
- Gỡ khỏi route: `POST /specifications/:projectId/generate-priority`, `generate-scope`, `approve-baseline` (file xoá ở T21).
### Tạo mới / điền
- `flintflow_be/src/modules/pipeline/s9/completeness-sweep.ts` (S-9.1: `flags.recompute({atBaseline:true})`; rà `assumptions[status=unconfirmed]` sinh trong SRS để UI duyệt lẻ/lô; chạy lại S-8.1 glossary nếu `spine_version` lớn hơn version lúc S-8.1).
- `flintflow_be/src/modules/pipeline/s9/goal-validation.ts` (S-9.3: skill nhẹ đối chiếu `project.goals[]` với `use_cases[]/functions[]`; kết quả là cờ vàng `goal_not_covered` không chặn).
- `assets/skills/content/prioritization/SKILL.md` + `s9/prioritization.ts` (S-9.4: MoSCoW ghi `functions[].priority`, `nfrs[].priority` bằng op `set`; tái dùng luật từ `priority_ranking.md`; Won't-have không tự động chuyển scope (audit §4 câu 13): ghi cảnh báo nếu `release_scope.out` không khớp).
- `flintflow_be/src/modules/pipeline/s9/baseline.service.ts` (S-9.5: `signOff(projectId, userId)`: quét lại tất định trên `spine_version` hiện tại, ghi `checked_at_version`; cờ đỏ `resolved_at=null && !waived` phải = 0 (else 409 `RED_FLAGS_OPEN` kèm danh sách); `spine_version` đổi giữa quét và ký trả 409 quét lại; version `v1.0` / `v1.0-conditional` (waived_count > 0), lần sau `v1.1…`; `Baseline.create({snapshot: deep copy Spine, changes tới seq})`; `spine.baselines[]` push `{id, version, at, snapshot_ref, checked_at_version, waived_count}`; step S-9.5 accepted; notify).
- Routes: `POST /projects/:id/baseline`, `GET /projects/:id/baselines`, `GET /projects/:id/baselines/:baselineId/document` (uỷ quyền assemble).
- Điền `assets/skills/output/srs-completeness-score/SKILL.md` (công thức điểm sẵn sàng, chỉ báo cáo).
- Test: `baseline.service.test.ts`, `prioritization.test.ts`, `s9.e2e.test.ts` (fixture qua S-9.1…9.5 tới baseline; sửa field rồi export baseline không đổi).

## Các bước implement
1. S-9.1 + S-9.5 (tất định) + routes + test.
2. Snapshot + export bản sạch (T15) + test bất biến "baseline không đổi".
3. S-9.4 prioritization skill + test; gỡ route UC34/35.
4. S-9.3 goal validation (cờ vàng).
5. Notify + swagger.

## Dependency
- Phụ thuộc: T09, T13, T15, T18 (S-8.1 để 9.1 chạy lại glossary), T04 (notify).
- Chặn: T21, T22, M4.
- Chạy song song với: T17, T18, T20.

## Output kỳ vọng
- Baseline có snapshot và điều kiện đúng tài liệu; export bản sạch từ snapshot; MoSCoW ở S-9.4.

## Tiêu chí hoàn thành (DoD)
- [ ] Fixture `POST /baseline` ra `v1.0`, snapshot lưu; waive 1 cờ ra `v1.0-conditional`; cờ không waive được mở thì 409.
- [ ] Sửa `actors[].name` sau baseline: `export?source=baseline` không đổi, `source=draft` có watermark.
- [ ] `spine_version` đổi giữa quét và ký trả 409 và quét lại thành công.
- [ ] Không còn route `generate-priority`, `generate-scope`, `approve-baseline`.
- [ ] Hết credit vẫn ký baseline được (không Meter).

## Ghi chú / rủi ro
- S-9.2 Quality Lens LLM hoãn (Phases §9.1); để flag `REVIEW_LLM_ENABLED`.
- Không ngưỡng phần trăm.
