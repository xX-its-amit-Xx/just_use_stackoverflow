// Reconstructs issue state at a past instant from history (undo of later changes),
// and computes sprint reports and project stats.

const DAY = 86400000;
export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

// hist: history entries of one issue, newest first.
export function snapshotAt(issue, hist, t) {
  const s = { ...issue };
  for (const h of hist) if (Date.parse(h.at) > t) s[h.field] = h.from;
  return s;
}

function stateAt(issue, hist, t, isDone) {
  if (Date.parse(issue.createdAt) > t) return null;
  const s = snapshotAt(issue, hist, t);
  return { sprintId: s.sprintId, status: s.status, points: s.storyPoints ?? 0, done: isDone(s.status) };
}

// ctx: { issues, histOf(issueId) -> newest-first, isDone(statusName), now: ms }
export function sprintReport(sprint, { issues, histOf, isDone, now }) {
  const T0 = sprint.startedAt ? Date.parse(sprint.startedAt) : now;
  const T1 = sprint.completedAt ? Date.parse(sprint.completedAt) : now;
  let committedPoints = 0;
  for (const i of issues) {
    const s = stateAt(i, histOf(i.id), T0, isDone);
    if (s && s.sprintId === sprint.id) committedPoints += s.points;
  }
  const completedIssues = [];
  let completedPoints = 0;
  for (const i of issues) {
    const s = stateAt(i, histOf(i.id), T1, isDone);
    if (s && s.sprintId === sprint.id && s.done) {
      completedIssues.push(i.key);
      completedPoints += s.points;
    }
  }
  const today = isoDay(now);
  const startDay = sprint.startDate || isoDay(sprint.startedAt ? Date.parse(sprint.startedAt) : now);
  const endDay = sprint.endDate && sprint.endDate < today ? sprint.endDate : today;
  const burndown = [];
  for (let t = Date.parse(`${startDay}T00:00:00Z`); isoDay(t) <= endDay; t += DAY) {
    const end = Date.parse(`${isoDay(t)}T23:59:59.999Z`);
    let remainingPoints = 0;
    for (const i of issues) {
      const s = stateAt(i, histOf(i.id), end, isDone);
      if (s && s.sprintId === sprint.id && !s.done) remainingPoints += s.points;
    }
    burndown.push({ date: isoDay(t), remainingPoints });
  }
  return {
    committedPoints,
    completedPoints,
    completedIssues,
    carriedOver: [...(sprint.carriedOver || [])],
    burndown,
  };
}

// issues: project issues; categoryOf(statusName); username(userId)
export function projectStats(issues, { histOf, categoryOf, username }) {
  const byStatus = {};
  const byType = {};
  const byAssignee = {};
  const cycles = [];
  for (const i of issues) {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    byType[i.type] = (byType[i.type] || 0) + 1;
    const a = i.assigneeId ? username(i.assigneeId) || 'unknown' : 'unassigned';
    byAssignee[a] = (byAssignee[a] || 0) + 1;
    if (i.resolvedAt) {
      // histOf is newest first, so the last 'started' entry is the first one.
      const started = histOf(i.id).filter((h) => h.field === 'status' && categoryOf(h.to) === 'started');
      if (started.length) {
        const t0 = Date.parse(started[started.length - 1].at);
        cycles.push((Date.parse(i.resolvedAt) - t0) / 3600000);
      }
    }
  }
  const avg = cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100 : null;
  return { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg };
}
