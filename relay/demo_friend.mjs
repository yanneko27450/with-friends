// 示範用假好友（不是真人）：建群組、印邀請碼，扮兩位好友持續送動態，並印出中繼上看到的其他人。
// 用法：node relay/demo_friend.mjs [--relay http://127.0.0.1:8789] [--invite-file 路徑]
import { writeFileSync } from 'node:fs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : dflt
}
const RELAY = arg('--relay', 'http://127.0.0.1:8789')
const INVITE_FILE = arg('--invite-file', '')

async function call(method, path, body, m) {
  const headers = { 'content-type': 'application/json' }
  if (m) headers.authorization = `Bearer ${m.groupId}.${m.memberId}.${m.memberKey}`
  const res = await fetch(RELAY + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(`${path} ${res.status} ${data.error}`)
  return data
}

const bob = await call('POST', '/groups', { name: 'Bob (demo)', groupName: 'Demo group' })
const cat = await call('POST', '/join', { invite: bob.invite, name: 'Cat (demo)' })
console.log(`INVITE ${bob.invite}`)
if (INVITE_FILE) writeFileSync(INVITE_FILE, bob.invite)

let seen = ''
async function loop() {
  await call('POST', '/status', { state: 'working', action: 'fixing-bugs', subject: 'website' }, bob)
  await call('POST', '/status', { state: 'idle', action: 'learning', subject: 'ai-agent' }, cat)
  const { members } = await call('GET', '/friends', undefined, bob)
  const others = members.filter(m => !m.name.endsWith('(demo)'))
    .map(m => `${m.name}: presence=${m.presence} action=${m.action || '-'} subject=${m.subject || '-'} keys=${Object.keys(m).join(',')}`)
    .join(' | ')
  if (others !== seen) {
    seen = others
    console.log(`${new Date().toISOString()} SEEN ${others || '(nobody else)'}`)
  }
}
await loop()
setInterval(() => { loop().catch(err => console.log('ERR', err.message)) }, 15_000)
