// GitHub-style heading slugs and plain-text extraction (project code).

// Lower-case, drop everything except letters, digits, space, '-' and '_',
// then turn spaces into '-'. Repeats get -1, -2, ... when `seen` is given.
export function slugify(text, seen) {
    const base = String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{Nd} _-]/gu, "")
        .replace(/ /g, "-");
    if (!seen) {
        return base;
    }
    if (!seen.has(base)) {
        seen.set(base, 0);
        return base;
    }
    let n = seen.get(base) + 1;
    let candidate = `${base}-${n}`;
    while (seen.has(candidate)) {
        n++;
        candidate = `${base}-${n}`;
    }
    seen.set(base, n);
    seen.set(candidate, 0);
    return candidate;
}

// Concatenate the literal text of a node's descendants (inline markup removed).
export function plainText(node) {
    let out = "";
    const walker = node.walker();
    let event;
    while ((event = walker.next())) {
        const t = event.node.type;
        if (!event.entering) {
            continue;
        }
        if (t === "text" || t === "code") {
            out += event.node.literal;
        } else if (t === "softbreak" || t === "linebreak") {
            out += " ";
        }
    }
    return out.trim();
}
