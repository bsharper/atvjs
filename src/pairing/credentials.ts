/**
 * HAP credentials storage and parsing.
 * Port of pyatv/auth/hap_pairing.py HapCredentials + parse_credentials().
 *
 * Format: "LTPK:LTSK:ATV_ID:CLIENT_ID" (all hex-encoded)
 */

export interface HapCredentials {
  /** Apple TV's Ed25519 public key */
  ltpk: Buffer;
  /** Client's Ed25519 private key */
  ltsk: Buffer;
  /** Device identifier */
  atvId: Buffer;
  /** Client identifier (UUID) */
  clientId: Buffer;
}

export interface Credentials {
  airplay: string;
  companion: string;
}

export function serializeCredentials(creds: HapCredentials): string {
  return [
    creds.ltpk.toString('hex'),
    creds.ltsk.toString('hex'),
    creds.atvId.toString('hex'),
    creds.clientId.toString('hex'),
  ].join(':');
}

export function parseCredentials(credString: string): HapCredentials {
  const parts = credString.split(':');
  if (parts.length === 4) {
    return {
      ltpk: Buffer.from(parts[0], 'hex'),
      ltsk: Buffer.from(parts[1], 'hex'),
      atvId: Buffer.from(parts[2], 'hex'),
      clientId: Buffer.from(parts[3], 'hex'),
    };
  }
  throw new Error(`Invalid credentials format: expected 4 hex parts separated by ':'`);
}
