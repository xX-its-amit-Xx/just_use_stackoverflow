// markdown-s3 editor UI. Talks to the server only through the public /api routes.

const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const notice = $("#notice");
const pageList = $("#page-list");
const tagFilter = $("#tag-filter");
const sortSelect = $("#sort-select");
const searchBox = $("#search-box");

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) {
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.className = "notice" + (isError ? " error" : "");
  notice.hidden = false;
}
function clearNotice() {
  notice.hidden = true;
}

// ---------------------------------------------------------------- sidebar

async function loadTags() {
  const tags = await api("GET", "/api/tags");
  const selected = tagFilter.value;
  tagFilter.innerHTML = '<option value="">All tags</option>' +
    tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join("");
  tagFilter.value = selected;
}

async function loadPageList() {
  const params = new URLSearchParams({ sort: sortSelect.value });
  if (tagFilter.value) params.set("tag", tagFilter.value);
  const pages = await api("GET", `/api/pages?${params}`);
  const active = currentSlug();
  pageList.innerHTML = pages
    .map(
      (p) =>
        `<li data-slug="${esc(p.slug)}" class="${p.slug === active ? "active" : ""}">` +
        `<div>${esc(p.title)}</div><div class="page-meta">${esc(p.slug)} · v${p.version}</div></li>`
    )
    .join("");
  if (pages.length === 0) pageList.innerHTML = '<li class="page-meta">No pages yet.</li>';
}

pageList.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-slug]");
  if (li) location.hash = `#/page/${encodeURIComponent(li.dataset.slug)}`;
});
tagFilter.addEventListener("change", () => loadPageList().catch(reportError));
sortSelect.addEventListener("change", () => loadPageList().catch(reportError));
$("#new-page").addEventListener("click", () => {
  location.hash = "#/new";
});
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchBox.value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});

// ---------------------------------------------------------------- routing

function currentSlug() {
  const m = location.hash.match(/^#\/(?:page|edit|history)\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function reportError(err) {
  showNotice(err.message || String(err), true);
}

async function route() {
  clearNotice();
  const hash = location.hash || "#/";
  try {
    let m;
    if ((m = hash.match(/^#\/page\/([^/?]+)/))) return await showPage(decodeURIComponent(m[1]));
    if ((m = hash.match(/^#\/edit\/([^/?]+)/))) return await showEditor(decodeURIComponent(m[1]));
    if (hash === "#/new") return await showEditor(null);
    if ((m = hash.match(/^#\/history\/([^/?]+)/))) return await showHistory(decodeURIComponent(m[1]));
    if ((m = hash.match(/^#\/search\?q=(.*)$/))) return await showSearch(decodeURIComponent(m[1]));
    view.innerHTML = "<p>Select a page on the left, or create a new one.</p>";
  } catch (err) {
    if (err.status === 404) view.innerHTML = `<p>${esc(err.message)}</p>`;
    else reportError(err);
  } finally {
    loadPageList().catch(reportError);
  }
}

window.addEventListener("hashchange", route);

// ---------------------------------------------------------------- page view

function wireWikiLinks(root) {
  root.querySelectorAll("a.wikilink").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (href.startsWith("/wiki/")) {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        location.hash = `#/page/${encodeURIComponent(href.slice("/wiki/".length))}`;
      });
    }
  });
}

async function showPage(slug) {
  const page = await api("GET", `/api/pages/${encodeURIComponent(slug)}`);
  const tags = page.tags.length
    ? `<div class="tags">${page.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>`
    : "";
  const backlinks = page.backlinks.length
    ? `<ul>${page.backlinks.map((s) => `<li><a href="#/page/${encodeURIComponent(s)}">${esc(s)}</a></li>`).join("")}</ul>`
    : "<p>No pages link here.</p>";
  const links = page.links.length
    ? `<ul>${page.links.map((s) => `<li><a href="#/page/${encodeURIComponent(s)}">${esc(s)}</a></li>`).join("")}</ul>`
    : "<p>None.</p>";
  view.innerHTML = `
    <div class="toolbar">
      <h1 style="margin:0;flex:1">${esc(page.title)}</h1>
      <span class="page-meta">v${page.version} · updated ${esc(new Date(page.updatedAt).toLocaleString())}</span>
    </div>
    ${tags}
    <div class="toolbar">
      <button id="edit-btn" class="primary" type="button">Edit</button>
      <button id="history-btn" type="button">History</button>
      <button id="delete-btn" class="danger" type="button">Delete</button>
    </div>
    <article class="rendered">${page.html}</article>
    <div class="panel">
      <h3>Backlinks</h3>${backlinks}
      <h3>Links from this page</h3>${links}
    </div>`;
  wireWikiLinks(view);
  $("#edit-btn").onclick = () => (location.hash = `#/edit/${encodeURIComponent(slug)}`);
  $("#history-btn").onclick = () => (location.hash = `#/history/${encodeURIComponent(slug)}`);
  $("#delete-btn").onclick = async () => {
    if (!confirm(`Delete "${page.title}" and its history?`)) return;
    try {
      await api("DELETE", `/api/pages/${encodeURIComponent(slug)}`);
      location.hash = "#/";
    } catch (err) {
      reportError(err);
    }
  };
}

// ---------------------------------------------------------------- editor

function parseTags(text) {
  return text.split(",").map((t) => t.trim()).filter(Boolean);
}

async function showEditor(slug) {
  let page = null;
  if (slug) page = await api("GET", `/api/pages/${encodeURIComponent(slug)}`);
  const baseVersion = page ? page.version : null;
  view.innerHTML = `
    <div class="toolbar">
      <h2 style="margin:0;flex:1">${page ? "Edit " + esc(page.title) : "New page"}</h2>
      <button id="cancel-btn" type="button">Cancel</button>
      <button id="save-btn" class="primary" type="button">Save</button>
    </div>
    <div class="field"><label for="slug-input">Slug</label>
      <input id="slug-input" type="text" ${page ? "disabled" : ""} value="${esc(page ? page.slug : "")}" placeholder="my-page"></div>
    <div class="field"><label for="title-input">Title</label>
      <input id="title-input" type="text" value="${esc(page ? page.title : "")}"></div>
    <div class="field"><label for="tags-input">Tags (comma separated)</label>
      <input id="tags-input" type="text" value="${esc(page ? page.tags.join(", ") : "")}"></div>
    <div class="editor">
      <textarea id="body-input" spellcheck="false" aria-label="Markdown">${esc(page ? page.body : "")}</textarea>
      <div id="preview" class="preview rendered"></div>
    </div>`;
  const bodyInput = $("#body-input");
  const preview = $("#preview");
  let timer = null;
  const refreshPreview = async () => {
    try {
      const { html } = await api("POST", "/api/render", { markdown: bodyInput.value });
      preview.innerHTML = html;
      wireWikiLinks(preview);
    } catch (err) {
      reportError(err);
    }
  };
  bodyInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(refreshPreview, 250);
  });
  refreshPreview();

  $("#cancel-btn").onclick = () => (location.hash = page ? `#/page/${encodeURIComponent(page.slug)}` : "#/");

  const save = async (overrideVersion) => {
    const body = {
      title: $("#title-input").value,
      body: bodyInput.value,
      tags: parseTags($("#tags-input").value),
    };
    const targetSlug = page ? page.slug : $("#slug-input").value.trim();
    if (overrideVersion !== undefined) body.baseVersion = overrideVersion;
    else if (baseVersion !== null) body.baseVersion = baseVersion;
    try {
      const saved = await api("PUT", `/api/pages/${encodeURIComponent(targetSlug)}`, body);
      location.hash = `#/page/${encodeURIComponent(saved.slug)}`;
    } catch (err) {
      if (err.status === 409) {
        const current = err.data.currentVersion;
        showNotice(
          `Conflict: someone else saved version ${current}. Click "Overwrite" to save your text on top of it, or "Discard" to reload the latest page.`,
          true
        );
        notice.innerHTML = "";
        const msg = document.createElement("span");
        msg.textContent = `Conflict: the page is now at version ${current}. `;
        const over = document.createElement("button");
        over.textContent = "Overwrite";
        over.onclick = () => save(current);
        const discard = document.createElement("button");
        discard.textContent = "Discard";
        discard.onclick = () => (location.hash = `#/edit/${encodeURIComponent(targetSlug)}`);
        notice.append(msg, over, " ", discard);
      } else {
        reportError(err);
      }
    }
  };
  $("#save-btn").onclick = () => save();
}

// ---------------------------------------------------------------- history

async function showHistory(slug) {
  const [page, history] = await Promise.all([
    api("GET", `/api/pages/${encodeURIComponent(slug)}`),
    api("GET", `/api/pages/${encodeURIComponent(slug)}/history`),
  ]);
  const options = history.map((h) => `<option value="${h.version}">v${h.version} — ${esc(h.title)}</option>`).join("");
  view.innerHTML = `
    <div class="toolbar">
      <h2 style="margin:0;flex:1">History: ${esc(page.title)}</h2>
      <a href="#/page/${encodeURIComponent(slug)}">Back to page</a>
    </div>
    <table class="history">
      <thead><tr><th>Version</th><th>Title</th><th>Saved</th><th></th></tr></thead>
      <tbody>${history
        .map(
          (h) => `<tr>
            <td>v${h.version}</td><td>${esc(h.title)}</td>
            <td>${esc(new Date(h.updatedAt).toLocaleString())}</td>
            <td><button type="button" data-view="${h.version}">View</button>
                <button type="button" data-revert="${h.version}">Revert to this</button></td>
          </tr>`
        )
        .join("")}</tbody>
    </table>
    <div class="panel">
      <h3>Compare versions</h3>
      <label>From <select id="diff-from">${options}</select></label>
      <label>To <select id="diff-to">${options}</select></label>
      <button id="diff-btn" type="button">Show diff</button>
      <div id="history-out"></div>
    </div>`;
  const out = $("#history-out");
  if (history.length >= 2) {
    $("#diff-from").value = history[1].version;
    $("#diff-to").value = history[0].version;
  }
  view.querySelectorAll("button[data-view]").forEach((b) => {
    b.onclick = async () => {
      const v = await api("GET", `/api/pages/${encodeURIComponent(slug)}/versions/${b.dataset.view}`);
      out.innerHTML = `<h3>v${v.version}: ${esc(v.title)}</h3><pre class="diff">${esc(v.body)}</pre>`;
    };
  });
  view.querySelectorAll("button[data-revert]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Revert to version ${b.dataset.revert}? This creates a new version.`)) return;
      try {
        await api("POST", `/api/pages/${encodeURIComponent(slug)}/revert`, { version: Number(b.dataset.revert) });
        location.hash = `#/page/${encodeURIComponent(slug)}`;
      } catch (err) {
        reportError(err);
      }
    };
  });
  $("#diff-btn").onclick = async () => {
    const from = $("#diff-from").value;
    const to = $("#diff-to").value;
    const d = await api("GET", `/api/pages/${encodeURIComponent(slug)}/diff?from=${from}&to=${to}`);
    const rows = d.lines
      .map((l) => {
        const cls = l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx";
        return `<div class="${cls}">${esc(l.op)} ${esc(l.text)}</div>`;
      })
      .join("");
    out.innerHTML = `<h3>Diff v${d.from} → v${d.to}</h3><div class="diff">${rows || "(no lines)"}</div>`;
  };
}

// ---------------------------------------------------------------- search

async function showSearch(q) {
  searchBox.value = q;
  const results = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
  view.innerHTML = `<h2>Search: ${esc(q)}</h2>` +
    (results.length
      ? results
          .map(
            (r) => `<div class="search-result">
              <a href="#/page/${encodeURIComponent(r.slug)}"><strong>${esc(r.title)}</strong></a>
              <div class="page-meta">${esc(r.slug)} · ${r.score} match${r.score === 1 ? "" : "es"}</div>
              <div>${r.snippet}</div></div>`
          )
          .join("")
      : "<p>No matches.</p>");
}

// ---------------------------------------------------------------- start

loadTags().catch(reportError);
route();
