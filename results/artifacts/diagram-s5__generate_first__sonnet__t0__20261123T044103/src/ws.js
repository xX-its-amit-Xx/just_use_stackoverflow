// Minimal RFC 6455 server-side WebSocket on top of node:http upgrade.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  socket.setNoDelay?.(true);
  return new WSConn(socket);
}

export class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    this.handlers = { message: [], close: [] };
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); try { this._parse(); } catch { this.close(1002); } });
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }
  on(ev, f) { this.handlers[ev].push(f); return this; }
  _closed() { if (this.closed) return; this.closed = true; this.handlers.close.forEach((f) => f()); }
  _parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 32 * 1024 * 1024) throw new Error('too big');
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = b.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buf = b.subarray(need);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) this.frag = { op, parts: [payload] };
      else if (op === 0x0 && this.frag) this.frag.parts.push(payload);
      if (fin && this.frag) {
        const data = Buffer.concat(this.frag.parts);
        const isText = this.frag.op === 0x1;
        this.frag = null;
        this.handlers.message.forEach((f) => f(isText ? data.toString('utf8') : data));
      }
    }
  }
  _frame(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(obj) { this._frame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this._frame(0x8, p);
    this.socket.end();
    this._closed();
  }
}
