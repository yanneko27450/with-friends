// 名字這類給人看的短字串：清掉控制字元、看不見的字元、會把文字方向反過來的字元。
// 中繼（relay/core.mjs）也 import 這份，兩邊擋的字一樣。只能用 Node 可直接剝除的 TS 語法。

/** C0／DEL／C1、軟連字號、阿拉伯字母標記、蒙古母音分隔、零寬與方向標記（200B–200F）、行／段分隔與方向嵌入（2028–202E）、
 * 字連接與方向隔離（2060–206F）、BOM、行間註解錨點 */
// 外掛的解析器讀不了正規表示式字面值裡的 \u 跳脫（validate：Syntax Error），所以用字串建
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g')

/** 清掉上面那些字、去頭尾空白，最多 max 個字（以字為單位，不會切壞表情符號的代理對） */
export function cleanName(s: unknown, max: number): string {
  return Array.from(String(s ?? '').replace(INVISIBLE, '').trim()).slice(0, max).join('').trim()
}
