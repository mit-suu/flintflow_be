# ScreenSpec blocks

Code loads this reference into the screen-layout prompt. Each block is one JSON object; optional keys may be
left out, unknown keys or types make the whole spec invalid.

| `type` | Keys | Draws |
| --- | --- | --- |
| `fields` | `items[]`: `label`, `required?`, `kind?` (`text` · `password` · `date` · `select` · `textarea`), `placeholder?` (≤ 12 items) | Label + boxed input, `columns` per row on web |
| `checkbox` | `label?` (one box) or `options[]` (several boxes) | Checkbox(es) |
| `radio` | `label?`, `options[]` (first is selected) | Radio group |
| `buttons` | `items[]`: `label`, `primary?` (≤ 4) | Buttons on one row (web) / full width (mobile); `primary` = solid |
| `link` | `text` | Text link |
| `text` | `text`, `strong?` | Paragraph / message |
| `search` | `placeholder`, `button?` | Search box (+ button) |
| `inline` | `placeholder`, `button` | Input and button on one row (voucher, invite) |
| `items` | `items[]`: `name`, `meta?`, `price?`, `qty?` (≤ 4) | Cards with an image placeholder (cart, product list) |
| `table` | `columns[]` (≤ 6), `rows[][]` (≤ 5 sample rows) | Data table |
| `summary` | `rows[]`: `[label, value]` or `[label, value, true]` for the bold total | Key / value lines (order totals) |
| `image` | `label` | Picture / map / chart placeholder |

## Example 1: Sign Up (web + mobile, 2 columns)

```json
{"spec":{"title":"Create your account","path":"/signup","platforms":["web","mobile"],"back":true,"columns":2,
"blocks":[
 {"type":"fields","items":[{"label":"Full name","required":true,"placeholder":"Nguyen Van An"},
  {"label":"Email","required":true,"placeholder":"an.nguyen@example.com"},
  {"label":"Phone number","required":true,"placeholder":"0912345678"},
  {"label":"Password","required":true,"kind":"password"},
  {"label":"Confirm password","required":true,"kind":"password"},
  {"label":"Date of birth","kind":"date","placeholder":"DD/MM/YYYY"}]},
 {"type":"checkbox","label":"I agree to the Terms of Use and Privacy Policy"},
 {"type":"buttons","items":[{"label":"Create account","primary":true},{"label":"Sign up with Google"}]},
 {"type":"link","text":"Already have an account? Log in"}]}}
```

## Example 2: Inventory (admin, web only)

```json
{"spec":{"title":"Inventory","path":"/admin/inventory","platforms":["web"],
"nav":["Dashboard","Products","Inventory","Orders"],"columns":3,
"blocks":[
 {"type":"search","placeholder":"Search by product name or SKU","button":"Search"},
 {"type":"fields","items":[{"label":"Category","kind":"select","placeholder":"All categories"},
  {"label":"Warehouse","kind":"select","placeholder":"Ha Noi"},
  {"label":"Updated from","kind":"date","placeholder":"01/11/2026"}]},
 {"type":"table","columns":["SKU","Product","In stock","Status"],
  "rows":[["SS-S24-128","Galaxy S24 128GB","12","Available"],["AP-PRO2","AirPods Pro 2","4","Low stock"]]},
 {"type":"buttons","items":[{"label":"Add stock","primary":true},{"label":"Export CSV"}]}]}}
```
