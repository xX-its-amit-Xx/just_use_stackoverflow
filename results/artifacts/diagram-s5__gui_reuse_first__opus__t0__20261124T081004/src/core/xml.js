// Minimal XML parser + entity helpers (original code).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENT[e] ?? m;
  });
}

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Parses XML into a tree of {name, attrs, children, text}. Throws on gross errors. */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[2] !== undefined) {
      const name = m[2];
      // pop to matching element
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== name) k--;
      if (k > 0) stack.length = k;
      continue;
    }
    if (m[3] !== undefined) {
      const attrs = {};
      const ar = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
      const el = { name: m[3], attrs, children: [], text: '', parent: top };
      top.children.push(el);
      if (!m[5]) stack.push(el);
      continue;
    }
    if (m[6] !== undefined) { top.text += decodeEntities(m[6]); continue; }
    if (m[7] !== undefined) throw new Error('Malformed XML');
  }
  return root;
}

export function* walk(node) {
  for (const c of node.children) { yield c; yield* walk(c); }
}
