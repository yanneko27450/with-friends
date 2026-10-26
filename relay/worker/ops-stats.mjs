// ops-2b／cap-1：每群只留短期聚合；全域只收匿名小計，不收 memberId、名字、IP 或內容。
export const UTC_DAY_MS = 86_400_000
export const OPS_FLUSH_MS = 3_600_000
export const REPORT_MAX_AGE = 7 * UTC_DAY_MS
export const RESERVATION_MS = 5 * 60_000
export const HISTOGRAM_LABELS = ['1', '2-5', '6-20', '21-100', '101-500', '501+']

export const utcDay = now => Math.floor(now / UTC_DAY_MS)
export const newGroupOps = now => ({ day: utcDay(now), dirtySince: now, lastReportedAt: 0, lastToken: '' })

export function rollGroupOps(ops, members, now) {
  const day = utcDay(now)
  const delta = Math.max(0, Math.min(7, day - ops.day))
  if (!delta) return ops
  for (const member of Object.values(members)) {
    member.opsDays = ((member.opsDays ?? 0) << delta) & 0x7f
    member.opsTodayRequests = 0
  }
  ops.day = day
  ops.dirtySince ||= now
  return ops
}

export function recordMembershipRequest(ops, members, member, now) {
  rollGroupOps(ops, members, now)
  member.opsDays = (member.opsDays ?? 0) | 1
  member.opsTodayRequests = Math.min(501, (member.opsTodayRequests ?? 0) + 1)
  ops.dirtySince ||= now
}

const bucketOf = n => n <= 1 ? 0 : n <= 5 ? 1 : n <= 20 ? 2 : n <= 100 ? 3 : n <= 500 ? 4 : 5
export function groupOpsSummary(ops, members) {
  const requestHistogram = [0, 0, 0, 0, 0, 0]
  let rolling7ActiveMemberships = 0
  for (const member of Object.values(members)) {
    if (member.opsDays) rolling7ActiveMemberships += 1
    if (member.opsTodayRequests) requestHistogram[bucketOf(member.opsTodayRequests)] += 1
  }
  return { rolling7ActiveMemberships, requestHistogram, day: ops.day }
}

export function aggregateReports(reports, reservations, now) {
  let rolling7ActiveMemberships = 0
  let activeGroups = 0
  const requestHistogram = [0, 0, 0, 0, 0, 0]
  for (const [key, report] of Object.entries(reports)) {
    if (!report || now - report.reportedAt > REPORT_MAX_AGE) { delete reports[key]; continue }
    rolling7ActiveMemberships += report.rolling7ActiveMemberships
    if (report.rolling7ActiveMemberships > 0) activeGroups += 1
    if (report.day === utcDay(now)) for (let i = 0; i < 6; i++) requestHistogram[i] += report.requestHistogram[i] ?? 0
  }
  for (const [key, expiresAt] of Object.entries(reservations)) if (expiresAt <= now) delete reservations[key]
  return { generatedAt: now, rolling7ActiveMemberships, activeGroups, requestHistogram, reservationCount: Object.keys(reservations).length, lastCompleteUtcDay: utcDay(now) - 1 }
}
