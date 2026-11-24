// Minimal RFC 6455 WebSocket framing on top of node:http upgrades (text/binary/ping/close).
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

// Incremental parser for client->server frames (always masked per RFC 6455).
export class FrameParser {
  constructor({ onMessage, onPing, onClose }) {
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.onMessage = onMessage;
    this.onPing = onPing;
    this.onClose = onClose;
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6);
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = buf.subarray(off + len);

      if (opcode === 0x8) { this.onClose && this.onClose(); return; }
      if (opcode === 0x9) { this.onPing && this.onPing(payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode !== 0x0) this.frag = { opcode, parts: [] };
      if (!this.frag) continue;
      this.frag.parts.push(payload);
      if (fin) {
        const data = Buffer.concat(this.frag.parts);
        const op = this.frag.opcode;
        this.frag = null;
        this.onMessage && this.onMessage(op, data);
      }
    }
  }
}
