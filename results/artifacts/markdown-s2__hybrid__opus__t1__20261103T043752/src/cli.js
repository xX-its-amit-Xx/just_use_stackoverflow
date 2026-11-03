#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { render, toc } from "./markdown.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const file = args.find((a) => !a.startsWith("--") || a === "-") ?? "-";

let input;
try {
    input = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
} catch (err) {
    process.stderr.write(`Error reading ${file}: ${err.message}\n`);
    process.exit(1);
}

if (flags.has("--toc")) {
    process.stdout.write(JSON.stringify(toc(input), null, 2) + "\n");
} else {
    process.stdout.write(render(input, { headingIds: flags.has("--ids") }));
}
