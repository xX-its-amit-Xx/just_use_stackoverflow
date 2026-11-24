import { createRequire } from 'node:module';
const commonmark = createRequire(import.meta.url)('./vendor/commonmark.cjs');
const reader = new commonmark.Parser();
const writer = new commonmark.HtmlRenderer();

// Raw HTML is never passed through: convert html nodes to escaped text.
function neutralize(ast) {
  const w = ast.walker();
  let ev;
  const todo = [];
  while ((ev = w.next())) {
    if (ev.entering && (ev.node.type === 'html_inline' || ev.node.type === 'html_block')) todo.push(ev.node);
  }
  for (const n of todo) {
    const lit = n.literal;
    if (n.type === 'html_inline') {
      const t = new commonmark.Node('text');
      t.literal = lit;
      n.insertBefore(t);
      n.unlink();
    } else {
      const p = new commonmark.Node('paragraph');
      const t = new commonmark.Node('text');
      t.literal = lit.replace(/\n$/, '');
      p.appendChild(t);
      n.insertBefore(p);
      n.unlink();
    }
  }
}

export function render(markdown) {
  const ast = reader.parse(String(markdown));
  neutralize(ast);
  return writer.render(ast);
}
