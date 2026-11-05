// 0.5.8 外掛的 isValidRelayResponse：舊外掛收到中繼回應時只靠這個函式決定能不能採用（T6，docs/drafts/chat5-gate-design.md R4）。
// 逐行取自 release/0.5.8-wip（9254fba1c711f83b2ca83a118e2e12137796a96c）的 mod/hooks/register.tsx，只拿掉 TypeScript 型別標註；
// 新中繼的回應可以多欄位，但這個函式必須照樣通過。不要「順手更新」這份檔案：它的用途就是凍結舊外掛的期待。
const TOKEN_RE = /^[\w.-]{1,200}$/
const isToken = v => typeof v === 'string' && TOKEN_RE.test(v)

export function isValidRelayResponse058(path, data, auth) {
  if (path === '/groups' || path === '/join') {
    return isToken(data.groupId) && isToken(data.memberId) && isToken(data.memberKey) && isToken(data.invite)
      && Number.isSafeInteger(data.inviteGeneration) && data.inviteGeneration >= 0
      && data.isOwner === (path === '/groups')
  }
  if (path === '/status' || path === '/friends') {
    if (!auth || !Array.isArray(data.members)) return false
    const mine = data.members.filter(v => typeof v === 'object' && v !== null && v.id === auth.memberId)
    if (mine.length !== 1 || mine[0].isMe !== true || typeof mine[0].isOwner !== 'boolean') return false
    return data.members.every(v => {
      if (typeof v !== 'object' || v === null) return false
      const row = v
      return typeof row.id === 'string' && row.id.length > 0
        && typeof row.isMe === 'boolean'
        && (row.id === auth.memberId || row.isMe === false)
    })
  }
  if (path === '/invite/rotate') return isToken(data.invite) && Number.isSafeInteger(data.inviteGeneration) && data.inviteGeneration >= 1
  if (path === '/kick') return data.ok === true && isToken(data.invite) && Number.isSafeInteger(data.inviteGeneration) && data.inviteGeneration >= 1
  if (path === '/name') return data.ok === true
  if (path === '/leave') return data.ok === true
  // 新增 relayCall 端點時必須先在這裡定義成功契約；未知端點不可默認採用。
  return false
}
