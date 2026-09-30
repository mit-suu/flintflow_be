# Task 09 — Section registry (profile FPT) + status() + deterministic check + flags/waiver

**Wave:** 2 · **Người phụ trách:** B · **Effort:** 13 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Thay "25 section type" bằng danh sách section FPT theo khoá logic, bảng ánh xạ field → section 3 cột (srs-spine §4), `status()` là hàm tính (§5), 10 luật cờ đỏ + 6 luật vàng cardinality (§7, §8.1), khoá `flags[]`, waiver có hạn. Cung cấp `GET /progress` mới thay `phase-gate`.

## Lệch hướng audit cần đóng
A3 (danh sách section sai template), A7 (status lưu, thiếu stale/derived), C5 (không có luật kiểm), C7 phần luật (điều kiện baseline), C9 (progress đếm section thay vì step).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `context/srs-spine.md` §4, §4.1, §4.2, §5, §6, §7, §7.1, §8.1; `flintflow_be/src/modules/spine/*` (T01, T08 `reference-fields.ts`).
- Sửa: `flintflow_be/src/modules/spine/invariants.ts` (T08) để dùng `REQUIRED_SECTIONS` từ registry.
- Sửa: `flintflow_be/src/app.ts` mount route flags/progress.
- Không xoá `shared/constants/section-types.ts` (T21).
### Tạo mới
- `flintflow_be/src/modules/spine/section-registry.ts` — `SectionDef {id, title_en, required: bool, derived: bool, level, order, parent?}` cho `fixed:I, fixed:1, fixed:2.1, fixed:2.2.1, fixed:2.2.2, fixed:3.1.1…3.1.5, fixed:4.1, fixed:4.2.1…4.2.4, fixed:5.1…5.5` + generator cho `feature:<id>`, `function:<id>`; `FIELD_SECTION_MAP: {fieldPattern, owner: sectionId[], reads: sectionId[], derived: sectionId[] | diagramKind[]}` đúng bảng §4; `stepsOf(sectionId)` (nghịch đảo qua step registry T12; trước khi T12 merge dùng bảng tạm), `sectionsOf(fieldPath)`, `listSections(spine)` (mở rộng feature/function theo dữ liệu).
- `flintflow_be/src/modules/spine/section-status.ts` — `computeStatus(spine, changes, sectionId)`: derived / stale (tồn tại field nuôi có `changes.seq` lớn hơn `accepted_at` của step muộn nhất nuôi) / accepted / draft; `awaitingReaccept(sectionId)`; `readiness(spine, changes)` = `{acceptedPct, awaitingReaccept, redOpen, stale}`; `progressByStep(spine)` = `{done, total, currentPhase, currentStep, showPercent: N đã chốt}`.
- `flintflow_be/src/modules/spine/source-hash.ts` — hash projection theo §7.1 cho 5 kind.
- `flintflow_be/src/modules/spine/deterministic-check.ts` — `runDeterministicCheck(spine, changes): FlagCandidate[]` với 10 luật đỏ (`section_empty, array_empty, dead_reference, render_error, diagram_stale, nfr_missing_number, unconfirmed_assumption, section_stale_at_baseline, section_awaiting_reaccept, screen_pending_at_baseline`) + 6 vàng (`orphan_actor, usecase_no_function, screen_no_function, empty_feature, role_no_actor, non_english_content`), mỗi luật `{rule_id, level, waivable, remediation_step(target)}`; luật gắn S-9 (`unconfirmed_assumption`, `*_at_baseline`) nhận cờ `atBaseline`.
- `flintflow_be/src/modules/spine/flags.service.ts` — `recompute(projectId, {atBaseline})`: khoá `(level, rule_id, section_id, target_id, resolved_at=null)`, mở cờ mới, đóng cờ không còn (`resolved_at`), waiver hết hạn khi `spine_version` khác `waived_at_version` và điều kiện còn; `waive(projectId, flagId, reason, userId)` (≥ 20 ký tự, cấm `array_empty/dead_reference/render_error`); `listFlags(projectId, {level, open})`.
- `flintflow_be/src/modules/spine/flags.controller.ts` + `flags.route.ts` — `GET /projects/:id/flags`, `POST /projects/:id/flags/recompute`, `POST /projects/:id/flags/:flagId/waive`, `GET /projects/:id/progress` (readiness + progressByStep + status từng section).
- Test: `section-registry.test.ts`, `section-status.test.ts`, `deterministic-check.test.ts`, `flags.service.test.ts`.
- Điền `assets/skills/action/deterministic-check/references/rules.md` (bảng luật, dùng làm tài liệu, không gọi model).

## Các bước implement
1. Registry + bảng §4 (copy nguyên văn, có test đối chiếu số dòng với tài liệu).
2. `computeStatus` + test 4 trạng thái và `awaiting_reaccept`.
3. `source-hash` + test ổn định.
4. 16 luật + test trên fixture đầy đủ (0 đỏ) và fixture biến thể (xoá actor tạo `dead_reference` + `array_empty`; nfr thiếu metric tạo `nfr_missing_number`; màn pending + atBaseline tạo `screen_pending_at_baseline`).
5. flags.service với khoá, waiver, hết hạn + test.
6. Routes + swagger.

## Dependency
- Phụ thuộc: T01, T02; `reference-fields.ts` của T08 (merge sớm) — nếu chưa có, tạo tạm rồi hợp nhất.
- Chặn: T13, T15, T16, T17, T19.
- Chạy song song với: T08, T10, T11, T12.

## Output kỳ vọng
- Module kiểm tất định hoàn chỉnh, route flags/progress chạy trên fixture.

## Tiêu chí hoàn thành (DoD)
- [ ] Fixture đầy đủ cho 0 cờ đỏ, cờ vàng chỉ do màn `placeholder` (`screen_no_function` nếu có).
- [ ] Waive luật không waive được trả 400; waive hợp lệ đặt `waived_by_user=true`; đổi `spine_version` mà lỗi còn thì cờ mở lại.
- [ ] `GET /progress` trả `showPercent=false` khi N chưa chốt.
- [ ] Mọi cờ đỏ có `remediation_step` không rỗng (test quét).

## Ghi chú / rủi ro
- Không đặt ngưỡng phần trăm ở đâu cả (Phases §6.5).
- Bảng §4 là nguồn sự thật; nếu thấy tài liệu thiếu field nào (vd `functions[].priority`), ghi vào `docs/spec-gaps.md` thay vì tự bịa ánh xạ.
