export const WS_ROLES = ['admin', 'member', 'guest'];
export const PROJECT_ROLES = ['lead', 'developer', 'viewer'];
export const ROLE_RANK = { viewer: 1, developer: 2, lead: 3 };
export const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
export const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
export const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
export const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
export const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
export const DEFAULT_STATUSES = [
  { name: 'Backlog', category: 'backlog' },
  { name: 'Todo', category: 'unstarted' },
  { name: 'In Progress', category: 'started' },
  { name: 'In Review', category: 'started' },
  { name: 'Done', category: 'completed' },
];
// Issue fields whose changes are recorded in history and replayed for burndown.
export const TRACKED = ['title', 'description', 'type', 'status', 'priority', 'assigneeId', 'labels',
  'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];

export function defaultTransitions(statuses) {
  const out = [];
  for (const a of statuses) for (const b of statuses) if (a.name !== b.name) out.push([a.name, b.name]);
  return out;
}
