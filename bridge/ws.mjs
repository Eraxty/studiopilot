// Minimal WebSocket server (RFC 6455) on top of node:http, enough for Studio's
// built-in MCP connection: text frames, ping/pong, close. No dependencies.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WsConn extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.on('data', (d) => this.#onData(d));
    socket.on('close', () => { if (!this.closed) { this.closed = true; this.emit('close'); } });
    socket.on('error', () => socket.destroy());
  }

  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const mask = this.buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
      }
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.#frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('message', msg.toString('utf8'));
        }
      }
    }
  }

  #frame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len])
      : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 0xff])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    this.socket.write(Buffer.concat([head, payload]));
  }

  send(text) { this.#frame(0x1, Buffer.from(text, 'utf8')); }

  close() {
    if (this.closed) return;
    this.#frame(0x8, Buffer.alloc(0));
    this.closed = true;
    this.socket.end();
    this.emit('close');
  }
}

/** Attach to an http.Server; calls onConn(conn) for upgrades whose path passes accept(). */
export function attachWs(server, accept, onConn) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || !accept(req)) { socket.destroy(); return; }
    const acceptKey = createHash('sha1').update(key + GUID).digest('base64');
    const proto = req.headers['sec-websocket-protocol'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      (proto ? `Sec-WebSocket-Protocol: ${proto.split(',')[0].trim()}\r\n` : '') + '\r\n',
    );
    onConn(new WsConn(socket, req));
  });
}
