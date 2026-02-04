/**
 * Companion protocol message dispatch layer.
 * Port of pyatv/protocols/companion/protocol.py.
 *
 * Messages are OPACK-encoded with structure:
 *   { _i: identifier, _t: messageType, _c: content, _x: transactionId }
 */

import { EventEmitter } from 'events';
import { CompanionConnection, FrameType, FrameListener } from './connection';
import * as opack from '../opack';
import { SRPAuthHandler } from '../pairing/srp';
import { HapCredentials, parseCredentials } from '../pairing/credentials';
import { CompanionPairVerifyProcedure, SRP_SALT, SRP_OUTPUT_INFO, SRP_INPUT_INFO } from './auth';

export enum MessageType {
  Event = 1,
  Request = 2,
  Response = 3,
}

const DEFAULT_TIMEOUT = 5000;

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CompanionEventListener {
  (data: Record<string, unknown>): void;
}

export class CompanionProtocol implements FrameListener {
  connection: CompanionConnection;
  private xid = Math.floor(Math.random() * 0x10000); // Random starting xid like pyatv
  private pendingRequests = new Map<number, PendingRequest>();
  private pendingAuth = new Map<number, PendingRequest>(); // keyed by frame type
  private eventListeners = new Map<string, CompanionEventListener[]>();
  private events = new EventEmitter();
  private srp: SRPAuthHandler;
  private credentialString: string | null;
  private _onConnectionLost?: (error?: Error) => void;

  constructor(connection: CompanionConnection, credentialString: string | null) {
    this.connection = connection;
    this.srp = new SRPAuthHandler();
    this.credentialString = credentialString;
  }

  set onConnectionLost(handler: (error?: Error) => void) {
    this._onConnectionLost = handler;
  }

  // ---- FrameListener interface ----

  frameReceived(frameType: FrameType, payload: Buffer): void {
    // Auth frames (PS_*, PV_*)
    if (frameType >= FrameType.PS_Start && frameType <= FrameType.PV_Next) {
      this.handleAuthFrame(frameType, payload);
      return;
    }

    // OPACK frames
    if (frameType === FrameType.E_OPACK || frameType === FrameType.U_OPACK || frameType === FrameType.P_OPACK) {
      if (payload.length === 0) return;
      const { value } = opack.unpack(payload);
      this.handleOpack(frameType, value as Record<string, unknown>);
    }
  }

  connectionLost(error?: Error): void {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection lost'));
    }
    this.pendingRequests.clear();

    for (const [, pending] of this.pendingAuth) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection lost'));
    }
    this.pendingAuth.clear();

    if (this._onConnectionLost) this._onConnectionLost(error);
  }

  // ---- Auth frame handling ----

  private handleAuthFrame(frameType: FrameType, payload: Buffer): void {
    if (payload.length === 0) return;
    const { value } = opack.unpack(payload);
    const data = value as Record<string, unknown>;

    // Auth responses come as the next frame type after the request
    // PV_Start(5) → response comes as PV_Next(6), PS_Start(3) → PS_Next(4)
    const pending = this.pendingAuth.get(frameType);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAuth.delete(frameType);
      pending.resolve(data);
    }
  }

  /**
   * Exchange an auth frame and wait for the response.
   */
  async exchangeAuth(
    frameType: FrameType,
    data: Record<string, unknown>,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<Record<string, unknown>> {
    // Response frame type: for PS_Start(3)→PS_Next(4), PV_Start(5)→PV_Next(6)
    // For PS_Next(4)→PS_Next(4), PV_Next(6)→PV_Next(6)
    let responseType: FrameType;
    if (frameType === FrameType.PS_Start) {
      responseType = FrameType.PS_Next;
    } else if (frameType === FrameType.PV_Start) {
      responseType = FrameType.PV_Next;
    } else {
      responseType = frameType; // PS_Next → PS_Next, PV_Next → PV_Next
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAuth.delete(responseType);
        reject(new Error(`Auth exchange timeout for frame type ${frameType}`));
      }, timeout);

      this.pendingAuth.set(responseType, { resolve, reject, timer });
      this.connection.send(frameType, opack.pack(data));
    });
  }

  // ---- OPACK message handling ----

  private handleOpack(frameType: FrameType, data: Record<string, unknown>): void {
    const messageType = data._t as number;

    if (messageType === MessageType.Event) {
      const eventName = data._i as string;
      const content = (data._c || {}) as Record<string, unknown>;
      const listeners = this.eventListeners.get(eventName);
      if (listeners) {
        for (const listener of listeners) {
          try { listener(content); } catch {}
        }
      }
      this.events.emit(eventName, content);
    } else if (messageType === MessageType.Response) {
      const xid = data._x as number;
      const pending = this.pendingRequests.get(xid);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(xid);
        pending.resolve(data);
      }
    }
  }

  /**
   * Send an OPACK request and wait for the response.
   */
  async exchangeOpack(
    data: Record<string, unknown>,
    frameType: FrameType = FrameType.E_OPACK,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<Record<string, unknown>> {
    const xid = this.xid++;
    data._x = xid;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(xid);
        reject(new Error(`OPACK exchange timeout for xid ${xid}`));
      }, timeout);

      this.pendingRequests.set(xid, { resolve, reject, timer });
      this.connection.send(frameType, opack.pack(data));
    });
  }

  /**
   * Send an OPACK event (no response expected).
   */
  sendEvent(identifier: string, content: Record<string, unknown>): void {
    const data: Record<string, unknown> = {
      _i: identifier,
      _t: MessageType.Event,
      _c: content,
      _x: this.xid++,
    };
    this.connection.send(FrameType.E_OPACK, opack.pack(data));
  }

  /**
   * Send an OPACK request with standard message structure.
   */
  async sendCommand(
    identifier: string,
    content: Record<string, unknown> = {},
    timeout = DEFAULT_TIMEOUT,
  ): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {
      _i: identifier,
      _t: MessageType.Request,
      _c: content,
    };
    return this.exchangeOpack(data, FrameType.E_OPACK, timeout);
  }

  /**
   * Register a listener for a specific event name.
   */
  listenTo(eventName: string, listener: CompanionEventListener): void {
    const existing = this.eventListeners.get(eventName) || [];
    existing.push(listener);
    this.eventListeners.set(eventName, existing);
  }

  /**
   * Subscribe to device events.
   */
  async subscribeEvent(eventName: string): Promise<void> {
    this.sendEvent('_interest', { _regEvents: [eventName] });
  }

  // ---- Connection lifecycle ----

  /**
   * Start the protocol: connect, verify credentials if available, enable encryption.
   */
  async start(): Promise<void> {
    await this.connection.connect();

    if (this.credentialString) {
      const credentials = parseCredentials(this.credentialString);
      await this.setupEncryption(credentials);
    }
  }

  private async setupEncryption(credentials: HapCredentials): Promise<void> {
    const verifier = new CompanionPairVerifyProcedure(this, this.srp, credentials);
    await verifier.verifyCredentials();
    const [outputKey, inputKey] = verifier.encryptionKeys();
    this.connection.enableEncryption(outputKey, inputKey);
  }

  close(): void {
    this.connection.close();
  }
}
