#!/usr/bin/env node
// Usage: node src/cli.js <file.md | -> [--toc] [--ids]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render, toc } from "./markdown.js";

function main(argv) {
    const args = argv.slice(2);
    const flags = new Set(args.filter((a) => a.startsWith("--")));
    const files = args.filter((a) => !a.startsWith("--"));
    if (files.length !== 1) {
        process.stderr.write("usage: node src/cli.js <file.md | -> [--toc] [--ids]\n");
        return 2;
    }
    const input = files[0] === "-" ? readFileSync(0, "utf8") : readFileSync(files[0], "utf8");
    if (flags.has("--toc")) {
        process.stdout.write(JSON.stringify(toc(input), null, 2) + "\n");
    } else {
        process.stdout.write(render(input, { headingIds: flags.has("--ids") }));
    }
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exitCode = main(process.argv);
}
