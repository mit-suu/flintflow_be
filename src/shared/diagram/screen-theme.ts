/**
 * Theme mockup màn hình của một dự án (§3.x.y Screen Layout, FLF-410): màu chính, domain hiện trên thanh địa chỉ, nền tảng
 * vẽ (web / mobile). Nằm ở `Project.screenTheme`, KHÔNG nằm trong Spine — renderer mockup là hàm thuần nhận theme qua
 * `RenderContext`; hash hình `screen_layout` gồm theme đã resolve nên đổi theme ⇒ `diagram_stale` ⇒ vẽ lại bằng spec đã
 * lưu, không gọi model.
 */

export const SCREEN_PLATFORMS = ["web", "mobile"] as const
export type ScreenPlatform = (typeof SCREEN_PLATFORMS)[number]

export interface ScreenTheme {
  /** `null` = chưa từng chọn ⇒ vẽ bằng `DEFAULT_PRIMARY_COLOR`; màu đọc từ ảnh gốc import chỉ tự điền khi còn `null`. */
  primaryColor: string | null
  /** Hostname (không scheme, không `/` cuối). `null` ⇒ thanh địa chỉ chỉ hiện đường dẫn. */
  domain: string | null
  /** `null` ⇒ suy từ `spine.project.form_factor`. */
  platforms: ScreenPlatform[] | null
}

/** Theme đã resolve — đúng thứ renderer dùng và đi vào hash hình. */
export interface ResolvedScreenTheme {
  primaryColor: string
  domain: string | null
  platforms: ScreenPlatform[]
}

export const DEFAULT_PRIMARY_COLOR = "#3F5591"
export const DEFAULT_SCREEN_THEME: ScreenTheme = Object.freeze({ primaryColor: null, domain: null, platforms: null }) as ScreenTheme

export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/
/** Nhãn DNS: chữ, số, gạch nối, không bắt đầu / kết thúc bằng gạch nối; có ít nhất một dấu chấm. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
export const MAX_DOMAIN_LENGTH = 253

/** Bỏ scheme, đường dẫn, cổng, dấu chấm cuối; chữ thường. Host không hợp lệ ⇒ null. */
export const normalizeDomain = (raw: string): string | null => {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
  return HOSTNAME.test(host) ? host : null
}

export const isPlatform = (v: unknown): v is ScreenPlatform => typeof v === "string" && (SCREEN_PLATFORMS as readonly string[]).includes(v)

/** Đọc theme đã lưu; field thiếu / sai kiểu ⇒ giá trị mặc định của field đó. */
export const screenThemeOf = (project: { screenTheme?: unknown } | null | undefined): ScreenTheme => {
  const raw = (project?.screenTheme ?? {}) as Record<string, unknown>
  const color = typeof raw.primaryColor === "string" && HEX_COLOR.test(raw.primaryColor) ? raw.primaryColor.toUpperCase() : null
  const domain = typeof raw.domain === "string" ? normalizeDomain(raw.domain) : null
  const platforms = Array.isArray(raw.platforms) ? SCREEN_PLATFORMS.filter((p) => (raw.platforms as unknown[]).includes(p)) : []
  return { primaryColor: color, domain, platforms: platforms.length > 0 ? platforms : null }
}

/**
 * Nền tảng vẽ: theme chọn tay ⇒ dùng; không ⇒ suy từ `form_factor` (FLF-237: mảng, mode 2 là `web_app` / `mobile_app`,
 * mode 1 có thể là chữ tự do như "Mobile application") — có web ⇒ web, có mobile ⇒ mobile, không khớp gì ⇒ web.
 */
export const resolvePlatforms = (theme: Pick<ScreenTheme, "platforms">, formFactor: readonly string[] | string | null | undefined): ScreenPlatform[] => {
  if (theme.platforms && theme.platforms.length > 0) return SCREEN_PLATFORMS.filter((p) => theme.platforms!.includes(p))
  // Spine cũ chưa qua schema có thể còn chuỗi đơn (trước FLF-237)
  const ff = (typeof formFactor === "string" ? [formFactor] : (formFactor ?? [])).map((f) => f.toLowerCase())
  const found = SCREEN_PLATFORMS.filter((p) => ff.some((f) => (p === "mobile" ? /mobile|android|ios/.test(f) : /web/.test(f))))
  return found.length > 0 ? found : ["web"]
}

export const resolveScreenTheme = (theme: ScreenTheme | undefined, formFactor: readonly string[] | string | null | undefined): ResolvedScreenTheme => {
  const t = theme ?? DEFAULT_SCREEN_THEME
  return { primaryColor: t.primaryColor ?? DEFAULT_PRIMARY_COLOR, domain: t.domain, platforms: resolvePlatforms(t, formFactor) }
}


/** Host phổ biến không phải sản phẩm (link tham khảo, chuẩn, mạng xã hội) — bỏ khi đoán domain từ tài liệu. */
const COMMON_HOSTS = [
  "google.com",
  "github.com",
  "gitlab.com",
  "facebook.com",
  "fb.com",
  "youtube.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "w3.org",
  "microsoft.com",
  "apple.com",
  "amazon.com",
  "wikipedia.org",
  "ieee.org",
  "iso.org",
  "owasp.org",
  "example.com",
  "example.org",
  "localhost",
  "atlassian.net",
  "figma.com",
  "stackoverflow.com",
  "mozilla.org",
  "openai.com",
  "anthropic.com",
  "vercel.app",
  "herokuapp.com"
]
const isCommon = (host: string): boolean => COMMON_HOSTS.some((c) => host === c || host.endsWith(`.${c}`))

const URL_IN_TEXT = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi

/**
 * Domain sản phẩm ghi rõ trong tài liệu (SRS import, brief): host của URL `http(s)://` xuất hiện nhiều nhất, bỏ host phổ
 * biến; hoà ⇒ host gặp trước. Bỏ `www.`. Không có ⇒ null. Không gọi model, không đoán từ tên dự án.
 */
export const domainFromText = (text: string): string | null => {
  const counts = new Map<string, number>()
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const host = normalizeDomain(m[1].replace(/^www\./i, ""))
    if (!host || isCommon(host)) continue
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  let best: string | null = null
  for (const [host, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = host
  return best
}

// ─── ảnh gốc dự án import: vẽ lại bằng mockup ─────────────────────

/** `system` = mockup chuẩn FlintFlow (chỉ gửi chữ); `original` = theo bố cục ảnh gốc (gửi kèm ảnh). */
export const SCREEN_MOCKUP_MODES = ["system", "original"] as const
export type ScreenMockupMode = (typeof SCREEN_MOCKUP_MODES)[number]

/**
 * Trạng thái mockup của một màn có ảnh gốc (`Project.screenMockups`, ngoài Spine). `enabled = false` = đang dùng ảnh gốc
 * nhưng giữ hình đã vẽ để bật lại không tốn credit. `image_indexes` = vị trí các ảnh màn hình trong khối nguyên văn của
 * mục (bị mockup thay).
 */
export interface ScreenMockupState {
  screen_id: string
  mode: ScreenMockupMode
  enabled: boolean
  image_indexes: number[]
}

export const screenMockupsOf = (project: { screenMockups?: unknown } | null | undefined): ScreenMockupState[] =>
  (Array.isArray(project?.screenMockups) ? (project.screenMockups as Record<string, unknown>[]) : []).flatMap((m) =>
    typeof m?.screen_id === "string" && (SCREEN_MOCKUP_MODES as readonly unknown[]).includes(m.mode)
      ? [
          {
            screen_id: m.screen_id,
            mode: m.mode as ScreenMockupMode,
            enabled: m.enabled === true,
            image_indexes: Array.isArray(m.image_indexes) ? m.image_indexes.filter((i): i is number => Number.isInteger(i) && (i as number) >= 0) : []
          }
        ]
      : []
  )
