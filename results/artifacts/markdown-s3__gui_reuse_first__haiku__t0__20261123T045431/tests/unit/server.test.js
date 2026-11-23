import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../../src/server.js";

async function start(dir) {
  const srv = createServer({ dataDir: dir });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? safeJson(text) : null, text };
  };
  return { srv, call, base };
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return t; } };

test("versions, conflicts, history, diff and revert", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms3-"));
  const { srv, call } = await start(dir);
  try {
    assert.equal((await call("PUT", "/api/pages/p1", { title: "P", body: "a\nb" })).status, 201);
    assert.equal((await call("PUT", "/api/pages/p1", { title: "P", body: "a\nb" })).body.version, 1);
    const up = await call("PUT", "/api/pages/p1", { title: "P", body: "a\nc", baseVersion: 1 });
    assert.equal(up.status, 200);
    assert.equal(up.body.version, 2);
    const conflict = await call("PUT", "/api/pages/p1", { title: "P", body: "z", baseVersion: 1 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "conflict");
    assert.equal(conflict.body.currentVersion, 2);
    const hist = await call("GET", "/api/pages/p1/history");
    assert.deepEqual(hist.body.map((h) => h.version), [2, 1]);
    const diff = await call("GET", "/api/pages/p1/diff?from=1&to=2");
    assert.deepEqual(diff.body.lines, [
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "c" },
    ]);
    const rev = await call("POST", "/api/pages/p1/revert", { version: 1 });
    assert.equal(rev.status, 200);
    assert.equal(rev.body.version, 3);
    assert.equal(rev.body.body, "a\nb");
    assert.equal((await call("GET", "/api/pages/p1/versions/9")).status, 404);
  } finally {
    srv.close();
  }
});

test("pages survive a restart and search / tags / export / import work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms3-"));
  let s = await start(dir);
  await s.call("PUT", "/api/pages/alpha", { title: "Alpha Notes", body: "The quick fox. Fox again", tags: ["Zed", "x"] });
  await s.call("PUT", "/api/pages/beta", { title: "Beta", body: "nothing about FOX here... fox", tags: ["x"] });
  s.srv.close();

  s = await start(dir);
  try {
    const got = await s.call("GET", "/api/pages/alpha");
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.tags, ["x", "zed"]);
    const tags = await s.call("GET", "/api/tags");
    assert.deepEqual(tags.body, [{ tag: "x", count: 2 }, { tag: "zed", count: 1 }]);
    const found = await s.call("GET", "/api/search?q=fox");
    assert.deepEqual(found.body.map((r) => r.slug), ["alpha", "beta"]);
    assert.equal(found.body[0].score, 2);
    assert.match(found.body[0].snippet, /<mark>fox<\/mark>/);
    assert.equal((await s.call("GET", "/api/search?q=%20")).status, 400);
    const byTag = await s.call("GET", "/api/pages?tag=zed");
    assert.deepEqual(byTag.body.map((p) => p.slug), ["alpha"]);
    const exp = await s.call("GET", "/api/export");
    const imp = await s.call("POST", "/api/import", { pages: [{ slug: "gamma", title: "G", body: "hi" }] });
    assert.deepEqual(imp.body, { imported: 1 });
    assert.equal((await s.call("GET", "/api/pages/gamma")).status, 200);
    assert.equal(exp.body.pages.length, 2);
    assert.equal((await s.call("DELETE", "/api/pages/beta")).status, 204);
    assert.equal((await s.call("GET", "/api/pages/beta")).status, 404);
  } finally {
    s.srv.close();
  }
});

test("validation and backlinks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms3-"));
  const { srv, call } = await start(dir);
  try {
    assert.equal((await call("PUT", "/api/pages/Bad_Slug", { title: "x" })).status, 400);
    assert.equal((await call("PUT", "/api/pages/ok", { title: "" })).status, 400);
    assert.equal((await call("PUT", "/api/pages/ok", { title: "x".repeat(201) })).status, 400);
    assert.equal((await call("PUT", "/api/pages/ok", "{bad json")).status, 400);
    await call("PUT", "/api/pages/home", { title: "Home", body: "See [[Notes]] and [[Gone]]" });
    await call("PUT", "/api/pages/notes", { title: "Notes", body: "back to [[Home]]" });
    const home = await call("GET", "/api/pages/home");
    assert.deepEqual(home.body.links, ["gone", "notes"]);
    assert.deepEqual(home.body.backlinks, ["notes"]);
    assert.match(home.body.html, /<a href="\/wiki\/gone" class="wikilink missing">Gone<\/a>/);
    const page = await call("GET", "/wiki/notes");
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>Notes<\/title>/);
    assert.equal((await call("GET", "/wiki/none")).status, 404);
    assert.equal((await call("GET", "/nope")).status, 404);
    const ui = await call("GET", "/");
    assert.equal(ui.status, 200);
  } finally {
    srv.close();
  }
});
