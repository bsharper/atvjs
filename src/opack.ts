/**
 * OPACK serialization format - Apple's binary encoding (similar to MessagePack).
 * Direct port of pyatv/support/opack.py.
 */

/**
 * Wrapper to force a number to be encoded as float64.
 * In JavaScript, 1000.0 === 1000, so we can't distinguish floats from integers.
 * Use opackFloat(1000) to ensure encoding as float64.
 */
export class OpackFloat {
  constructor(public readonly value: number) {}
}

export function opackFloat(value: number): OpackFloat {
  return new OpackFloat(value);
}

export function pack(data: unknown): Buffer {
  return Buffer.from(_pack(data, []));
}

function _pack(data: unknown, objectList: Uint8Array[]): Uint8Array {
  let packed: Uint8Array;

  if (data === null || data === undefined) {
    packed = new Uint8Array([0x04]);
  } else if (typeof data === 'boolean') {
    packed = new Uint8Array([data ? 0x01 : 0x02]);
  } else if (data instanceof OpackFloat) {
    // Force float64 encoding
    const buf = Buffer.alloc(9);
    buf[0] = 0x36;
    buf.writeDoubleLE(data.value, 1);
    packed = buf;
  } else if (typeof data === 'number') {
    if (Number.isInteger(data)) {
      packed = packInteger(data);
    } else {
      // float64
      const buf = Buffer.alloc(9);
      buf[0] = 0x36;
      buf.writeDoubleLE(data, 1);
      packed = buf;
    }
  } else if (typeof data === 'string') {
    packed = packString(data);
  } else if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    packed = packBytes(data instanceof Uint8Array ? Buffer.from(data) : data);
  } else if (Array.isArray(data)) {
    const parts: Uint8Array[] = [new Uint8Array([0xd0 + Math.min(data.length, 0xf)])];
    for (const item of data) {
      parts.push(_pack(item, objectList));
    }
    if (data.length >= 0xf) {
      parts.push(new Uint8Array([0x03]));
    }
    packed = concatBytes(parts);
  } else if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    const parts: Uint8Array[] = [new Uint8Array([0xe0 + Math.min(entries.length, 0xf)])];
    for (const [key, value] of entries) {
      parts.push(_pack(key, objectList));
      parts.push(_pack(value, objectList));
    }
    if (entries.length >= 0xf) {
      parts.push(new Uint8Array([0x03]));
    }
    packed = concatBytes(parts);
  } else {
    throw new TypeError(`Unsupported type: ${typeof data}`);
  }

  // Object deduplication
  const idx = findInObjectList(objectList, packed);
  if (idx >= 0) {
    if (idx < 0x21) {
      packed = new Uint8Array([0xa0 + idx]);
    } else if (idx <= 0xff) {
      packed = new Uint8Array([0xc1, idx]);
    } else if (idx <= 0xffff) {
      const buf = Buffer.alloc(3);
      buf[0] = 0xc2;
      buf.writeUInt16LE(idx, 1);
      packed = buf;
    }
  } else if (packed.length > 1) {
    objectList.push(packed);
  }

  return packed;
}

function packInteger(data: number): Uint8Array {
  if (data >= 0 && data < 0x28) {
    return new Uint8Array([data + 8]);
  } else if (data >= 0 && data <= 0xff) {
    return new Uint8Array([0x30, data]);
  } else if (data >= 0 && data <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0x31;
    buf.writeUInt16LE(data, 1);
    return buf;
  } else if (data >= 0 && data <= 0xffffffff) {
    const buf = Buffer.alloc(5);
    buf[0] = 0x32;
    buf.writeUInt32LE(data, 1);
    return buf;
  } else {
    const buf = Buffer.alloc(9);
    buf[0] = 0x33;
    buf.writeBigUInt64LE(BigInt(data), 1);
    return buf;
  }
}

function packString(data: string): Uint8Array {
  const encoded = Buffer.from(data, 'utf-8');
  if (encoded.length <= 0x20) {
    return Buffer.concat([Buffer.from([0x40 + encoded.length]), encoded]);
  } else if (encoded.length <= 0xff) {
    return Buffer.concat([Buffer.from([0x61, encoded.length]), encoded]);
  } else if (encoded.length <= 0xffff) {
    const hdr = Buffer.alloc(3);
    hdr[0] = 0x62;
    hdr.writeUInt16LE(encoded.length, 1);
    return Buffer.concat([hdr, encoded]);
  } else if (encoded.length <= 0xffffff) {
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x63;
    hdr.writeUIntLE(encoded.length, 1, 3);
    return Buffer.concat([hdr, encoded]);
  } else {
    const hdr = Buffer.alloc(5);
    hdr[0] = 0x64;
    hdr.writeUInt32LE(encoded.length, 1);
    return Buffer.concat([hdr, encoded]);
  }
}

function packBytes(data: Buffer): Uint8Array {
  if (data.length <= 0x20) {
    return Buffer.concat([Buffer.from([0x70 + data.length]), data]);
  } else if (data.length <= 0xff) {
    return Buffer.concat([Buffer.from([0x91, data.length]), data]);
  } else if (data.length <= 0xffff) {
    const hdr = Buffer.alloc(3);
    hdr[0] = 0x92;
    hdr.writeUInt16LE(data.length, 1);
    return Buffer.concat([hdr, data]);
  } else if (data.length <= 0xffffffff) {
    const hdr = Buffer.alloc(5);
    hdr[0] = 0x93;
    hdr.writeUInt32LE(data.length, 1);
    return Buffer.concat([hdr, data]);
  } else {
    const hdr = Buffer.alloc(9);
    hdr[0] = 0x94;
    hdr.writeBigUInt64LE(BigInt(data.length), 1);
    return Buffer.concat([hdr, data]);
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map(p => Buffer.from(p)));
}

function findInObjectList(list: Uint8Array[], item: Uint8Array): number {
  for (let i = 0; i < list.length; i++) {
    if (Buffer.from(list[i]).equals(Buffer.from(item))) return i;
  }
  return -1;
}

export interface UnpackResult {
  value: unknown;
  remaining: Buffer;
}

export function unpack(data: Buffer): UnpackResult {
  const [value, remaining] = _unpack(data, []);
  return { value, remaining: Buffer.from(remaining) };
}

function _unpack(data: Buffer, objectList: unknown[]): [unknown, Buffer] {
  const byte0 = data[0];
  let value: unknown;
  let remaining: Buffer;
  let addToObjectList = true;

  if (byte0 === 0x01) {
    value = true; remaining = data.subarray(1); addToObjectList = false;
  } else if (byte0 === 0x02) {
    value = false; remaining = data.subarray(1); addToObjectList = false;
  } else if (byte0 === 0x04) {
    value = null; remaining = data.subarray(1); addToObjectList = false;
  } else if (byte0 === 0x05) {
    // UUID - 16 bytes
    value = data.subarray(1, 17);
    remaining = data.subarray(17);
  } else if (byte0 === 0x06) {
    // Absolute time as integer
    value = Number(data.readBigUInt64LE(1));
    remaining = data.subarray(9);
  } else if (byte0 >= 0x08 && byte0 <= 0x2f) {
    value = byte0 - 8; remaining = data.subarray(1); addToObjectList = false;
  } else if (byte0 === 0x35) {
    value = data.readFloatLE(1); remaining = data.subarray(5);
  } else if (byte0 === 0x36) {
    value = data.readDoubleLE(1); remaining = data.subarray(9);
  } else if ((byte0 & 0xf0) === 0x30) {
    const numBytes = 1 << (byte0 & 0xf);
    value = readUIntLE(data, 1, numBytes);
    remaining = data.subarray(1 + numBytes);
  } else if (byte0 >= 0x40 && byte0 <= 0x60) {
    const length = byte0 - 0x40;
    value = data.subarray(1, 1 + length).toString('utf-8');
    remaining = data.subarray(1 + length);
  } else if (byte0 > 0x60 && byte0 <= 0x64) {
    const numBytes = byte0 & 0xf;
    const length = readUIntLE(data, 1, numBytes);
    value = data.subarray(1 + numBytes, 1 + numBytes + length).toString('utf-8');
    remaining = data.subarray(1 + numBytes + length);
  } else if (byte0 >= 0x70 && byte0 <= 0x90) {
    const length = byte0 - 0x70;
    value = Buffer.from(data.subarray(1, 1 + length));
    remaining = data.subarray(1 + length);
  } else if (byte0 >= 0x91 && byte0 <= 0x94) {
    const numBytes = 1 << ((byte0 & 0xf) - 1);
    const length = readUIntLE(data, 1, numBytes);
    value = Buffer.from(data.subarray(1 + numBytes, 1 + numBytes + length));
    remaining = data.subarray(1 + numBytes + length);
  } else if ((byte0 & 0xf0) === 0xd0) {
    const count = byte0 & 0xf;
    const output: unknown[] = [];
    let ptr = data.subarray(1);
    if (count === 0xf) {
      while (ptr[0] !== 0x03) {
        const [v, rest] = _unpack(Buffer.from(ptr), objectList);
        output.push(v);
        ptr = rest;
      }
      ptr = ptr.subarray(1);
    } else {
      for (let i = 0; i < count; i++) {
        const [v, rest] = _unpack(Buffer.from(ptr), objectList);
        output.push(v);
        ptr = rest;
      }
    }
    value = output; remaining = Buffer.from(ptr); addToObjectList = false;
  } else if ((byte0 & 0xe0) === 0xe0) {
    const count = byte0 & 0xf;
    const output: Record<string, unknown> = {};
    let ptr = data.subarray(1);
    if (count === 0xf) {
      while (ptr[0] !== 0x03) {
        const [k, rest1] = _unpack(Buffer.from(ptr), objectList);
        const [v, rest2] = _unpack(Buffer.from(rest1), objectList);
        output[String(k)] = v;
        ptr = rest2;
      }
      ptr = ptr.subarray(1);
    } else {
      for (let i = 0; i < count; i++) {
        const [k, rest1] = _unpack(Buffer.from(ptr), objectList);
        const [v, rest2] = _unpack(Buffer.from(rest1), objectList);
        output[String(k)] = v;
        ptr = rest2;
      }
    }
    value = output; remaining = Buffer.from(ptr); addToObjectList = false;
  } else if (byte0 >= 0xa0 && byte0 <= 0xc0) {
    value = objectList[byte0 - 0xa0]; remaining = data.subarray(1);
    addToObjectList = false;
  } else if (byte0 >= 0xc1 && byte0 <= 0xc4) {
    const length = byte0 - 0xc0;
    const uid = readUIntLE(data, 1, length);
    value = objectList[uid];
    remaining = data.subarray(1 + length);
    addToObjectList = false;
  } else {
    throw new TypeError(`Unknown OPACK type: 0x${byte0.toString(16)}`);
  }

  if (addToObjectList && !objectList.includes(value)) {
    objectList.push(value);
  }

  return [value, remaining];
}

function readUIntLE(buf: Buffer, offset: number, numBytes: number): number {
  if (numBytes === 1) return buf[offset];
  if (numBytes === 2) return buf.readUInt16LE(offset);
  if (numBytes === 4) return buf.readUInt32LE(offset);
  if (numBytes === 8) return Number(buf.readBigUInt64LE(offset));
  throw new Error(`Unsupported integer size: ${numBytes}`);
}
