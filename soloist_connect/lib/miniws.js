'use strict';
// Minimal RFC 6455 WebSocket client for localhost JSON APIs (text frames).
// Replaces the `ws` npm package for the Soloist local API. Supports: client
// handshake, masked client frames, server frame parsing (incl. 16/64-bit
// lengths and fragmentation), ping/pong, close.

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class MiniWS extends EventEmitter {
  constructor(url) {
    super();
    const m = /^ws:\/\/([^:/]+):(\d+)(\/.*)?$/.exec(url);
    if (!m) throw new Error('MiniWS: unsupported URL ' + url);
    this.host = m[1];
    this.port = parseInt(m[2], 10);
    this.path = m[3] || '/';
    this.readyState = MiniWS.CONNECTING;
    this._buf = Buffer.alloc(0);
    this._frag = null;
    this._connect();
  }

  // Emitting 'error' on an EventEmitter with no listeners THROWS and would
  // crash the host process (Volumio). Only emit if someone is listening.
  _emitError(e) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', e);
    }
  }

  _connect() {
    const key = crypto.randomBytes(16).toString('base64');
    this._accept = crypto.createHash('sha1').update(key + GUID).digest('base64');

    this.sock = net.connect(this.port, this.host, () => {
      this.sock.write(
        `GET ${this.path} HTTP/1.1\r\n` +
          `Host: ${this.host}:${this.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    this.sock.setNoDelay(true);
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', (e) => this._emitError(e));
    this.sock.on('close', () => {
      const wasOpen = this.readyState !== MiniWS.CLOSED;
      this.readyState = MiniWS.CLOSED;
      if (wasOpen) this.emit('close');
    });
  }

  _onData(data) {
    this._buf = Buffer.concat([this._buf, data]);

    if (this.readyState === MiniWS.CONNECTING) {
      const idx = this._buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const header = this._buf.slice(0, idx).toString('utf8');
      this._buf = this._buf.slice(idx + 4);
      const okStatus = /^HTTP\/1\.1 101/.test(header);
      const acceptMatch = /sec-websocket-accept:\s*(\S+)/i.exec(header);
      if (!okStatus || !acceptMatch || acceptMatch[1] !== this._accept) {
        this._emitError(new Error('MiniWS: handshake failed'));
        this.sock.destroy();
        return;
      }
      this.readyState = MiniWS.OPEN;
      this.emit('open');
    }

    // Parse frames
    for (;;) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const hi = this._buf.readUInt32BE(2);
        const lo = this._buf.readUInt32BE(6);
        if (hi !== 0) {
          this._emitError(new Error('MiniWS: frame too large'));
          this.sock.destroy();
          return;
        }
        len = lo;
        off = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this._buf.length < off + 4) return;
        maskKey = this._buf.slice(off, off + 4);
        off += 4;
      }
      if (this._buf.length < off + len) return;

      let payload = this._buf.slice(off, off + len);
      this._buf = this._buf.slice(off + len);
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }

      switch (opcode) {
        case 0x0: // continuation
          if (this._frag) {
            this._frag.chunks.push(payload);
            if (fin) {
              const full = Buffer.concat(this._frag.chunks);
              const wasText = this._frag.text;
              this._frag = null;
              if (wasText) this.emit('message', full.toString('utf8'));
            }
          }
          break;
        case 0x1: // text
          if (fin) this.emit('message', payload.toString('utf8'));
          else this._frag = { text: true, chunks: [payload] };
          break;
        case 0x2: // binary (unused by Soloist) — ignore or fragment-track
          if (!fin) this._frag = { text: false, chunks: [payload] };
          break;
        case 0x8: // close
          this._sendFrame(0x8, Buffer.alloc(0));
          this.sock.end();
          break;
        case 0x9: // ping -> pong
          this._sendFrame(0xa, payload);
          break;
        case 0xa: // pong
          break;
        default:
          break;
      }
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.sock || this.sock.destroyed) return;
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    header[0] = 0x80 | opcode;
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i++) maskedPayload[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, maskedPayload]));
  }

  send(text) {
    if (this.readyState !== MiniWS.OPEN) return;
    this._sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close() {
    if (this.readyState === MiniWS.OPEN) {
      this.readyState = MiniWS.CLOSING;
      this._sendFrame(0x8, Buffer.alloc(0));
    }
    if (this.sock) this.sock.end();
  }
}

MiniWS.CONNECTING = 0;
MiniWS.OPEN = 1;
MiniWS.CLOSING = 2;
MiniWS.CLOSED = 3;

module.exports = MiniWS;
