/**
 * SRP authentication handler for HAP pair-setup and pair-verify.
 * Port of pyatv/auth/hap_srp.py SRPAuthHandler.
 *
 * Uses fast-srp-hap for SRP 3072-bit with SHA-512,
 * and Node.js crypto for Ed25519 and X25519.
 */

import * as crypto from 'crypto';
import { SRP, SrpClient } from 'fast-srp-hap';
import { Chacha20Cipher8byteNonce } from '../crypto/chacha20';
import { hkdfExpand } from '../crypto/hkdf';
import { HapCredentials } from './credentials';
import { TlvValue, readTlv, writeTlv } from './tlv';
import { pack as opackPack } from '../opack';

// Ed25519 DER prefixes for raw key import/export
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export class SRPAuthHandler {
  pairingId: Buffer;
  private signingKey: crypto.KeyObject | null = null;
  private authPrivate: Buffer | null = null;
  private authPublic: Buffer | null = null;
  private verifyPrivate: crypto.KeyObject | null = null;
  private verifyPublic: Buffer | null = null;
  private srpClient: SrpClient | null = null;
  private shared: Buffer | null = null;
  private sessionKey: Buffer | null = null;
  private pin: number = 0;
  private clientSecret: Buffer | null = null;

  constructor() {
    this.pairingId = Buffer.from(crypto.randomUUID(), 'utf-8');
  }

  /**
   * Initialize by generating new Ed25519 signing keys and X25519 verify keys.
   * Returns [authPublic, verifyPublic].
   */
  initialize(): [Buffer, Buffer] {
    // Generate raw 32-byte seeds first, like pyatv does
    // pyatv: self._signing_key = Ed25519PrivateKey.from_private_bytes(os.urandom(32))
    const authSeed = crypto.randomBytes(32);
    const verifySeed = crypto.randomBytes(32);

    // Create Ed25519 signing key from seed
    // pyatv exports with Encoding.Raw, Format.Raw which gives the 32-byte seed
    this.signingKey = crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, authSeed]),
      format: 'der',
      type: 'pkcs8',
    });
    this.authPrivate = authSeed;
    this.authPublic = crypto.createPublicKey(this.signingKey)
      .export({ type: 'spki', format: 'der' }).subarray(-32);

    // X25519 verify key
    this.verifyPrivate = crypto.createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, verifySeed]),
      format: 'der',
      type: 'pkcs8',
    });
    this.verifyPublic = crypto.createPublicKey(this.verifyPrivate)
      .export({ type: 'spki', format: 'der' }).subarray(-32);

    // Use the raw seed as SRP client secret (matches pyatv behavior)
    // pyatv uses binascii.hexlify(self._auth_private) as the SRP exponent 'a'
    this.clientSecret = this.authPrivate;

    return [this.authPublic, this.verifyPublic];
  }

  // ---- Pair-Verify ----

  /**
   * Pair-Verify step 1: X25519 shared secret + decrypt server identity + sign our identity.
   */
  verify1(credentials: HapCredentials, sessionPubKey: Buffer, encrypted: Buffer): Buffer {
    const serverKey = crypto.createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, sessionPubKey]),
      format: 'der',
      type: 'spki',
    });
    this.shared = crypto.diffieHellman({
      privateKey: this.verifyPrivate!,
      publicKey: serverKey,
    });

    const verifyKey = hkdfExpand('Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', this.shared);

    const chacha = new Chacha20Cipher8byteNonce(verifyKey, verifyKey);
    const decryptedBytes = chacha.decrypt(encrypted, Buffer.from('PV-Msg02', 'utf-8'));
    const decryptedTlv = readTlv(decryptedBytes);

    const identifier = decryptedTlv.get(TlvValue.Identifier)!;
    const signature = decryptedTlv.get(TlvValue.Signature)!;

    if (!identifier.equals(credentials.atvId)) {
      throw new Error('Incorrect device response: identifier mismatch');
    }

    // Verify server Ed25519 signature
    const info = Buffer.concat([sessionPubKey, identifier, this.verifyPublic!]);
    const ltpk = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, credentials.ltpk]),
      format: 'der',
      type: 'spki',
    });
    if (!crypto.verify(null, info, ltpk, signature)) {
      throw new Error('Signature verification failed');
    }

    // Sign our identity
    const deviceInfo = Buffer.concat([this.verifyPublic!, credentials.clientId, sessionPubKey]);
    const ltsk = crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, credentials.ltsk]),
      format: 'der',
      type: 'pkcs8',
    });
    const deviceSignature = crypto.sign(null, deviceInfo, ltsk);

    const tlv = writeTlv(new Map([
      [TlvValue.Identifier, credentials.clientId],
      [TlvValue.Signature, deviceSignature],
    ]));

    return chacha.encrypt(tlv, Buffer.from('PV-Msg03', 'utf-8'));
  }

  /**
   * Pair-Verify step 2: derive final encryption keys.
   */
  verify2(salt: string, outputInfo: string, inputInfo: string): [Buffer, Buffer] {
    if (!this.shared) throw new Error('Must call verify1 first');
    const outputKey = hkdfExpand(salt, outputInfo, this.shared);
    const inputKey = hkdfExpand(salt, inputInfo, this.shared);
    return [outputKey, inputKey];
  }

  // ---- Pair-Setup ----

  /**
   * Pair-Setup step 1: store PIN for later use with salt.
   */
  step1(pin: number): void {
    this.pin = pin;
  }

  /**
   * Pair-Setup step 2: process server's public key and salt, compute SRP proof.
   * Returns [clientPublicKey, clientProof].
   */
  step2(atvPubKey: Buffer, atvSalt: Buffer): [Buffer, Buffer] {
    // HAP uses 3072-bit SRP with SHA-512 - use the 'hap' preset
    const params = SRP.params.hap;

    this.srpClient = new SrpClient(
      params,
      atvSalt,
      Buffer.from('Pair-Setup', 'utf-8'),
      Buffer.from(String(this.pin), 'utf-8'),
      this.clientSecret!,
    );
    this.srpClient.setB(atvPubKey);

    const pubKey = this.srpClient.computeA();
    const proof = this.srpClient.computeM1();

    return [pubKey, proof];
  }

  /**
   * Pair-Setup step 3: sign identity and encrypt with session key.
   * Returns encrypted data to send as SeqNo 0x05.
   */
  step3(name?: string): Buffer {
    const srpKey = this.srpClient!.computeK();

    const iosDeviceX = hkdfExpand(
      'Pair-Setup-Controller-Sign-Salt',
      'Pair-Setup-Controller-Sign-Info',
      srpKey,
    );

    this.sessionKey = hkdfExpand(
      'Pair-Setup-Encrypt-Salt',
      'Pair-Setup-Encrypt-Info',
      srpKey,
    );

    const deviceInfo = Buffer.concat([iosDeviceX, this.pairingId, this.authPublic!]);
    const deviceSignature = crypto.sign(null, deviceInfo, this.signingKey!);

    const tlvData = new Map<number, Buffer>([
      [TlvValue.Identifier, this.pairingId],
      [TlvValue.PublicKey, this.authPublic!],
      [TlvValue.Signature, deviceSignature],
    ]);

    if (name) {
      tlvData.set(TlvValue.Name, opackPack({ name }));
    }

    const chacha = new Chacha20Cipher8byteNonce(this.sessionKey, this.sessionKey);
    return chacha.encrypt(writeTlv(tlvData), Buffer.from('PS-Msg05', 'utf-8'));
  }

  /**
   * Pair-Setup step 4: decrypt device response and extract credentials.
   */
  step4(encryptedData: Buffer): HapCredentials {
    const chacha = new Chacha20Cipher8byteNonce(this.sessionKey!, this.sessionKey!);
    const decrypted = chacha.decrypt(encryptedData, Buffer.from('PS-Msg06', 'utf-8'));

    if (!decrypted || decrypted.length === 0) {
      throw new Error('Failed to decrypt pairing response');
    }

    const tlv = readTlv(decrypted);
    const atvIdentifier = tlv.get(TlvValue.Identifier)!;
    const atvPubKey = tlv.get(TlvValue.PublicKey)!;

    return {
      ltpk: atvPubKey,
      ltsk: this.authPrivate!,
      atvId: atvIdentifier,
      clientId: this.pairingId,
    };
  }
}
