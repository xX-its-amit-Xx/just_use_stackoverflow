// gui_daemon.js - persistent Chromium session for the GUI reuse-first condition.
// Holds one page; accepts JSON commands over a localhost HTTP port; logs every
// GUI action (with timing, success, URL) to $BENCH_TELEMETRY_DIR/gui.jsonl.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const WS = process.env.GUI_WORKSPACE || process.cwd();
const STATE = path.join(WS, '.gui');
const TEL = process.env.BENCH_TELEMETRY_DIR || path.join(WS, '.telemetry');
fs.mkdirSync(path.join(STATE, 'shots'), { recursive: true });
fs.mkdirSync(TEL, { recursive: true });
const VIEW = { width: 1280, height: 800 };
let shotN = 0;
let clipboard = '';

function log(rec) {
  fs.appendFileSync(path.join(TEL, 'gui.jsonl'), JSON.stringify(rec) + '\n');
}

(async () => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
  const ctx = await browser.newContext({ viewport: VIEW });
  const page = await ctx.newPage();
  let idleTimer;
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => process.exit(0), 3 * 3600e3); };
  resetIdle();

  async function run(cmd, a) {
    switch (cmd) {
      case 'open': {
        let url = a[0];
        if (!/^https?:\/\//.test(url)) url = 'https://' + url;
        const r = await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(800);
        const status = r ? r.status() : null;
        return { ok: status === null || status < 400, http_status: status, url: page.url(), title: await page.title() };
      }
      case 'screenshot': {
        const p = path.join(STATE, 'shots', `shot_${String(++shotN).padStart(4, '0')}.png`);
        await page.screenshot({ path: p });
        return { ok: true, path: p, width: VIEW.width, height: VIEW.height, url: page.url() };
      }
      case 'click': {
        await page.mouse.click(+a[0], +a[1]);
        await page.waitForTimeout(700);
        return { ok: true, url: page.url() };
      }
      case 'type': {
        const enter = a.includes('--enter');
        const text = a.filter(x => x !== '--enter').join(' ');
        await page.keyboard.type(text, { delay: 5 });
        if (enter) { await page.keyboard.press('Enter'); await page.waitForTimeout(1200); }
        return { ok: true, chars: text.length, url: page.url() };
      }
      case 'key': {
        await page.keyboard.press(a[0]);
        await page.waitForTimeout(400);
        return { ok: true, url: page.url() };
      }
      case 'scroll': {
        await page.mouse.wheel(0, +a[0]);
        await page.waitForTimeout(400);
        return { ok: true };
      }
      case 'select': {
        const [x1, y1, x2, y2] = a.map(Number);
        await page.mouse.move(x1, y1); await page.mouse.down();
        await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up();
        const sel = await page.evaluate(() => String(window.getSelection()));
        return { ok: sel.length > 0, selected_chars: sel.length };
      }
      case 'copy': {
        let text = await page.evaluate(() => String(window.getSelection()));
        let via = 'selection';
        if (!text) {
          // GUI copy buttons (e.g. GitHub "Copy raw file") write to the page clipboard.
          try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write']); text = await page.evaluate(() => navigator.clipboard.readText()); via = 'page_clipboard'; } catch (e) { text = ''; }
        }
        clipboard = text || '';
        fs.writeFileSync(path.join(STATE, 'clipboard.txt'), clipboard);
        if (clipboard) {  // history kept for provenance matching
          fs.mkdirSync(path.join(STATE, 'clipboard_history'), { recursive: true });
          fs.writeFileSync(path.join(STATE, 'clipboard_history', `${Date.now()}.txt`), `// source: ${page.url()}\n` + clipboard);
        }
        return { ok: clipboard.length > 0, via, chars: clipboard.length, lines: clipboard.split('\n').length, url: page.url() };
      }
      case 'paste': {
        const file = path.resolve(WS, a[0]);
        if (!file.startsWith(WS)) return { ok: false, error: 'paste target outside workspace' };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (a.includes('--append')) fs.appendFileSync(file, clipboard); else fs.writeFileSync(file, clipboard);
        return { ok: true, file: path.relative(WS, file), chars: clipboard.length, lines: clipboard.split('\n').length };
      }
      case 'back': await page.goBack({ timeout: 30000 }).catch(() => {}); return { ok: true, url: page.url() };
      case 'forward': await page.goForward({ timeout: 30000 }).catch(() => {}); return { ok: true, url: page.url() };
      case 'url': return { ok: true, url: page.url(), title: await page.title() };
      case 'shutdown': setTimeout(() => process.exit(0), 50); return { ok: true };
      default: return { ok: false, error: `unknown command ${cmd}` };
    }
  }

  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      resetIdle();
      const { cmd, args } = JSON.parse(body || '{}');
      const t0 = Date.now();
      let out;
      try { out = await run(cmd, args || []); } catch (e) { out = { ok: false, error: String(e.message || e).slice(0, 400), url: page.url() }; }
      const rec = { ts: t0 / 1000, tool: 'gui', command: cmd, args, duration_s: (Date.now() - t0) / 1000, ...out };
      log(rec);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(rec));
    });
  });
  srv.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(STATE, 'port'), String(srv.address().port));
  });
})();
