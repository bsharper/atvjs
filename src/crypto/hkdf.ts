/**
 * HKDF-SHA512 key derivation.
 * Port of pyatv/auth/hap_srp.py hkdf_expand().
 */

import * as crypto from 'crypto';

export function hkdfExpand(salt: string, info: string, sharedSecret: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha512',
      sharedSecret,
      Buffer.from(salt, 'utf-8'),
      Buffer.from(info, 'utf-8'),
      32
    )
  );
}
