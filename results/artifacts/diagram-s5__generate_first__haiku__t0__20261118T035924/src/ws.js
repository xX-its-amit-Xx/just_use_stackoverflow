// Minimal RFC 6455 WebSocket support on top of node:http upgrade sockets (server side only).
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

export function handshakeResponse(key) {
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
}

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame parser. feed(buf) returns an array of {opcode, payload} messages
 * (fragmented messages are reassembled). Client frames must be masked.
 */
export class FrameParser {
  constructor(maxPayload = 16 * 1024 * 1024) {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = null;
    this.maxPayload = maxPayload;
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const messages = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > this.maxPayload) throw new Error('frame too large');
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) break;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      } else {
        payload = Buffer.from(payload);
      }
      this.buf = this.buf.subarray(off + maskLen + len);

      if (opcode >= 8) {
        // Control frames may be interleaved and are never fragmented.
        messages.push({ opcode, payload });
        continue;
      }
      if (opcode !== 0) {
        this.fragOpcode = opcode;
        this.fragments = [];
      }
      this.fragments.push(payload);
      if (fin) {
        messages.push({ opcode: this.fragOpcode, payload: Buffer.concat(this.fragments) });
        this.fragments = [];
        this.fragOpcode = null;
      }
    }
    return messages;
  }
}
