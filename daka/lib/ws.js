'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    if (hi !== 0) return { error: 'frame too large' };
    len = lo;
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const mask = buf.subarray(maskOffset, maskOffset + 4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { opcode, payload, rest: buf.subarray(offset + len) };
}

function encodeFrame(data, opcode) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode || 0x1);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode || 0x1);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode || 0x1);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

class WsHub extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }

  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      ''
    ].join('\r\n');
    socket.write(headers);

    const client = { socket, buf: Buffer.alloc(0), alive: true };
    this.clients.add(client);
    this.emit('connection', client);

    socket.on('data', chunk => {
      client.buf = Buffer.concat([client.buf, chunk]);
      while (true) {
        const frame = decodeFrame(client.buf);
        if (!frame) break;
        if (frame.error) {
          socket.destroy();
          break;
        }
        client.buf = frame.rest;
        if (frame.opcode === 0x8) {
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
          socket.end();
          break;
        }
        if (frame.opcode === 0x9) {
          try { socket.write(encodeFrame(frame.payload, 0xA)); } catch {}
          continue;
        }
        if (frame.opcode === 0x1) {
          let msg = null;
          try { msg = JSON.parse(frame.payload.toString('utf8')); } catch {}
          this.emit('message', client, msg, frame.payload.toString('utf8'));
        }
      }
    });

    const cleanup = () => {
      this.clients.delete(client);
      this.emit('close', client);
    };
    socket.on('close', cleanup);
    socket.on('end', cleanup);
    socket.on('error', cleanup);
  }

  send(client, obj) {
    if (!client || !client.socket || client.socket.destroyed) return;
    try {
      client.socket.write(encodeFrame(JSON.stringify(obj), 0x1));
    } catch {}
  }

  broadcast(obj) {
    for (const c of this.clients) this.send(c, obj);
  }

  count() {
    return this.clients.size;
  }
}

module.exports = { WsHub };
