#!/usr/bin/env node
// node src/cli.js <file.md|-> [--toc] [--ids]
import fs from "node:fs";
import { render, toc } from "./markdown.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const file = positional[0];

if (file === undefined) {
    process.stderr.write("usage: node src/cli.js <file.md|-> [--toc] [--ids]\n");
    process.exit(2);
}

const input = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");

if (flags.has("--toc")) {
    process.stdout.write(JSON.stringify(toc(input), null, 2) + "\n");
} else {
    process.stdout.write(render(input, { headingIds: flags.has("--ids") }));
}
