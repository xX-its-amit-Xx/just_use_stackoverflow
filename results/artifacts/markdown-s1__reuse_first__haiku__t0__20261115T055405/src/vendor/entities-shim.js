// Bridge: the vendored entities package is CommonJS; expose the one export
// commonmark.js needs as an ES module binding.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const entities = require("./entities/lib/index.js");
export const decodeHTMLStrict = entities.decodeHTMLStrict;
