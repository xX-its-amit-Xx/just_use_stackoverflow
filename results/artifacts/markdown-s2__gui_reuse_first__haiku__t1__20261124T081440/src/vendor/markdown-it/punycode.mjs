// Glue (project-written): stands in for the deprecated `punycode` package used
// by markdown-it's normalizeLink. ASCII hosts are returned unchanged; IDN hosts
// are converted with the WHATWG URL parser (which performs IDNA/punycode).

const ASCII_RE = /^[\u0000-\u007f]*$/;

export default {
  toASCII (host) {
    if (ASCII_RE.test(host)) return host;
    try {
      return new URL(`http://${host}`).hostname;
    } catch {
      return host;
    }
  },
  // Display-only conversion used by normalizeLinkText; left as identity.
  toUnicode (host) {
    return host;
  }
};
