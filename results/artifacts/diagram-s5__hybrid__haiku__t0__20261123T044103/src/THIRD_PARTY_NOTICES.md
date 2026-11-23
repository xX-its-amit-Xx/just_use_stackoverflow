# Third-party notices

No third-party source code is vendored in `src/`. Every module (core library, routing,
layout, SVG rendering, draw.io importer, server, WebSocket framing, editor UI) was written
for this project from the requirements in SPEC.md. No runtime npm dependencies are used.

The WebSocket handshake and framing follow RFC 6455 (public specification, no code copied).
