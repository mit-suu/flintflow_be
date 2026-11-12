/**
 * Tokenizer cho tìm đoạn tài liệu upload bằng BM25 (FLF-393) — hàm thuần, dùng cho cả chunk lẫn câu hỏi.
 *
 * - Chuẩn hoá Unicode NFC, chữ thường.
 * - **Mã giữ nguyên khối**: `UC-12`, `UC12`, `uc_012`, `UC 12` ⇒ một token `uc-12` (bỏ số 0 đầu) — không tách thành
 *   `uc` + `12` vô nghĩa. Dạng có dấu cách chỉ nhận khi tiền tố viết HOA từ 2 chữ (`UC 12`), để "trang 12" không thành mã.
 * - Mỗi từ phát **cả bản có dấu lẫn bản bỏ dấu** (`đăng` + `dang`): câu hỏi gõ không dấu vẫn khớp, gõ đúng dấu thì khớp
 *   hai token nên xếp trên.
 * - Cặp âm tiết liền nhau phát thêm bigram bỏ dấu (`dang_nhap`): từ tiếng Việt đa số hai âm tiết, chỉ chấm từng âm tiết
 *   thì "đăng" của "đăng ký" kéo nhầm "đăng nhập". Dấu câu, từ hư và mã cắt chuỗi bigram.
 * - Bỏ từ hư tiếng Việt / tiếng Anh và token một ký tự.
 */

const STOPWORDS: ReadonlySet<string> = new Set(
  [
    // tiếng Việt — chỉ bản CÓ dấu: bỏ dấu thì từ hư trùng từ thật (`đang` ⇒ `dang` = "đăng", `mà` ⇒ `ma` = "mã"),
    // nên câu gõ không dấu giữ nguyên mọi từ, IDF của BM25 tự hạ điểm từ phổ biến
    "là của và các những cho khi thì có không được một này đó như với trong theo nào gì bao nhiêu sao vậy thế",
    "bị bởi để đã đang sẽ rồi nhưng hoặc hay nếu vì nên cũng rất về ra vào lên tại từ đến còn chỉ mà ở ạ nhé",
    "tôi mình bạn em anh chị",
    // tiếng Anh
    "a an and are as at be but by for from has have if in into is it its no not of on or such that the their then there",
    "these they this to was were will with what which who when where why how do does did can could should would you your",
    "we our me my"
  ]
    .join(" ")
    .split(" ")
)

const WORD_CHAR = "\\p{L}\\p{N}"
/** Nhóm 1–2: mã dính liền / gạch (`UC-12`, `uc12`); nhóm 3–4: mã có dấu cách, tiền tố HOA (`UC 12`); còn lại: một từ. */
const TOKEN_RE = new RegExp(
  `(?<![${WORD_CHAR}])([A-Za-z]{1,5})[-_]?(\\d{1,4})(?![${WORD_CHAR}])|(?<![${WORD_CHAR}])([A-Z]{2,5}) (\\d{1,4})(?![${WORD_CHAR}])|[${WORD_CHAR}]+`,
  "gu"
)

/** `Đăng nhập` ⇒ `dang nhap` — bỏ dấu thanh / dấu mũ, `đ` ⇒ `d`. */
export const foldDiacritics = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")

const codeToken = (prefix: string, digits: string): string => `${prefix.toLowerCase()}-${Number(digits)}`

export interface TokenizedText {
  /** Mọi token để chấm BM25 (từ có dấu, từ bỏ dấu, bigram, mã). */
  tokens: string[]
  /** Mã bắt được (`uc-12`), không lặp. */
  codes: string[]
  /** Số từ có nghĩa (không tính từ hư, bản bỏ dấu, bigram) — đo câu hỏi có quá ngắn không. */
  wordCount: number
}

export const tokenizeText = (text: string): TokenizedText => {
  const input = text.normalize("NFC")
  const tokens: string[] = []
  const codes = new Set<string>()
  let wordCount = 0
  /** Từ liền trước (đã bỏ dấu) còn nối bigram được, và vị trí kết thúc của nó. */
  let previous: { folded: string; end: number } | null = null

  for (const m of input.matchAll(TOKEN_RE)) {
    const prefix = m[1] ?? m[3]
    const digits = m[2] ?? m[4]
    if (prefix !== undefined && digits !== undefined) {
      const code = codeToken(prefix, digits)
      tokens.push(code)
      codes.add(code)
      wordCount++
      previous = null
      continue
    }
    const word = m[0].toLowerCase()
    if (word.length < 2 || STOPWORDS.has(word)) {
      previous = null
      continue
    }
    const folded = foldDiacritics(word)
    tokens.push(word)
    if (folded !== word) tokens.push(folded)
    wordCount++
    // Bigram chỉ nối hai từ cách nhau đúng khoảng trắng — dấu câu, xuống dòng kép cắt chuỗi
    const start = m.index
    if (previous && /^[ \t]+$/.test(input.slice(previous.end, start))) tokens.push(`${previous.folded}_${folded}`)
    previous = { folded, end: start + m[0].length }
  }
  return { tokens, codes: [...codes], wordCount }
}

/** Token để chấm BM25. */
export const tokenize = (text: string): string[] => tokenizeText(text).tokens
