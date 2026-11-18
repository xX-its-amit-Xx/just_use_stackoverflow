# Third-party notices

No third-party source code is vendored or adapted in `src/`. Every module
(HTTP routing, scrypt password hashing, HMAC webhook signing, RFC 4180 CSV
parsing, the search query tokenizer, and the browser SPA) was written for this
project against SPEC.md using only Node.js 22 standard-library APIs and
browser built-ins. `PROVENANCE.json` is therefore an empty array.
