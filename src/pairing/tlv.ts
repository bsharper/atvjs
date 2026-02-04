/**
 * TLV8 encoding/decoding for HAP (HomeKit Accessory Protocol).
 * Direct port of pyatv/auth/hap_tlv8.py.
 */

export enum TlvValue {
  Method = 0x00,
  Identifier = 0x01,
  Salt = 0x02,
  PublicKey = 0x03,
  Proof = 0x04,
  EncryptedData = 0x05,
  SeqNo = 0x06,
  Error = 0x07,
  BackOff = 0x08,
  Certificate = 0x09,
  Signature = 0x0a,
  Permissions = 0x0b,
  FragmentData = 0x0c,
  FragmentLast = 0x0d,
  Name = 0x11,
  Flags = 0x13,
}

export type TlvData = Map<number, Buffer>;

export function readTlv(data: Buffer): TlvData {
  const result = new Map<number, Buffer>();
  let pos = 0;
  while (pos < data.length) {
    const tag = data[pos];
    const length = data[pos + 1];
    const value = data.subarray(pos + 2, pos + 2 + length);
    if (result.has(tag)) {
      result.set(tag, Buffer.concat([result.get(tag)!, value]));
    } else {
      result.set(tag, Buffer.from(value));
    }
    pos += 2 + length;
  }
  return result;
}

export function writeTlv(data: Map<number, Buffer> | Record<number, Buffer>): Buffer {
  const entries = data instanceof Map ? Array.from(data.entries()) : Object.entries(data).map(([k, v]) => [Number(k), v] as [number, Buffer]);
  const parts: Buffer[] = [];
  for (const [key, value] of entries) {
    const tag = Buffer.from([key]);
    let pos = 0;
    let remaining = value.length;
    while (pos < value.length || remaining === 0) {
      const size = Math.min(remaining, 255);
      parts.push(tag);
      parts.push(Buffer.from([size]));
      if (size > 0) {
        parts.push(value.subarray(pos, pos + size));
      }
      pos += size;
      remaining -= size;
      if (remaining === 0 && pos >= value.length) break;
    }
  }
  return Buffer.concat(parts);
}
