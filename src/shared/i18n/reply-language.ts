/**
 * Ngôn ngữ trả lời trong chat (FLF-260): AI trả lời bằng ngôn ngữ người dùng đang viết.
 *
 * Mỗi tin user gõ được đoán ngôn ngữ bằng luật cố định (không gọi model). Rõ ràng ⇒ trả lời bằng ngôn ngữ đó và ghi
 * thành ngôn ngữ của phiên chat; mơ hồ ("ok", số, mã phần tử, code, đường link) ⇒ giữ ngôn ngữ phiên; phiên chưa có ⇒
 * ngôn ngữ tài khoản (`User.locale`) ⇒ tiếng Việt. Ngôn ngữ chốt được đi vào prompt qua `replyLanguageDirective`.
 */
import { isUserLocale, type UserLocale } from "./locale.js"

export type ReplyLanguage = UserLocale

export const DEFAULT_REPLY_LANGUAGE: ReplyLanguage = "vi"

/**
 * Chữ chỉ tiếng Việt mới có. Cố ý bỏ à á è é ì í ò ó ù ú ý ã õ: các chữ này cũng gặp trong từ mượn và tên nước ngoài
 * (café, résumé, José) nằm giữa câu tiếng Anh.
 */
const VI_MARK = /[ăâđêôơưắằẳẵặấầẩẫậếềểễệốồổỗộớờởỡợứừửữựảẻỉỏủỷạẹịọụỵẽĩũỹỳ]/u

/**
 * Âm tiết tiếng Việt hay gặp khi gõ không dấu, KHÔNG trùng từ tiếng Anh thường dùng (bỏ an, can, do, he, me, may, no,
 * on, in, so, them, hang, ten, rat, roi, gui, tim, hen…).
 */
const VI_PLAIN: ReadonlySet<string> = new Set(
  (
    "toi minh ban chung cua cho khong ko hok dc duoc nhung nhu nay kia thi la va voi trong tren duoi ngoai khi neu nen " +
    "cung dang chua lam gi sao nao vay nhe nha giup cai nguoi muon biet hieu sua xoa doi thay tai lieu chuc nang hinh " +
    "quan ly thong khach viec nhieu lai nua hoi tra loi phai bao gio tao moi xem duyet ung dung mot cac nhom ngay thang " +
    "tien lich nhan nhap xuat kiem danh sach quyen vai tro trang muc tieu yeu cau phan mem khac thoi vi co phep thanh " +
    "toan bang de sau truoc gia mua don giao khoan mat khau cao thap nhanh cham tinh san pham"
  ).split(" ")
)

/**
 * Từ tiếng Anh thông dụng mà người Việt không chêm vào câu tiếng Việt. Cố ý KHÔNG có thuật ngữ nghề hay chêm (use case,
 * actor, screen, login, admin, user, add, update, fix, delete, create, list, test…) và từ trùng âm tiết Việt không dấu.
 */
const EN_WORDS: ReadonlySet<string> = new Set(
  (
    "is are was were been being of and or with without what which who whom whose where when why how should could " +
    "would will shall might must please this these those there here you your yours we our ours they their she his her " +
    "its i mine does did doing has have having had from about into onto for by if just also more most need " +
    "needs want wants like then any some all only because thanks thank hello hey explain describe tell help know think " +
    "let lets let's i'm i've i'd i'll don't doesn't didn't can't won't isn't aren't it's that's what's there's you're " +
    "we're they're yes yeah sure good great looks look sounds fine agree agreed ahead keep make write give get see ask " +
    "other another each every both while after before until again something anything nothing everything someone " +
    "people very really much many too yet"
  ).split(" ")
)

/**
 * Từ tiếng Anh trùng âm tiết Việt gõ không dấu (thể/thẻ → the, tô → to, ít → it, thật → that, mỹ → my, nốt → not,
 * át → at): chỉ tính là tiếng Anh khi câu đã có từ tiếng Anh khác — "co the thanh toan bang the" là tiếng Việt.
 */
const EN_WEAK: ReadonlySet<string> = new Set("the to it that my not at".split(" "))

/**
 * Động từ mệnh lệnh tiếng Anh — người Việt hay chêm vào câu ("add thêm actor") nên chỉ là tín hiệu khi ĐỨNG ĐẦU câu;
 * câu có chút tiếng Việt thì vẫn không bao giờ là tiếng Anh. "Rename the actor A01 to Student" là câu tiếng Anh.
 */
const EN_LEADING_VERBS: ReadonlySet<string> = new Set(
  "rename add update remove delete change create edit show list set make move split merge replace insert modify fix".split(" ")
)

/** Phần không mang tín hiệu ngôn ngữ: code, đường link, email, mã phần tử (UC-01, A03, S-5.2@S03). */
const NOISE = [
  /```[\s\S]*?(?:```|$)/g,
  /`[^`\n]*`/g,
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /\S+@\S+\.\S+/g,
  /\b[A-Za-z]{1,4}-?\d+(?:[.@-]\w+)*\b/g
]

/** Cả tin chỉ là một nhãn trong ngoặc vuông do giao diện tự gửi ("[Đính kèm tài liệu]") ⇒ không phải lời user. */
const BRACKET_MARKER = /^\s*\[[^\]]*\]\s*$/u

const WORD = /\p{L}+(?:['’]\p{L}+)*/gu

const stripMarks = (word: string): string => word.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d")

/** Từ đứng đầu câu (sau dấu kết câu / xuống dòng / đầu tin) thì viết hoa là chuyện thường, không phải tên riêng. */
const isSentenceStart = (text: string, index: number): boolean => {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i]
    if (ch === "\n") return true
    if (/[\s"“”'‘’([\-–—•*>#]/u.test(ch)) continue
    return /[.!?…:;]/u.test(ch)
  }
  return true
}

export interface DetectOptions {
  /**
   * Chỉ dùng khi phiên CHƯA có ngôn ngữ: một câu tiếng Anh ngắn ("A booking system for a dental clinic" — mới một từ
   * tiếng Anh thông dụng) cũng đủ, thay vì rơi xuống ngôn ngữ tài khoản. Câu có chút tiếng Việt nào thì vẫn không tính.
   */
  lenient?: boolean
}

/**
 * Đoán ngôn ngữ một tin user gõ. Trả `null` khi không đủ tín hiệu — nơi gọi giữ ngôn ngữ trước đó.
 *
 * Đếm chữ có dấu chỉ tiếng Việt mới có (bỏ qua tên riêng viết hoa giữa câu, vd "Nguyễn Văn An" trong câu tiếng Anh), âm
 * tiết Việt không dấu, và từ tiếng Anh thông dụng. Ngưỡng cố ý chặt: một từ lẻ ("ok", "yes", "thanks") là mơ hồ, và
 * câu có chữ có dấu tiếng Việt không bao giờ là tiếng Anh — "Cần support offline mode for the mobile app" là người Việt
 * chêm thuật ngữ, không phải đổi ngôn ngữ.
 */
export const detectMessageLanguage = (input: string | null | undefined, options: DetectOptions = {}): ReplyLanguage | null => {
  if (typeof input !== "string") return null
  const raw = input.normalize("NFC")
  if (!raw.trim() || BRACKET_MARKER.test(raw)) return null
  const text = NOISE.reduce((acc, pattern) => acc.replace(pattern, " "), raw)

  let words = 0
  let viMarked = 0
  let viPlain = 0
  let enStrong = 0
  let enWeak = 0
  for (const match of text.matchAll(WORD)) {
    words += 1
    const word = match[0]
    const lower = word.toLowerCase()
    if (VI_MARK.test(lower)) {
      const capitalised = word[0] !== word[0].toLowerCase()
      if (!capitalised || isSentenceStart(text, match.index ?? 0)) viMarked += 1
      continue
    }
    const plain = stripMarks(lower)
    const english = lower.replace(/’/g, "'")
    if (VI_PLAIN.has(plain)) viPlain += 1
    else if (EN_WORDS.has(english)) enStrong += 1
    else if (EN_LEADING_VERBS.has(english) && isSentenceStart(text, match.index ?? 0)) enStrong += 1
    else if (EN_WEAK.has(english)) enWeak += 1
  }

  const vi = viMarked + viPlain
  const en = enStrong > 0 ? enStrong + enWeak : 0
  if (viMarked >= 1 && vi > en) return "vi"
  if (viPlain >= 2 && vi >= 2 * en) return "vi"
  if (viMarked === 0 && en >= 2 && en >= 2 * vi) return "en"
  if (options.lenient && vi === 0 && enStrong >= 1 && words >= 4) return "en"
  return null
}

/** Ứng viên hợp lệ đầu tiên thắng (tin vừa gõ → ngôn ngữ phiên → ngôn ngữ tài khoản); không có ⇒ tiếng Việt. */
export const resolveReplyLanguage = (...candidates: unknown[]): ReplyLanguage =>
  candidates.find(isUserLocale) ?? DEFAULT_REPLY_LANGUAGE

/** Câu cố định theo ngôn ngữ trả lời: `byLanguage(lang, { vi: "…", en: "…" })`. */
export const byLanguage = <T>(language: ReplyLanguage, texts: Readonly<Record<ReplyLanguage, T>>): T => texts[language]

const DIRECTIVE: Readonly<Record<ReplyLanguage, string>> = {
  en: [
    "## Reply language",
    "",
    "Reply language: **English**. Write everything the user reads in this turn in English — the reply, questions,",
    "option labels and descriptions, card headers, gate notes, clarification questions, reasons, and the user-facing",
    "assumption texts (`statement_vi`, `rationale_vi`) — even when earlier turns, the document context or the examples",
    "above are in Vietnamese. Mark a recommended option with ` (Recommended)`. Leave unchanged: ids, keys, paths,",
    "`topic_key` values, every value the rules above keep in English or in the document's language, and the names of",
    "buttons, panels and tabs the rules above quote from the interface — the interface is in Vietnamese, so quote them",
    "exactly as written (an English gloss in parentheses is fine)."
  ].join("\n"),
  vi: [
    "## Reply language",
    "",
    "Reply language: **Vietnamese (tiếng Việt)**. Write everything the user reads in this turn in Vietnamese — the",
    "reply, questions, option labels and descriptions, card headers, gate notes, clarification questions, reasons, and",
    "the user-facing assumption texts (`statement_vi`, `rationale_vi`) — even when the latest message, earlier turns or",
    "the document context are in English. Mark a recommended option with ` (Khuyến nghị)`. Leave unchanged: ids, keys,",
    "paths, `topic_key` values, and every value the rules above keep in English or in the document's language."
  ].join("\n")
}

/**
 * Khối nối vào CUỐI prompt (`buildPrompt`) để model trả lời đúng ngôn ngữ. Chỉ dựng từ enum — input của client không
 * chui được chữ nào vào prompt. Tránh các từ mock provider dò ("summarize", "extract", "Tóm tắt", "Trích xuất").
 */
export const replyLanguageDirective = (language: ReplyLanguage): string => DIRECTIVE[language]
