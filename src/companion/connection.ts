/**
 * Companion protocol TCP connection with frame-based protocol.
 * Port of pyatv/protocols/companion/connection.py.
 *
 * Frame format: [1-byte FrameType][3-byte big-endian payload length][payload]
 * When encrypted, payload includes 16-byte auth tag in the length field.
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import { Chacha20Cipher, AUTH_TAG_LENGTH } from '../crypto/chacha20';
import * as opack from '../opack';

export enum FrameType {
  Unknown = 0,
  NoOp = 1,
  PS_Start = 3,
  PS_Next = 4,
  PV_Start = 5,
  PV_Next = 6,
  U_OPACK = 7,
  E_OPACK = 8,
  P_OPACK = 9,
  PA_Req = 10,
  PA_Rsp = 11,
  SessionStartRequest = 16,
  SessionStartResponse = 17,
  SessionData = 18,
  FamilyIdentityRequest = 32,
  FamilyIdentityResponse = 33,
  FamilyIdentityUpdate = 34,
}

const HEADER_LENGTH = 4;

export interface FrameListener {
  frameReceived(frameType: FrameType, payload: Buffer): void;
  connectionLost(error?: Error): void;
}

export class CompanionConnection {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private chacha: Chacha20Cipher | null = null;
  private listener: FrameListener;
  private host: string;
  private port: number;
  private connected = false;

  constructor(host: string, port: number, listener?: FrameListener) {
    this.host = host;
    this.port = port;
    this.listener = listener || { frameReceived: () => {}, connectionLost: () => {} };
  }

  setListener(listener: FrameListener): void {
    this.listener = listener;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.connected = true;
        if (this.socket && typeof this.socket.unref === 'function') this.socket.unref();
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, data]);
        this.processBuffer();
      });

      this.socket.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          this.listener.connectionLost(err);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.listener.connectionLost();
      });
    });
  }

  private processBuffer(): void {
    while (this.buffer.length >= HEADER_LENGTH) {
      const payloadLength = HEADER_LENGTH + (
        (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3]
      );

      if (this.buffer.length < payloadLength) break;

      const header = this.buffer.subarray(0, HEADER_LENGTH);
      let payload: Buffer = Buffer.from(this.buffer.subarray(HEADER_LENGTH, payloadLength)) as Buffer;
      this.buffer = this.buffer.subarray(payloadLength);

      if (this.chacha && payload.length > 0) {
        try {
          payload = this.chacha.decrypt(payload, undefined, header);
        } catch (err) {
          // Decryption failed, skip this frame
          continue;
        }
      }

      this.listener.frameReceived(header[0] as FrameType, payload);
    }
  }

  send(frameType: FrameType, data: Buffer): void {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected');
    }

    let payloadLength = data.length;
    if (this.chacha && payloadLength > 0) {
      payloadLength += AUTH_TAG_LENGTH;
    }

    const header = Buffer.alloc(HEADER_LENGTH);
    header[0] = frameType;
    header[1] = (payloadLength >> 16) & 0xff;
    header[2] = (payloadLength >> 8) & 0xff;
    header[3] = payloadLength & 0xff;

    let payload = data;
    if (this.chacha && data.length > 0) {
      payload = this.chacha.encrypt(data, undefined, header);
    }

    this.socket.write(Buffer.concat([header, payload]));
  }

  enableEncryption(outputKey: Buffer, inputKey: Buffer): void {
    this.chacha = new Chacha20Cipher(outputKey, inputKey, 12);
  }

  close(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  getHost(): string {
    return this.host;
  }

  getPort(): number {
    return this.port;
  }
}
