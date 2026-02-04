/**
 * Companion protocol pair-setup and pair-verify procedures.
 * Port of pyatv/protocols/companion/auth.py.
 */

import { SRPAuthHandler } from '../pairing/srp';
import { HapCredentials } from '../pairing/credentials';
import { TlvValue, readTlv, writeTlv } from '../pairing/tlv';
import { CompanionProtocol } from './protocol';
import { FrameType } from './connection';

const PAIRING_DATA_KEY = '_pd';

// Companion encryption key derivation constants
export const SRP_SALT = '';
export const SRP_OUTPUT_INFO = 'ClientEncrypt-main';
export const SRP_INPUT_INFO = 'ServerEncrypt-main';

function getPairingData(message: Record<string, unknown>): Map<number, Buffer> {
  const pd = message[PAIRING_DATA_KEY];
  if (!pd || !Buffer.isBuffer(pd)) {
    throw new Error('No pairing data in message or unexpected type');
  }
  const tlv = readTlv(pd);
  if (tlv.has(TlvValue.Error)) {
    throw new Error(`Pairing error: ${tlv.get(TlvValue.Error)!.toString('hex')}`);
  }
  return tlv;
}

/**
 * Perform Companion pair-setup (initial pairing that requires PIN).
 */
export class CompanionPairSetupProcedure {
  private protocol: CompanionProtocol;
  private srp: SRPAuthHandler;
  private atvSalt: Buffer | null = null;
  private atvPubKey: Buffer | null = null;

  constructor(protocol: CompanionProtocol, srp: SRPAuthHandler) {
    this.protocol = protocol;
    this.srp = srp;
  }

  async startPairing(): Promise<void> {
    this.srp.initialize();
    await this.protocol.start();

    const resp = await this.protocol.exchangeAuth(FrameType.PS_Start, {
      [PAIRING_DATA_KEY]: writeTlv(new Map<number, Buffer>([
        [TlvValue.Method, Buffer.from([0x00])],
        [TlvValue.SeqNo, Buffer.from([0x01])],
      ])),
      _pwTy: 1,
    });

    const pairingData = getPairingData(resp);
    this.atvSalt = pairingData.get(TlvValue.Salt)!;
    this.atvPubKey = pairingData.get(TlvValue.PublicKey)!;
  }

  async finishPairing(pin: string, displayName?: string): Promise<HapCredentials> {
    this.srp.step1(pin);

    const [pubKey, proof] = this.srp.step2(this.atvPubKey!, this.atvSalt!);

    // SeqNo 3: send proof
    const resp3 = await this.protocol.exchangeAuth(FrameType.PS_Next, {
      [PAIRING_DATA_KEY]: writeTlv(new Map<number, Buffer>([
        [TlvValue.SeqNo, Buffer.from([0x03])],
        [TlvValue.PublicKey, pubKey],
        [TlvValue.Proof, proof],
      ])),
      _pwTy: 1,
    });

    // Verify server proof is present
    getPairingData(resp3);

    // SeqNo 5: send encrypted identity
    const encrypted = this.srp.step3(displayName);
    const resp5 = await this.protocol.exchangeAuth(FrameType.PS_Next, {
      [PAIRING_DATA_KEY]: writeTlv(new Map<number, Buffer>([
        [TlvValue.SeqNo, Buffer.from([0x05])],
        [TlvValue.EncryptedData, encrypted],
      ])),
      _pwTy: 1,
    });

    const pairingData5 = getPairingData(resp5);
    const encryptedData = pairingData5.get(TlvValue.EncryptedData)!;

    return this.srp.step4(encryptedData);
  }
}

/**
 * Verify Companion credentials and derive encryption keys.
 */
export class CompanionPairVerifyProcedure {
  private protocol: CompanionProtocol;
  private srp: SRPAuthHandler;
  private credentials: HapCredentials;

  constructor(protocol: CompanionProtocol, srp: SRPAuthHandler, credentials: HapCredentials) {
    this.protocol = protocol;
    this.srp = srp;
    this.credentials = credentials;
  }

  async verifyCredentials(): Promise<boolean> {
    const [, publicKey] = this.srp.initialize();

    const resp = await this.protocol.exchangeAuth(FrameType.PV_Start, {
      [PAIRING_DATA_KEY]: writeTlv(new Map<number, Buffer>([
        [TlvValue.SeqNo, Buffer.from([0x01])],
        [TlvValue.PublicKey, publicKey],
      ])),
      _auTy: 4,
    });

    const pairingData = getPairingData(resp);
    const serverPubKey = pairingData.get(TlvValue.PublicKey)!;
    const encrypted = pairingData.get(TlvValue.EncryptedData)!;

    const encryptedData = this.srp.verify1(this.credentials, serverPubKey, encrypted);

    await this.protocol.exchangeAuth(FrameType.PV_Next, {
      [PAIRING_DATA_KEY]: writeTlv(new Map<number, Buffer>([
        [TlvValue.SeqNo, Buffer.from([0x03])],
        [TlvValue.EncryptedData, encryptedData],
      ])),
    });

    return true;
  }

  encryptionKeys(): [Buffer, Buffer] {
    return this.srp.verify2(SRP_SALT, SRP_OUTPUT_INFO, SRP_INPUT_INFO);
  }
}
