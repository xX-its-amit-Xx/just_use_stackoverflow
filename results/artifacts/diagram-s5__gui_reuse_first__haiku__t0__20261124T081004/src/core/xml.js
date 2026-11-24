import { DiagramError } from './errors.js';

// Minimal non-validating XML parser (elements, attributes, text, CDATA, comments).
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(src) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(src)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[2] !== undefined) {
      const name = m[2];
      let i = stack.length - 1;
      while (i > 0 && stack[i].name !== name) i--;
      if (i === 0) throw new DiagramError(`malformed XML: unexpected </${name}>`);
      stack.length = i;
    } else if (m[3] !== undefined) {
      const attrs = {};
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(m[4] || '')) !== null) {
        attrs[a[1]] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
      }
      const node = { name: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  return root;
}

export function walk(node, fn) {
  for (const c of node.children) {
    fn(c);
    walk(c, fn);
  }
}

export function findAll(node, name) {
  const out = [];
  walk(node, c => { if (c.name === name) out.push(c); });
  return out;
}
