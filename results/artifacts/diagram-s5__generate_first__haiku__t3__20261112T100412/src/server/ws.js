import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Completes the RFC 6455 opening handshake on a raw socket. */
export function acceptHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

/** Minimal RFC 6455 framing: text messages, ping/pong, close. */
export class WsConnection {
  constructor(socket, { onMessage, onClose }) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = null;
    this.closed = false;
    this.onMessage = onMessage;
    this.onClose = onClose;
    socket.on('data', (chunk) => this._data(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const f = this._parse();
      if (!f) break;
      if (f.opcode === 0x8) {
        this._frame(0x8, Buffer.alloc(0));
        this.socket.end();
        this._closed();
        return;
      }
      if (f.opcode === 0x9) {
        this._frame(0xa, f.payload);
      } else if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (f.fin) this._deliver(f.payload);
        else this.frags = [f.payload];
      } else if (f.opcode === 0x0 && this.frags) {
        this.frags.push(f.payload);
        if (f.fin) {
          const all = Buffer.concat(this.frags);
          this.frags = null;
          this._deliver(all);
        }
      }
    }
  }

  _deliver(payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      this.send({ type: 'error', message: 'invalid JSON' });
      return;
    }
    this.onMessage?.(msg);
  }

  _parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _frame(opcode, payload) {
    if (this.closed && opcode !== 0x8) return;
    const n = payload.length;
    let header;
    if (n < 126) {
      header = Buffer.from([0x80 | opcode, n]);
    } else if (n < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(n, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(n), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    this._frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close() {
    this._frame(0x8, Buffer.alloc(0));
    this.socket.end();
    this._closed();
  }
}
