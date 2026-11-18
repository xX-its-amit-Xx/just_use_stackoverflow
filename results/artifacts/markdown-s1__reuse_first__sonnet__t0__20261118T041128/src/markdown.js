import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const commonmark = require("./commonmark.cjs");

const reader = new commonmark.Parser();
const writer = new commonmark.HtmlRenderer({ safe: false });

export function render(markdown) {
  const ast = reader.parse(String(markdown));
  const w = ast.walker();
  const todo = [];
  let ev;
  while ((ev = w.next())) {
    if (ev.entering && (ev.node.type === "html_inline" || ev.node.type === "html_block")) todo.push(ev.node);
  }
  for (const n of todo) {
    const t = new commonmark.Node("text");
    if (n.type === "html_inline") {
      t.literal = n.literal;
      n.insertBefore(t);
    } else {
      const p = new commonmark.Node("paragraph");
      t.literal = n.literal.replace(/\n$/, "");
      p.appendChild(t);
      n.insertBefore(p);
    }
    n.unlink();
  }
  return writer.render(ast);
}
