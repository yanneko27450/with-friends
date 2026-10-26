export const CAPACITY_PUBLIC = 1_000
export const CAPACITY_WARNING = 900
export const CAPACITY_BLOCK = 950
export const CAPACITY_WINDOW_MS = 7 * 86_400_000
export const CAPACITY_ERROR = '公開中繼滿了，請改用自架中繼：https://github.com/yanneko27450/with-friends/blob/main/relay/DEPLOY.md'

export function activeMembershipCount(groups, now = Date.now()) {
  let count = 0
  for (const group of Object.values(groups)) {
    for (const member of Object.values(group?.members ?? {})) {
      if (Number.isFinite(member.seenAt) && now - member.seenAt <= CAPACITY_WINDOW_MS) count += 1
    }
  }
  return count
}
