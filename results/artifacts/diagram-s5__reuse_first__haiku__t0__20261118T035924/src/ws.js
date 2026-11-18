// Minimal RFC 6455 WebSocket framing on top of node:http (text frames, ping/pong, close).
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 8 * 1024 * 1024;

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

// Incremental parser for client frames (which must be masked).
// Calls onMessage(text) for complete text messages, onPing(payload), onClose().
export class FrameParser {
  constructor({ onMessage, onPing, onClose, onError }) {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.handlers = { onMessage, onPing, onClose, onError };
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = this.buf.readUInt32BE(2) * 2 ** 32 + this.buf.readUInt32BE(6); off = 10;
      }
      if (!masked) return this.handlers.onError?.(new Error('client frames must be masked'));
      if (len > MAX_MESSAGE) return this.handlers.onError?.(new Error('frame too large'));
      if (this.buf.length < off + 4 + len) return;
      const key = this.buf.subarray(off, off + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = this.buf[off + 4 + i] ^ key[i % 4];
      this.buf = this.buf.subarray(off + 4 + len);
      if (opcode === 0x8) { this.handlers.onClose?.(); return; }
      if (opcode === 0x9) { this.handlers.onPing?.(payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.handlers.onMessage?.(msg);
        }
      }
    }
  }
}
