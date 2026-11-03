"use strict";

import { escapeXml } from "./common.js";
import Renderer from "./renderer.js";

// Local modification: always-on URL scheme filtering.
var reUnsafeProtocol = /^(?:javascript|vbscript|file|data):/i;
var reSafeDataProtocol = /^data:image\/(?:png|gif|jpeg|webp);/i;

var potentiallyUnsafe = function(url) {
    var u = String(url)
        .replace(/%(?:0[0-9a-f]|1[0-9a-f]|20)/gi, "")
        .replace(/[\u0000-\u0020\u007f]/g, "");
    return reUnsafeProtocol.test(u) && !reSafeDataProtocol.test(u);
};

var safeUrl = function(url) {
    return potentiallyUnsafe(url) ? "#" : url;
};

// Helper function to produce an HTML tag.
function tag(name, attrs, selfclosing) {
    if (this.disableTags > 0) {
        return;
    }
    this.buffer += "<" + name;
    if (attrs && attrs.length > 0) {
        var i = 0;
        var attrib;
        while ((attrib = attrs[i]) !== undefined) {
            this.buffer += " " + attrib[0] + '="' + attrib[1] + '"';
            i++;
        }
    }
    if (selfclosing) {
        this.buffer += " /";
    }
    this.buffer += ">";
    this.lastOut = ">";
}

function HtmlRenderer(options) {
    options = options || {};
    // by default, soft breaks are rendered as newlines in HTML
    options.softbreak = options.softbreak || "\n";
    // set to "<br />" to make them hard breaks
    // set to " " if you want to ignore line wrapping in source
    this.esc = options.esc || escapeXml;
    // escape html with a custom function
    // else use escapeXml

    this.disableTags = 0;
    this.lastOut = "\n";
    this.options = options;
}

/* Node methods */

function text(node) {
    this.out(node.literal);
}

function softbreak() {
    this.lit(this.options.softbreak);
}

function linebreak() {
    this.tag("br", [], true);
    this.cr();
}

function link(node, entering) {
    var attrs = this.attrs(node);
    if (entering) {
        attrs.push(["href", this.esc(safeUrl(node.destination))]);
        if (node.title) {
            attrs.push(["title", this.esc(node.title)]);
        }
        this.tag("a", attrs);
    } else {
        this.tag("/a");
    }
}

function image(node, entering) {
    if (entering) {
        if (this.disableTags === 0) {
            this.lit('<img src="' + this.esc(safeUrl(node.destination)) + '" alt="');
        }
        this.disableTags += 1;
    } else {
        this.disableTags -= 1;
        if (this.disableTags === 0) {
            if (node.title) {
                this.lit('" title="' + this.esc(node.title));
            }
            this.lit('" />');
        }
    }
}

function emph(node, entering) {
    this.tag(entering ? "em" : "/em");
}

function strong(node, entering) {
    this.tag(entering ? "strong" : "/strong");
}

function paragraph(node, entering) {
    var grandparent = node.parent.parent,
        attrs = this.attrs(node);
    if (grandparent !== null && grandparent.type === "list") {
        if (grandparent.listTight) {
            return;
        }
    }
    if (entering) {
        this.cr();
        this.tag("p", attrs);
    } else {
        this.tag("/p");
        this.cr();
    }
}

function heading(node, entering) {
    var tagname = "h" + node.level,
        attrs = this.attrs(node);
    if (node._headingId !== undefined) {
        attrs.push(["id", this.esc(node._headingId)]);
    }
    if (entering) {
        this.cr();
        this.tag(tagname, attrs);
    } else {
        this.tag("/" + tagname);
        this.cr();
    }
}

function code(node) {
    this.tag("code");
    this.out(node.literal);
    this.tag("/code");
}

function code_block(node) {
    var info_words = node.info ? node.info.split(/\s+/) : [],
        attrs = this.attrs(node);
    if (info_words.length > 0 && info_words[0].length > 0) {
        var cls = this.esc(info_words[0]);
        if (!/^language-/.exec(cls)) {
          cls = "language-" + cls;
        }
        attrs.push(["class", cls]);
    }
    this.cr();
    this.tag("pre");
    this.tag("code", attrs);
    this.out(node.literal);
    this.tag("/code");
    this.tag("/pre");
    this.cr();
}

function thematic_break(node) {
    var attrs = this.attrs(node);
    this.cr();
    this.tag("hr", attrs, true);
    this.cr();
}

function block_quote(node, entering) {
    var attrs = this.attrs(node);
    if (entering) {
        this.cr();
        this.tag("blockquote", attrs);
        this.cr();
    } else {
        this.cr();
        this.tag("/blockquote");
        this.cr();
    }
}

function list(node, entering) {
    var tagname = node.listType === "bullet" ? "ul" : "ol",
        attrs = this.attrs(node);

    if (entering) {
        var start = node.listStart;
        if (start !== null && start !== 1) {
            attrs.push(["start", start.toString()]);
        }
        this.cr();
        this.tag(tagname, attrs);
        this.cr();
    } else {
        this.cr();
        this.tag("/" + tagname);
        this.cr();
    }
}

function item(node, entering) {
    var attrs = this.attrs(node);
    if (entering) {
        this.tag("li", attrs);
    } else {
        this.tag("/li");
        this.cr();
    }
}

// Local modification: raw HTML is never passed through; it is escaped.
function html_inline(node) {
    this.out(node.literal);
}

function html_block(node) {
    this.cr();
    this.tag("p");
    this.out(node.literal);
    this.tag("/p");
    this.cr();
}

// GFM extensions (local addition)
function strikethrough(node, entering) {
    this.tag(entering ? "del" : "/del");
}

function table(node, entering) {
    if (entering) {
        this.cr();
        this.tag("table");
        this.cr();
    } else {
        if (node.lastChild && !node.lastChild._isHeader) {
            this.tag("/tbody");
            this.cr();
        }
        this.tag("/table");
        this.cr();
    }
}

function table_row(node, entering) {
    if (entering) {
        if (node._isHeader) {
            this.tag("thead");
            this.cr();
        } else if (node.prev && node.prev._isHeader) {
            this.tag("tbody");
            this.cr();
        }
        this.tag("tr");
        this.cr();
    } else {
        this.tag("/tr");
        this.cr();
        if (node._isHeader) {
            this.tag("/thead");
            this.cr();
        }
    }
}

function table_cell(node, entering) {
    var name = node._isHeader ? "th" : "td";
    if (entering) {
        var attrs = node._align ? [["align", node._align]] : [];
        this.tag(name, attrs);
    } else {
        this.tag("/" + name);
        this.cr();
    }
}

function custom_inline(node, entering) {
    if (entering && node.onEnter) {
        this.lit(node.onEnter);
    } else if (!entering && node.onExit) {
        this.lit(node.onExit);
    }
}

function custom_block(node, entering) {
    this.cr();
    if (entering && node.onEnter) {
        this.lit(node.onEnter);
    } else if (!entering && node.onExit) {
        this.lit(node.onExit);
    }
    this.cr();
}

/* Helper methods */

function out(s) {
    this.lit(this.esc(s));
}

function attrs(node) {
    var att = [];
    if (this.options.sourcepos) {
        var pos = node.sourcepos;
        if (pos) {
            att.push([
                "data-sourcepos",
                String(pos[0][0]) +
                    ":" +
                    String(pos[0][1]) +
                    "-" +
                    String(pos[1][0]) +
                    ":" +
                    String(pos[1][1])
            ]);
        }
    }
    return att;
}

// quick browser-compatible inheritance
HtmlRenderer.prototype = Object.create(Renderer.prototype);

HtmlRenderer.prototype.text = text;
HtmlRenderer.prototype.html_inline = html_inline;
HtmlRenderer.prototype.html_block = html_block;
HtmlRenderer.prototype.softbreak = softbreak;
HtmlRenderer.prototype.linebreak = linebreak;
HtmlRenderer.prototype.link = link;
HtmlRenderer.prototype.image = image;
HtmlRenderer.prototype.emph = emph;
HtmlRenderer.prototype.strong = strong;
HtmlRenderer.prototype.paragraph = paragraph;
HtmlRenderer.prototype.heading = heading;
HtmlRenderer.prototype.code = code;
HtmlRenderer.prototype.code_block = code_block;
HtmlRenderer.prototype.thematic_break = thematic_break;
HtmlRenderer.prototype.block_quote = block_quote;
HtmlRenderer.prototype.list = list;
HtmlRenderer.prototype.item = item;
HtmlRenderer.prototype.custom_inline = custom_inline;
HtmlRenderer.prototype.custom_block = custom_block;
HtmlRenderer.prototype.strikethrough = strikethrough;
HtmlRenderer.prototype.table = table;
HtmlRenderer.prototype.table_row = table_row;
HtmlRenderer.prototype.table_cell = table_cell;

HtmlRenderer.prototype.esc = escapeXml;

HtmlRenderer.prototype.out = out;
HtmlRenderer.prototype.tag = tag;
HtmlRenderer.prototype.attrs = attrs;

export default HtmlRenderer;
