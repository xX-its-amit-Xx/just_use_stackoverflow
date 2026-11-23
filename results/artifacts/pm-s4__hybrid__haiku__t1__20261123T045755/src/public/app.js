/* pm-s4 single-page app. Uses only the public REST API. DOM is built with textContent, never innerHTML. */
(() => {
  'use strict';

  const TYPES = ['bug', 'feature', 'task', 'epic'];
  const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
  const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
  const app = document.getElementById('app');
  const S = { token: localStorage.getItem('pm_token'), me: null, workspaces: [] };

  // ---------- helpers ----------
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'draggable') e[k] = !!v;
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function select(options, value, onchange, extra = {}) {
    const s = el('select', { onchange, ...extra }, options.map(([v, label]) => el('option', { value: v }, label)));
    s.value = value ?? '';
    return s;
  }

  function svgEl(tag, attrs, ...kids) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    for (const c of kids.flat()) if (c) e.append(c);
    return e;
  }

  async function api(method, path, body) {
    const headers = {};
    if (S.token) headers.authorization = 'Bearer ' + S.token;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(path, { method, headers, body: payload });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error((data && data.message) || `${r.status} ${r.statusText}`);
      err.status = r.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  async function action(fn) {
    try { await fn(); } catch (e) { alert(e.message); }
    render();
  }

  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [view, qs] = h.split('?');
    return { view: view || 'board', ...Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  function go(view, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    const s = q.toString();
    location.hash = '#/' + view + (s ? '?' + s : '');
  }

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const userName = (id) => {
    const ws = S.ws;
    const m = ws && ws.members.find((x) => x.userId === id);
    return m ? m.username : id ? id.slice(0, 8) : 'unassigned';
  };

  // ---------- auth ----------
  function renderAuth(mode = 'login') {
    const err = el('div', { class: 'error', style: 'display:none' });
    const show = (msg) => { err.textContent = msg; err.style.display = msg ? '' : 'none'; };
    const username = el('input', { placeholder: 'username', autocomplete: 'username' });
    const displayName = el('input', { placeholder: 'display name (optional)' });
    const password = el('input', { type: 'password', placeholder: 'password (min 8 chars)', autocomplete: 'current-password' });
    const submit = async () => {
      show('');
      try {
        if (mode === 'register') {
          await api('POST', '/api/auth/register', { username: username.value, password: password.value, displayName: displayName.value || undefined });
        }
        const { token } = await api('POST', '/api/auth/login', { username: username.value, password: password.value });
        S.token = token;
        localStorage.setItem('pm_token', token);
        S.me = null;
        location.hash = '#/board';
        render();
      } catch (e) { show(e.message); }
    };
    app.replaceChildren(el('div', { class: 'auth panel' },
      el('h2', {}, mode === 'login' ? 'Sign in' : 'Create account'),
      err, username, mode === 'register' ? displayName : null, password,
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: submit }, mode === 'login' ? 'Sign in' : 'Register'),
        el('button', { onclick: () => renderAuth(mode === 'login' ? 'register' : 'login') },
          mode === 'login' ? 'Need an account?' : 'Have an account?')),
    ));
    password.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  // ---------- shell ----------
  async function render() {
    if (!S.token) return renderAuth();
    let content;
    let header;
    try {
      if (!S.me) S.me = (await api('GET', '/api/auth/me')).user;
      S.workspaces = await api('GET', '/api/workspaces');
    } catch (e) {
      if (e.status === 401) { S.token = null; localStorage.removeItem('pm_token'); return renderAuth(); }
      app.replaceChildren(el('div', { class: 'error' }, e.message));
      return;
    }
    const r = route();
    S.ws = S.workspaces.find((w) => w.id === r.ws) || S.workspaces[0] || null;
    if (!S.ws) {
      app.replaceChildren(header = topbar(null, [], null), el('main', {}, workspaceForm()));
      return;
    }
    S.projects = await api('GET', `/api/workspaces/${S.ws.id}/projects`);
    S.project = S.projects.find((p) => p.id === r.p) || S.projects[0] || null;
    const unread = await api('GET', '/api/notifications?unread=true').catch(() => []);
    header = topbar(r, S.projects, unread.length);
    try {
      const view = VIEWS[r.view] || VIEWS.board;
      content = await view(r);
    } catch (e) {
      content = el('div', { class: 'error' }, e.message);
    }
    app.replaceChildren(header, el('main', {}, content));
  }

  function topbar(r, projects, unreadCount) {
    const wsSel = select(S.workspaces.map((w) => [w.id, `${w.name} (${w.key})`]), S.ws && S.ws.id,
      (e) => go('board', { ws: e.target.value }));
    const projSel = select(projects.map((p) => [p.id, `${p.key} · ${p.name}`]), S.project && S.project.id,
      (e) => go('board', { ws: S.ws.id, p: e.target.value }));
    const nav = (view, label) => el('a', {
      href: '#/' + view + (S.project ? `?ws=${S.ws.id}&p=${S.project.id}` : ''),
      class: r && r.view === view ? 'active' : '',
    }, label);
    return el('header', { class: 'top' },
      el('span', { class: 'brand' }, 'pm-s4'),
      S.ws ? wsSel : null,
      S.ws && projects.length ? projSel : null,
      S.project ? [nav('board', 'Board'), nav('backlog', 'Backlog'), nav('search', 'Search'),
        nav('notifications', `Notifications${unreadCount ? ` (${unreadCount})` : ''}`), nav('settings', 'Settings')] : null,
      el('span', { class: 'spacer' }),
      el('span', {}, S.me ? S.me.displayName || S.me.username : ''),
      el('button', { onclick: logout }, 'Log out'));
  }

  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
    S.token = null;
    S.me = null;
    localStorage.removeItem('pm_token');
    renderAuth();
  }

  function workspaceForm() {
    const name = el('input', { placeholder: 'Workspace name' });
    const key = el('input', { placeholder: 'KEY (2-10 caps)' });
    return el('div', { class: 'panel' }, el('h2', {}, 'Create a workspace'), name, key,
      el('div', { class: 'row' }, el('button', {
        class: 'primary',
        onclick: () => action(async () => {
          const ws = await api('POST', '/api/workspaces', { name: name.value, key: key.value });
          go('board', { ws: ws.id });
        }),
      }, 'Create')));
  }

  function projectForm() {
    const name = el('input', { placeholder: 'Project name' });
    const key = el('input', { placeholder: 'KEY (2-10 caps)' });
    return el('div', { class: 'panel' }, el('h2', {}, 'Create a project'), name, key,
      el('div', { class: 'row' }, el('button', {
        class: 'primary',
        onclick: () => action(async () => {
          const p = await api('POST', `/api/workspaces/${S.ws.id}/projects`, { name: name.value, key: key.value });
          go('board', { ws: S.ws.id, p: p.id });
        }),
      }, 'Create')));
  }

  const needProject = (fn) => (r) => (S.project ? fn(r) : el('div', {}, projectForm()));

  // ---------- board ----------
  const VIEWS = {};

  VIEWS.board = needProject(async () => {
    const p = S.project;
    const issues = await api('GET', `/api/projects/${p.id}/issues`);
    const canEdit = ['developer', 'lead'].includes(p.role);
    const title = el('input', { placeholder: 'New issue title' });
    const type = select(TYPES.map((t) => [t, t]), 'task');
    const create = el('div', { class: 'row' }, title, type, el('button', {
      class: 'primary',
      onclick: () => action(async () => {
        if (!title.value.trim()) throw new Error('Title is required');
        await api('POST', `/api/projects/${p.id}/issues`, { title: title.value, type: type.value });
      }),
    }, 'Create'));
    const cols = p.workflow.statuses.map((s) => {
      const list = issues.filter((i) => i.status === s.name);
      return el('div', {
        class: 'col',
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => {
          e.preventDefault();
          const key = e.dataTransfer.getData('text/plain');
          if (key && canEdit) action(() => api('PATCH', `/api/issues/${key}`, { status: s.name }));
        },
      }, el('h3', {}, s.name, ' ', el('span', { class: 'count' }, String(list.length))),
      list.map((i) => el('div', {
        class: 'card',
        draggable: canEdit,
        ondragstart: (e) => e.dataTransfer.setData('text/plain', i.key),
        onclick: () => go('issue', { ws: S.ws.id, p: p.id, key: i.key }),
      }, el('div', {}, el('strong', {}, i.key), ' ', i.title),
      el('div', { class: 'muted' }, i.type, ' · ', i.priority, i.storyPoints != null ? ` · ${i.storyPoints} pts` : ''))));
    });
    return el('div', {}, el('h2', {}, `${p.name} — board`), canEdit ? create : null,
      el('div', { class: 'board' }, cols));
  });

  // ---------- backlog & sprints ----------
  VIEWS.backlog = needProject(async () => {
    const p = S.project;
    const [issues, sprints] = await Promise.all([
      api('GET', `/api/projects/${p.id}/issues`),
      api('GET', `/api/projects/${p.id}/sprints`),
    ]);
    const canEdit = ['developer', 'lead'].includes(p.role);
    const openSprints = sprints.filter((s) => s.state !== 'completed');
    const moveOptions = [['', 'Backlog'], ...openSprints.map((s) => [s.id, s.name])];
    const row = (i) => el('tr', { class: 'clickable', onclick: (e) => { if (e.target.tagName !== 'SELECT') go('issue', { ws: S.ws.id, p: p.id, key: i.key }); } },
      el('td', {}, i.key), el('td', {}, i.title), el('td', {}, i.status), el('td', {}, i.storyPoints ?? ''),
      el('td', {}, canEdit ? select(moveOptions, i.sprintId ?? '', (e) => action(() => api('PATCH', `/api/issues/${i.key}`, { sprintId: e.target.value || null }))) : ''));
    const backlogIssues = issues.filter((i) => !i.sprintId && !isDoneStatus(i.status, p));
    const sprintBlocks = sprints.map((s) => {
      const inS = issues.filter((i) => i.sprintId === s.id);
      const carry = [['backlog', 'backlog'], ...sprints.filter((x) => x.id !== s.id && x.state !== 'completed').map((x) => [x.id, x.name])];
      const carrySel = select(carry, 'backlog', null, { id: `carry-${s.id}` });
      return el('div', { class: 'panel' },
        el('div', { class: 'row' }, el('strong', {}, s.name), el('span', { class: 'badge' }, s.state),
          el('span', { class: 'muted' }, `${s.startDate || '—'} → ${s.endDate || '—'}`),
          s.state === 'planned' && canEdit ? el('button', { onclick: () => action(() => api('POST', `/api/sprints/${s.id}/start`)) }, 'Start') : null,
          s.state === 'active' && canEdit ? [carrySel, el('button', {
            onclick: () => action(() => api('POST', `/api/sprints/${s.id}/complete`, { carryOverTo: carrySel.value })),
          }, 'Complete')] : null,
          el('button', { onclick: () => go('sprint', { ws: S.ws.id, p: p.id, id: s.id }) }, 'Report')),
        inS.length ? el('table', {}, el('tbody', {}, inS.map(row))) : el('div', { class: 'muted' }, 'No issues in this sprint.'));
    });
    const newSprintName = el('input', { placeholder: 'Sprint name' });
    const newStart = el('input', { type: 'date' });
    const newEnd = el('input', { type: 'date' });
    const sprintForm = canEdit ? el('div', { class: 'panel' }, el('h3', {}, 'New sprint'),
      el('div', { class: 'row' }, newSprintName, newStart, newEnd, el('button', {
        class: 'primary',
        onclick: () => action(() => api('POST', `/api/projects/${p.id}/sprints`, {
          name: newSprintName.value, startDate: newStart.value || undefined, endDate: newEnd.value || undefined,
        })),
      }, 'Create sprint'))) : null;
    return el('div', {},
      el('h2', {}, `${p.name} — backlog`),
      sprintForm,
      sprintBlocks,
      el('div', { class: 'panel' }, el('h3', {}, 'Backlog'),
        backlogIssues.length ? el('table', {}, el('tbody', {}, backlogIssues.map(row))) : el('div', { class: 'muted' }, 'Backlog is empty.')));
  });

  function isDoneStatus(name, project) {
    const s = project.workflow.statuses.find((x) => x.name === name);
    return !!s && s.category === 'completed';
  }

  // ---------- sprint report ----------
  VIEWS.sprint = async (r) => {
    const [sprint, report] = await Promise.all([api('GET', `/api/sprints/${r.id}`), api('GET', `/api/sprints/${r.id}/report`)]);
    const back = el('button', { onclick: () => go('backlog', { ws: S.ws.id, p: S.project.id }) }, '← Backlog');
    const stats = el('table', {}, el('tbody', {},
      el('tr', {}, el('th', {}, 'Committed points'), el('td', {}, report.committedPoints)),
      el('tr', {}, el('th', {}, 'Completed points'), el('td', {}, report.completedPoints)),
      el('tr', {}, el('th', {}, 'Completed issues'), el('td', {}, report.completedIssues)),
      el('tr', {}, el('th', {}, 'Carried over'), el('td', {}, report.carriedOver))));
    return el('div', {}, back, el('h2', {}, `${sprint.name} — report (${sprint.state})`),
      el('div', { class: 'grid2' },
        el('div', { class: 'panel' }, el('h3', {}, 'Burndown (remaining points)'), burndownSvg(report.burndown)),
        el('div', { class: 'panel' }, el('h3', {}, 'Summary'), stats)));
  };

  function burndownSvg(points) {
    const W = 640; const H = 300; const P = 40;
    if (!points.length) return el('div', { class: 'muted' }, 'No burndown data yet.');
    const max = Math.max(1, ...points.map((p) => p.remainingPoints));
    const x = (i) => P + (points.length <= 1 ? 0 : (i * (W - 2 * P)) / (points.length - 1));
    const y = (v) => H - P - (v * (H - 2 * P)) / max;
    const line = points.map((p, i) => `${x(i)},${y(p.remainingPoints)}`).join(' ');
    return svgEl('svg', { class: 'burndown', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Burndown chart' },
      svgEl('line', { x1: P, y1: H - P, x2: W - P, y2: H - P, stroke: '#97a0af' }),
      svgEl('line', { x1: P, y1: P, x2: P, y2: H - P, stroke: '#97a0af' }),
      svgEl('text', { x: 4, y: P + 4, 'font-size': 11 }, String(max)),
      svgEl('text', { x: 4, y: H - P, 'font-size': 11 }, '0'),
      svgEl('polyline', { points: line, fill: 'none', stroke: '#0052cc', 'stroke-width': 2 }),
      points.map((p, i) => svgEl('circle', { cx: x(i), cy: y(p.remainingPoints), r: 3, fill: '#0052cc' },
        svgEl('title', {}, `${p.date}: ${p.remainingPoints} pts`))),
      points.map((p, i) => (i % Math.ceil(points.length / 6) === 0 || i === points.length - 1
        ? svgEl('text', { x: x(i) - 20, y: H - P + 16, 'font-size': 10 }, p.date.slice(5)) : null)));
  }

  // ---------- issue detail ----------
  VIEWS.issue = async (r) => {
    const p = S.project;
    const [i, history, comments] = await Promise.all([
      api('GET', `/api/issues/${r.key}`),
      api('GET', `/api/issues/${r.key}/history`),
      api('GET', `/api/issues/${r.key}/comments`),
    ]);
    const canEdit = ['developer', 'lead'].includes(p.role);
    const watching = i.watchers.includes(S.me.id);
    const field = (label, node) => el('label', {}, label, node);
    const title = el('input', { value: i.title, disabled: !canEdit });
    const desc = el('textarea', { disabled: !canEdit }, i.description || '');
    desc.value = i.description || '';
    const status = select(p.workflow.statuses.map((s) => [s.name, s.name]), i.status, null, { disabled: !canEdit });
    const prio = select(PRIORITIES.map((x) => [x, x]), i.priority, null, { disabled: !canEdit });
    const typeOpts = TYPES.concat(i.type === 'subtask' ? ['subtask'] : []).map((t) => [t, t]);
    const typeSel = select(typeOpts, i.type, null, { disabled: !canEdit });
    const wsMembers = S.ws.members.map((m) => [m.userId, m.username]);
    const assignee = select([['', 'Unassigned'], ...wsMembers], i.assigneeId ?? '', null, { disabled: !canEdit });
    const points = el('input', { type: 'number', min: 0, value: i.storyPoints ?? '', disabled: !canEdit });
    const labels = el('input', { value: i.labels.join(', '), disabled: !canEdit });
    const due = el('input', { type: 'date', value: i.dueDate || '', disabled: !canEdit });
    const epic = el('input', { placeholder: 'epic key', value: '', disabled: !canEdit });
    const saveBtn = canEdit ? el('button', {
      class: 'primary',
      onclick: () => action(() => api('PATCH', `/api/issues/${i.key}`, {
        title: title.value,
        description: desc.value,
        status: status.value,
        priority: prio.value,
        type: typeSel.value,
        assigneeId: assignee.value || null,
        storyPoints: points.value === '' ? null : Number(points.value),
        labels: labels.value.split(',').map((s) => s.trim()).filter(Boolean),
        dueDate: due.value || null,
      })),
    }, 'Save') : null;
    const subtaskTitle = el('input', { placeholder: 'Subtask title' });
    const addSub = canEdit && i.type !== 'subtask' ? el('div', { class: 'row' }, subtaskTitle, el('button', {
      onclick: () => action(() => api('POST', `/api/projects/${p.id}/issues`, { type: 'subtask', title: subtaskTitle.value, parentId: i.id })),
    }, 'Add subtask')) : null;
    const linkType = select([['blocks', 'blocks'], ['relates', 'relates'], ['duplicates', 'duplicates']], 'relates');
    const linkTarget = el('input', { placeholder: 'target key e.g. ABC-12' });
    const linkAdd = canEdit ? el('div', { class: 'row' }, linkType, linkTarget, el('button', {
      onclick: () => action(() => api('POST', `/api/issues/${i.key}/links`, { type: linkType.value, target: linkTarget.value.trim() })),
    }, 'Add link')) : null;
    const comment = el('textarea', { placeholder: 'Write a comment… use @username to mention' });
    const progress = i.progress ? el('p', {}, `Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts`) : null;

    return el('div', { class: 'issue-detail' },
      el('div', { class: 'row' }, el('button', { onclick: () => go('board', { ws: S.ws.id, p: p.id }) }, '← Board'),
        el('strong', {}, i.key), el('span', { class: 'badge' }, i.type),
        el('button', {
          onclick: () => action(() => api(watching ? 'DELETE' : 'POST', `/api/issues/${i.key}/watch`)),
        }, watching ? 'Unwatch' : 'Watch')),
      el('div', { class: 'grid2' },
        el('div', {},
          el('div', { class: 'panel' }, field('Title', title), field('Description', desc), saveBtn),
          progress,
          el('div', { class: 'panel' }, el('h3', {}, 'Subtasks'),
            el('ul', {}, i.children.map((k) => el('li', {}, el('a', { href: `#/issue?ws=${S.ws.id}&p=${p.id}&key=${k}` }, k)))),
            addSub),
          el('div', { class: 'panel' }, el('h3', {}, 'Links'),
            el('ul', {}, i.links.map((l) => el('li', {}, `${l.type} `,
              el('a', { href: `#/issue?ws=${S.ws.id}&p=${p.id}&key=${l.target}` }, l.target),
              canEdit ? el('button', {
                class: 'danger',
                onclick: () => action(() => api('DELETE', `/api/issues/${i.key}/links/${l.id}`)),
              }, '×') : null))),
            linkAdd),
          el('div', { class: 'panel' }, el('h3', {}, 'Comments'),
            comments.map((c) => el('div', { class: 'comment' },
              el('div', { class: 'muted' }, `${userName(c.authorId)} · ${fmtDate(c.createdAt)}${c.edited ? ' · edited' : ''}`),
              el('div', {}, c.body),
              c.authorId === S.me.id ? el('button', {
                onclick: () => {
                  const body = prompt('Edit comment', c.body);
                  if (body !== null && body.trim()) action(() => api('PATCH', `/api/comments/${c.id}`, { body }));
                },
              }, 'Edit') : null)),
            canEdit ? el('div', {}, comment, el('button', {
              class: 'primary',
              onclick: () => action(() => api('POST', `/api/issues/${i.key}/comments`, { body: comment.value })),
            }, 'Comment')) : null)),
        el('div', {},
          el('div', { class: 'panel' }, el('h3', {}, 'Details'),
            field('Status', status), field('Priority', prio), field('Type', typeSel), field('Assignee', assignee),
            field('Story points', points), field('Labels (comma separated)', labels), field('Due date', due),
            canEdit ? field('Epic (key, blank to keep)', epic) : null,
            canEdit ? el('button', {
              onclick: () => action(() => api('PATCH', `/api/issues/${i.key}`, { epicId: epic.value.trim() || null })),
            }, 'Set epic') : null),
          el('div', { class: 'panel' }, el('h3', {}, 'History'),
            history.length ? el('ul', {}, history.map((h) => el('li', { class: 'muted' },
              `${fmtDate(h.at)} · ${userName(h.actorId)} changed ${h.field}: ${JSON.stringify(h.from)} → ${JSON.stringify(h.to)}`)))
              : el('div', { class: 'muted' }, 'No changes yet.')))));
  };

  // ---------- search ----------
  VIEWS.search = async (r) => {
    const q = el('input', { value: r.q || '', placeholder: 'e.g. type:bug -label:wontfix "login" points:>3', size: 50 });
    const sort = select([['updated', 'Recently updated'], ['created', 'Recently created'], ['priority', 'Priority']], r.sort || 'updated');
    const out = el('div', {});
    const run = async () => {
      out.replaceChildren();
      try {
        const params = new URLSearchParams({ q: q.value, sort: sort.value });
        if (S.project) params.set('project', S.project.id);
        const results = await api('GET', `/api/search?${params}`);
        go('search', { ws: S.ws.id, p: S.project?.id, q: q.value, sort: sort.value });
        out.append(el('p', { class: 'muted' }, `${results.length} result(s)`), el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Key'), el('th', {}, 'Title'), el('th', {}, 'Status'), el('th', {}, 'Priority'))),
          el('tbody', {}, results.map((i) => el('tr', { class: 'clickable', onclick: () => go('issue', { ws: S.ws.id, p: S.project?.id, key: i.key }) },
            el('td', {}, i.key), el('td', {}, i.title), el('td', {}, i.status), el('td', {}, i.priority))))));
      } catch (e) { out.append(el('div', { class: 'error' }, e.message)); }
    };
    setTimeout(run, 0);
    return el('div', {}, el('h2', {}, 'Search'),
      el('div', { class: 'row' }, q, sort, el('button', { class: 'primary', onclick: run }, 'Search')),
      el('p', { class: 'muted' }, 'Fields: status:"In Progress" type:bug priority:high assignee:me|none|user label:x sprint:active|none is:open|resolved due:<2026-01-01 points:>3 key:ABC-1. Prefix with - to negate. Free text and "phrases" are matched against title and description.'),
      out);
  };

  // ---------- notifications ----------
  VIEWS.notifications = async () => {
    const list = await api('GET', '/api/notifications');
    const markAll = el('button', { onclick: () => action(() => api('POST', '/api/notifications/read', { all: true })) }, 'Mark all read');
    return el('div', {}, el('h2', {}, 'Notifications'), markAll,
      el('table', {}, el('tbody', {}, list.map((n) => el('tr', {
        class: 'clickable',
        onclick: () => action(async () => {
          if (!n.read) await api('POST', '/api/notifications/read', { ids: [n.id] });
          go('issue', { ws: S.ws.id, p: S.project?.id, key: n.issueKey });
        }),
      },
      el('td', {}, el('span', { class: n.read ? 'badge' : 'badge unread' }, n.read ? 'read' : 'unread')),
      el('td', {}, n.type), el('td', {}, n.issueKey), el('td', {}, userName(n.actorId)), el('td', {}, fmtDate(n.at)))))));
  };

  async function exportCsv() {
    const res = await fetch(`/api/projects/${S.project.id}/export.csv`, { headers: { authorization: `Bearer ${S.token}` } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = el('a', { href: url, download: `${S.project.key}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- settings ----------
  VIEWS.settings = needProject(async () => {
    const p = S.project;
    const isLead = p.role === 'lead';
    const isWsAdmin = S.ws.role === 'admin';
    const blocks = [];

    if (isLead) {
      const name = el('input', { value: p.name });
      blocks.push(el('div', { class: 'panel' }, el('h3', {}, 'Project'), name, el('button', {
        onclick: () => action(() => api('PATCH', `/api/projects/${p.id}`, { name: name.value })),
      }, 'Rename')));

      const wf = el('textarea', { rows: 10 });
      wf.value = JSON.stringify(p.workflow, null, 2);
      const remap = el('textarea', { rows: 2 });
      remap.value = '{}';
      blocks.push(el('div', { class: 'panel' }, el('h3', {}, 'Workflow (JSON: statuses, transitions)'), wf,
        el('p', { class: 'muted' }, 'Optional remap of removed statuses, e.g. {"Old": "New"}'), remap,
        el('button', {
          class: 'primary',
          onclick: () => action(() => {
            const body = JSON.parse(wf.value);
            body.remap = JSON.parse(remap.value || '{}');
            return api('PUT', `/api/projects/${p.id}/workflow`, body);
          }),
        }, 'Save workflow')));

      const mUser = el('input', { placeholder: 'username' });
      const mRole = select([['developer', 'developer'], ['lead', 'lead'], ['viewer', 'viewer']], 'developer');
      blocks.push(el('div', { class: 'panel' }, el('h3', {}, 'Members'),
        el('table', {}, el('tbody', {}, p.members.map((m) => el('tr', {}, el('td', {}, m.username), el('td', {}, m.role),
          el('td', {}, el('button', { class: 'danger', onclick: () => action(() => api('DELETE', `/api/projects/${p.id}/members/${m.username}`)) }, 'Remove')))))),
        el('div', { class: 'row' }, mUser, mRole, el('button', {
          onclick: () => action(() => api('POST', `/api/projects/${p.id}/members`, { username: mUser.value, role: mRole.value })),
        }, 'Add member'))));

      const events = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
      const whUrl = el('input', { placeholder: 'https://example.com/hook', size: 40 });
      const whSecret = el('input', { placeholder: 'secret' });
      const checks = events.map((ev) => el('label', { style: 'display:inline;margin-right:8px' },
        el('input', { type: 'checkbox', value: ev, class: 'wh-ev', checked: ev !== 'issue.deleted' }), ev));
      const hooks = await api('GET', `/api/projects/${p.id}/webhooks`);
      const deliveries = el('div', {});
      blocks.push(el('div', { class: 'panel' }, el('h3', {}, 'Webhooks'),
        hooks.map((h) => el('div', { class: 'row' }, el('span', {}, `${h.url} [${h.events.join(', ')}]`),
          el('button', { onclick: async () => {
            try {
              const d = await api('GET', `/api/webhooks/${h.id}/deliveries`);
              deliveries.replaceChildren(el('pre', {}, JSON.stringify(d, null, 2)));
            } catch (e) { alert(e.message); }
          } }, 'Deliveries'),
          el('button', { class: 'danger', onclick: () => action(() => api('DELETE', `/api/webhooks/${h.id}`)) }, 'Delete'))),
        deliveries,
        el('div', { class: 'row' }, whUrl, whSecret), el('div', {}, checks),
        el('button', {
          class: 'primary',
          onclick: () => action(() => api('POST', `/api/projects/${p.id}/webhooks`, {
            url: whUrl.value,
            secret: whSecret.value,
            events: [...document.querySelectorAll('.wh-ev:checked')].map((c) => c.value),
          })),
        }, 'Add webhook')));
    }

    const csvFile = el('input', { type: 'file', accept: '.csv,text/csv' });
    blocks.push(el('div', { class: 'panel' }, el('h3', {}, 'Import / export (CSV)'),
      el('button', { onclick: () => action(exportCsv) }, 'Export CSV'),
      el('p', { class: 'muted' }, 'Import: choose a CSV file with the export columns.'),
      csvFile, el('button', {
        onclick: () => action(async () => {
          const f = csvFile.files[0];
          if (!f) throw new Error('Choose a file first');
          const text = await f.text();
          const res = await fetch(`/api/projects/${p.id}/import.csv`, {
            method: 'POST', headers: { 'content-type': 'text/csv', authorization: `Bearer ${S.token}` }, body: text,
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message);
          alert(`Created ${data.created}; ${data.errors.length} error(s)${data.errors.length ? ': ' + data.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ') : ''}`);
        }),
      }, 'Import')));

    if (isWsAdmin) {
      const mName = el('input', { placeholder: 'username' });
      const mRole = select([['member', 'member'], ['admin', 'admin'], ['guest', 'guest']], 'member');
      blocks.push(el('div', { class: 'panel' }, el('h3', {}, `Workspace members (${S.ws.name})`),
        el('table', {}, el('tbody', {}, S.ws.members.map((m) => el('tr', {}, el('td', {}, m.username), el('td', {}, m.role),
          el('td', {}, el('button', { class: 'danger', onclick: () => action(() => api('DELETE', `/api/workspaces/${S.ws.id}/members/${m.username}`)) }, 'Remove')))))),
        el('div', { class: 'row' }, mName, mRole, el('button', {
          onclick: () => action(() => api('POST', `/api/workspaces/${S.ws.id}/members`, { username: mName.value, role: mRole.value })),
        }, 'Add member'))));
    }
    if (S.ws.role !== 'guest') blocks.push(projectForm());
    return el('div', {}, el('h2', {}, `${p.name} — settings`), blocks);
  });

  window.addEventListener('hashchange', render);
  render();
})();
