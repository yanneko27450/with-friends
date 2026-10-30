// 名字這類給人看的短字串：清掉控制字元、看不見的字元、會把文字方向反過來的字元。
// 中繼（relay/core.mjs）也 import 這份，兩邊擋的字一樣。只能用 Node 可直接剝除的 TS 語法。

/** C0／DEL／C1、軟連字號、阿拉伯字母標記、蒙古母音分隔、零寬與方向標記（200B–200F）、行／段分隔與方向嵌入（2028–202E）、
 * 字連接與方向隔離（2060–206F）、BOM、行間註解錨點，
 * 以及「看起來是空白」的填充字元（盲審建議 #5）：組合用字母 034F、韓文填充 115F／1160／3164／FFA0、高棉隱含母音 17B4／17B5、
 * 蒙古變體選擇符 180B–180D／180F、點字空白 2800、樂譜空符頭 1D159、物件替代字元 FFFC、Tag 字元 E0000–E007F
 * （會被拿來夾帶看不見的字；代價：蘇格蘭等 Tag 序列旗幟只剩黑旗）。
 * 另外，清完之後整個名字若只剩「看不見的東西」（組合符號、變體選擇符 FE00–FE0F／E0100–E01EF、其他格式字元），也當作空名字 */
// 外掛的解析器讀不了正規表示式字面值裡的 \u 跳脫（validate：Syntax Error），所以用字串建；要比對 E0000 以上用 u 旗標
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u{1d159}\\u2800\\u3164\\ufeff\\uffa0\\ufff9-\\ufffc\\u{e0000}-\\u{e007f}]', 'gu')

// 至少要有一個「看得見」的字：不是組合符號 M、格式字元 Cf、空白 Z、預設忽略字元（含變體選擇符）
const HAS_VISIBLE = new RegExp('[^\\p{M}\\p{Cf}\\p{Z}\\p{Default_Ignorable_Code_Point}\\s]', 'u')

/** 清掉上面那些字、去頭尾空白，最多 max 個字（以字為單位，不會切壞表情符號的代理對） */
export function cleanName(s: unknown, max: number): string {
  const cleaned = Array.from(String(s ?? '').replace(INVISIBLE, '').trim()).slice(0, max).join('').trim()
  return HAS_VISIBLE.test(cleaned) ? cleaned : ''
}

/** 改名用的嚴格檢查：不默默截短或剝掉危險字元；一般頭尾空白仍跟 join 一樣會被 trim。 */
export function isValidNameInput(s: unknown, max: number): s is string {
  if (typeof s !== 'string' || s.replace(INVISIBLE, '') !== s) return false
  const trimmed = s.trim()
  return trimmed.length > 0 && Array.from(trimmed).length <= max && cleanName(s, max) === trimmed
}
