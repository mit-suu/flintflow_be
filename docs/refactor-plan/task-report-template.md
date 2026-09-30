# Mẫu báo cáo sau mỗi task / mỗi phiên làm việc (bắt buộc)

> Copy toàn bộ khối dưới, điền đủ 9 mục, dán vào mô tả PR **và** gửi cho người điều phối. Không bỏ mục nào; mục không có nội dung ghi "Không có".
> Với AI agent: đây là output cuối cùng của phiên, in nguyên văn, không tóm tắt lại bằng lời khác.

```markdown
# BÁO CÁO TASK <TXX> — <tên task> · Wave <N> · Người: <A/B/C/D> · Ngày: <YYYY-MM-DD>

## 1. Trạng thái
- Trạng thái: Chưa làm | Đang làm | Xong
- Nhánh: feat/tXX-<slug> · Commit cuối: <sha ngắn> · PR: <link hoặc "chưa mở">
- % ước lượng hoàn thành: <n>% · Effort đã dùng / ước lượng: <x> / <y> điểm

## 2. Đã làm (theo bước trong file task)
| Bước | Mô tả ngắn | Kết quả |
|---|---|---|
| 1 | … | Xong / Một phần / Chưa |

## 3. File đã thay đổi (đối chiếu bảng vùng sở hữu trong coding-rules.md mục 2)
| File | Loại (tạo/sửa/xoá) | Trong vùng sở hữu? | Ghi chú |
|---|---|---|---|
| flintflow_be/src/modules/spine/op-engine.ts | tạo | S | |
| … | | | |
Tổng: <n> file · Dòng +<a> / -<b> (từ `git diff --stat develop...HEAD`)

## 4. Thay đổi ngoài vùng sở hữu (phải rỗng, hoặc có XREQ được granted)
| File | Lý do | Issue XREQ | Ai granted |
|---|---|---|---|
| Không có | | | |

## 5. Hợp đồng / interface bị ảnh hưởng
- Có đụng hợp đồng đóng băng không: Không | Có → PR contract-change: <link>, trạng thái duyệt: <n>/4
- Interface mới mà task khác sẽ dùng (tên hàm/endpoint/kiểu, file): …

## 6. Kiểm chứng (dán output thật, không mô tả)
- `npm run typecheck` (BE/FE): <pass/fail, dòng lỗi nếu có>
- `npm run lint` (FE): <pass/fail>
- `npm test`: <n passed / m failed / k skipped>, thời gian; test bị skip và lý do: …
- Test chạy thủ công (curl, UI, docker): lệnh + kết quả tóm tắt
- DoD trong file task: <k>/<n> đã tick; mục chưa tick và lý do: …

## 7. Bị chặn / cần quyết định
| Vấn đề | Cần ai | Đề xuất của tôi | Mức khẩn |
|---|---|---|---|
| Không có | | | |

## 8. Phát hiện ngoài phạm vi (KHÔNG sửa, chỉ ghi)
| Vị trí (file:dòng) | Vấn đề | Thuộc task nào | Đã ghi docs/spec-gaps.md? |
|---|---|---|---|
| Không có | | | |

## 9. Bước tiếp theo
- Việc còn lại của task này: …
- Ảnh hưởng tới merge point <Mn>: Không | Có → …
- Đề xuất (dependency mới, đổi ước lượng, đổi phân công): …
```

## Quy tắc chấm báo cáo (người điều phối)

| Kiểm | Đạt khi |
|---|---|
| Mục 3 | Mọi file có cột "Trong vùng sở hữu?" = S hoặc S*; file R/— phải xuất hiện ở mục 4 kèm XREQ |
| Mục 4 | Rỗng, hoặc mỗi dòng có issue XREQ và tên người granted |
| Mục 5 | Nếu "Có" thì PR contract-change tồn tại và có 4/4 approve trước khi merge |
| Mục 6 | Có output lệnh thật; test fail phải được giải thích, không được ẩn |
| Mục 8 | Mỗi phát hiện có file:dòng; không có commit sửa tương ứng trong PR |
| Mục 9 | Nếu trạng thái "Xong" thì mục 9 dòng đầu ghi "Không còn" và DoD tick 100% |

Báo cáo không đạt một trong các mục trên → trả lại, task giữ trạng thái "Đang làm".
