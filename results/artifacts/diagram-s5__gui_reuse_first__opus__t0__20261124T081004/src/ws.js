// Minimal RFC 6455 WebSocket server-side connection on top of node:http upgrade.
// Original code (no third-party source).
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify({ error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'not_found', message });
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Not Found'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    socket.setNoDelay?.(true);
    socket.on('data', d => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  static upgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { rejectUpgrade(socket, 400, 'bad websocket request'); return null; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const ws = new WsConnection(socket);
    if (head && head.length) ws._onData(head);
    return ws;
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024 * 1024) { this.close(1009); return; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else payload = Buffer.from(payload);
      this.buf = this.buf.subarray(off + maskLen + len);
      this._frame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      if (!this.closing) this._send(0x8, payload.subarray(0, 2));
      this.closing = true;
      this.socket.end();
      this._closed();
      return;
    }
    if (opcode === 0x9) { this._send(0xA, payload); return; }
    if (opcode === 0xA) return;
    if (opcode === 0x0) {
      if (!this.frag) return;
      this.frag.parts.push(payload);
      if (fin) { const { op, parts } = this.frag; this.frag = null; this._message(op, Buffer.concat(parts)); }
      return;
    }
    if (!fin) { this.frag = { op: opcode, parts: [payload] }; return; }
    this._message(opcode, payload);
  }

  _message(opcode, data) {
    this.emit('message', opcode === 0x1 ? data.toString('utf8') : data, opcode === 0x2);
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(data) {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    this._send(0x1, Buffer.from(s, 'utf8'));
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    this.closing = true;
    this._send(0x8, p);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
    this._closed();
  }

  terminate() { this.socket.destroy(); this._closed(); }
}
