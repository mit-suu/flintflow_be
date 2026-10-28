# Font đóng gói cho sơ đồ SVG (FLF-339)

Liberation Sans **2.1.5** (metric-compatible Arial), license SIL OFL 1.1 (`LICENSE`).
Nguồn: release `2.1.5` của github.com/liberationfonts/liberation-fonts, file
`liberation-fonts-ttf-2.1.5.tar.gz` (SHA-256 `7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0`).

Dùng ở hai chỗ, cùng một file nên đo chữ và vẽ PNG khớp nhau:

- `src/shared/diagram/svg-kit-metrics.ts` — bảng advance width sinh bằng `npm run svg:metrics`.
- `src/shared/diagram/svg-to-png.ts` — resvg chỉ nạp các file này (`loadSystemFonts: false`; image alpine không có font).

Đổi font ⇒ chạy lại `npm run svg:metrics` và cập nhật hash dưới đây (`svg-kit.test.ts` kiểm cả hai).

```
76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8  LiberationSans-Regular.ttf
788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173  LiberationSans-Bold.ttf
```
