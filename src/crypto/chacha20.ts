/**
 * ChaCha20-Poly1305 AEAD encryption with counter-based nonces.
 * Uses @noble/ciphers for pure JS implementation (works in Electron).
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export { AUTH_TAG_LENGTH };

export class Chacha20Cipher {
  private outKey: Buffer;
  private inKey: Buffer;
  private outCounter = 0;
  private inCounter = 0;
  private nonceLength: number;

  constructor(outKey: Buffer, inKey: Buffer, nonceLength = 12) {
    this.outKey = outKey;
    this.inKey = inKey;
    this.nonceLength = nonceLength;
  }

  private padNonce(nonce: Buffer): Buffer {
    if (nonce.length >= NONCE_LENGTH) return nonce;
    const padded = Buffer.alloc(NONCE_LENGTH);
    nonce.copy(padded, NONCE_LENGTH - nonce.length);
    return padded;
  }

  private getOutNonce(): Buffer {
    const nonce = Buffer.alloc(this.nonceLength);
    writeLECounter(nonce, this.outCounter, this.nonceLength);
    return this.nonceLength !== NONCE_LENGTH ? this.padNonce(nonce) : nonce;
  }

  private getInNonce(): Buffer {
    const nonce = Buffer.alloc(this.nonceLength);
    writeLECounter(nonce, this.inCounter, this.nonceLength);
    return this.nonceLength !== NONCE_LENGTH ? this.padNonce(nonce) : nonce;
  }

  encrypt(data: Buffer, nonce?: Buffer, aad?: Buffer): Buffer {
    let useNonce: Buffer;
    if (nonce === undefined) {
      useNonce = this.getOutNonce();
      this.outCounter++;
    } else {
      useNonce = nonce.length < NONCE_LENGTH ? this.padNonce(nonce) : nonce;
    }

    // Use @noble/ciphers chacha20-poly1305 (pure JS, works in Electron)
    const cipher = chacha20poly1305(this.outKey, useNonce, aad);
    const encrypted = cipher.encrypt(data);
    return Buffer.from(encrypted);
  }

  decrypt(data: Buffer, nonce?: Buffer, aad?: Buffer): Buffer {
    let useNonce: Buffer;
    if (nonce === undefined) {
      useNonce = this.getInNonce();
      this.inCounter++;
    } else {
      useNonce = nonce.length < NONCE_LENGTH ? this.padNonce(nonce) : nonce;
    }

    // Use @noble/ciphers chacha20-poly1305 (pure JS, works in Electron)
    const decipher = chacha20poly1305(this.inKey, useNonce, aad);
    const decrypted = decipher.decrypt(data);
    return Buffer.from(decrypted);
  }
}

/**
 * 8-byte counter variant: nonce = [4 zero bytes][8-byte LE counter].
 * Used for pairing steps with explicit nonces like "PS-Msg05", "PV-Msg02".
 */
export class Chacha20Cipher8byteNonce extends Chacha20Cipher {
  constructor(outKey: Buffer, inKey: Buffer) {
    super(outKey, inKey, 8);
  }
}

function writeLECounter(buf: Buffer, counter: number, length: number): void {
  // Use BigInt to avoid JavaScript's 32-bit limit on bit operations
  let c = BigInt(counter);
  for (let i = 0; i < length && i < 8; i++) {
    buf[i] = Number(c & 0xffn);
    c >>= 8n;
  }
}
