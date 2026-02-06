/**
 * atv-js: Apple TV control library.
 * mDNS discovery, AirPlay/Companion pairing, remote control, keyboard input.
 */

export { AppleTVDevice, scan } from './mdns';
export { HapCredentials, Credentials, parseCredentials, serializeCredentials } from './pairing/credentials';
export { RemoteKey, HidCommand, MediaControlCommand } from './companion/remote';
export { KeyboardFocusState } from './companion/keyboard';

import { AppleTVDevice, scan as scanDevices } from './mdns';
import { CompanionConnection } from './companion/connection';
import { CompanionProtocol } from './companion/protocol';
import { CompanionPairSetupProcedure } from './companion/auth';
import {
  getCompanionPairingConnection,
  releaseCompanionPairingConnection,
} from './companion/pairing_keepalive';
import { SRPAuthHandler } from './pairing/srp';
import { HapCredentials, Credentials, serializeCredentials, parseCredentials } from './pairing/credentials';
import {
  AirPlayPairingSession,
  startAirPlayPairing as _startAirPlayPairing,
  finishAirPlayPairing as _finishAirPlayPairing,
} from './airplay/auth';
import { sendKeyPress, sendKeyDown, sendKeyUp, RemoteKey } from './companion/remote';
import {
  getText as _getText,
  setText as _setText,
  getKeyboardFocus as _getKeyboardFocus,
  watchKeyboardFocus as _watchKeyboardFocus,
  KeyboardFocusState,
} from './companion/keyboard';
import { FrameType } from './companion/connection';
import { opackFloat } from './opack';

// ---- Pairing Sessions ----

export interface PairingSession {
  /** @internal */
  _type: 'airplay' | 'companion';
  /** @internal */
  _airplay?: AirPlayPairingSession;
  /** @internal */
  _companionProtocol?: CompanionProtocol;
  /** @internal */
  _companionProcedure?: CompanionPairSetupProcedure;
}

/**
 * Start AirPlay pairing with a discovered device.
 * This triggers the PIN display on the Apple TV.
 */
export async function startAirPlayPairing(device: AppleTVDevice): Promise<PairingSession> {
  const session = await _startAirPlayPairing(device.address, device.airplayPort);
  return { _type: 'airplay', _airplay: session };
}

/**
 * Finish AirPlay pairing with the PIN shown on screen.
 */
export async function finishAirPlayPairing(
  session: PairingSession,
  pin: string,
  displayName?: string,
): Promise<HapCredentials> {
  if (session._type !== 'airplay' || !session._airplay) {
    throw new Error('Not an AirPlay pairing session');
  }
  return _finishAirPlayPairing(session._airplay, pin, displayName);
}

/**
 * Start Companion protocol pairing with a discovered device.
 * This triggers a second PIN display on the Apple TV.
 */
export async function startCompanionPairing(device: AppleTVDevice): Promise<PairingSession> {
  const connection = getCompanionPairingConnection(device.address, device.port);
  const protocol = new CompanionProtocol(connection, null);
  connection.setListener(protocol);
  const srp = new SRPAuthHandler();
  const procedure = new CompanionPairSetupProcedure(protocol, srp);

  // Start pairing (connects + sends PS_Start)
  await procedure.startPairing();

  return {
    _type: 'companion',
    _companionProtocol: protocol,
    _companionProcedure: procedure,
  };
}

/**
 * Finish Companion pairing with the PIN shown on screen.
 */
export async function finishCompanionPairing(
  session: PairingSession,
  pin: string,
  displayName?: string,
): Promise<HapCredentials> {
  if (session._type !== 'companion' || !session._companionProcedure) {
    throw new Error('Not a Companion pairing session');
  }
  const creds = await session._companionProcedure.finishPairing(pin.trim(), displayName);

  // Release the pairing connection back to the keep-alive cache
  if (session._companionProtocol) {
    releaseCompanionPairingConnection(session._companionProtocol.connection);
  }

  return creds;
}

// ---- Connection ----

export interface AppleTVConnection {
  protocol: CompanionProtocol;
  device: AppleTVDevice;
  credentials: Credentials;
  /** @internal */
  _keyboardFocusState: KeyboardFocusState;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function matchesDevice(target: AppleTVDevice, candidate: AppleTVDevice): boolean {
  if (target.identifier && candidate.identifier === target.identifier) return true;
  if (candidate.address === target.address) return true;
  return candidate.name === target.name;
}

function mergeDiscoveredDevice(target: AppleTVDevice, discovered: AppleTVDevice): AppleTVDevice {
  return {
    ...target,
    ...discovered,
    properties: { ...target.properties, ...discovered.properties },
  };
}

async function connectCompanion(
  device: AppleTVDevice,
  companionCredentials: string,
): Promise<CompanionProtocol> {
  const connection = new CompanionConnection(device.address, device.port);
  const protocol = new CompanionProtocol(connection, companionCredentials);
  connection.setListener(protocol);
  await protocol.start();
  return protocol;
}

async function discoverLatestDevice(device: AppleTVDevice): Promise<AppleTVDevice | null> {
  const discovered = await scanDevices(3000, false);
  return discovered.find((candidate) => matchesDevice(device, candidate)) || null;
}

/**
 * Connect to an Apple TV using stored credentials.
 * Performs pair-verify and sets up encrypted Companion channel.
 */
export async function connect(
  device: AppleTVDevice,
  credentials: Credentials,
): Promise<AppleTVConnection> {
  let activeDevice = device;
  let protocol: CompanionProtocol;

  try {
    protocol = await connectCompanion(activeDevice, credentials.companion);
  } catch (initialError) {
    let discovered: AppleTVDevice | null = null;
    try {
      discovered = await discoverLatestDevice(activeDevice);
    } catch {
      discovered = null;
    }

    if (!discovered || discovered.port === activeDevice.port) {
      throw initialError;
    }

    activeDevice = mergeDiscoveredDevice(activeDevice, discovered);

    try {
      protocol = await connectCompanion(activeDevice, credentials.companion);
    } catch (retryError) {
      throw new Error(
        `Companion connection failed on saved port ${device.port} and discovered port ${activeDevice.port}: ${errorMessage(retryError)}`,
        { cause: initialError instanceof Error ? initialError : undefined },
      );
    }
  }

  // Post-connection initialization (order matters!)
  // 1. Send system info
  // Client ID is stored hex-encoded in credentials, decode to get the actual UUID bytes
  const clientIdHex = credentials.companion.split(':')[3] || '';
  const clientIdBytes = Buffer.from(clientIdHex, 'hex');  // UUID as bytes
  await protocol.sendCommand('_systemInfo', {
    _bf: 0,
    _cf: 512,
    _clFl: 128,
    _i: null,
    _idsID: clientIdBytes,
    _pubID: 'FF:70:79:61:74:76',
    _sf: 256,
    _sv: '170.18',
    model: 'iPhone10,6',
    name: 'atv-js',
  });

  // 2. Start touch input (must be before _sessionStart)
  await protocol.sendCommand('_touchStart', {
    _height: opackFloat(1000.0),
    _tFl: 0,
    _width: opackFloat(1000.0),
  });

  // 3. Start a session
  const sessionId = Math.floor(Math.random() * 0xFFFFFFFF);
  await protocol.sendCommand('_sessionStart', {
    _srvT: 'com.apple.tvremoteservices',
    _sid: sessionId,
  });

  // 4. Start text input session
  await protocol.sendCommand('_tiStart', {});

  // 5. Subscribe to media control events
  protocol.subscribeEvent('_iMC');

  const conn: AppleTVConnection = {
    protocol,
    device: activeDevice,
    credentials,
    _keyboardFocusState: KeyboardFocusState.Unknown,
  };

  // Watch keyboard focus state
  _watchKeyboardFocus(protocol, (state) => {
    conn._keyboardFocusState = state;
  });

  return conn;
}

// ---- Remote Control ----

/**
 * Send a remote control key press (button down + up).
 */
export async function sendKey(conn: AppleTVConnection, key: RemoteKey | string): Promise<void> {
  return sendKeyPress(conn.protocol, key);
}

export { sendKeyDown, sendKeyUp };

// ---- Keyboard ----

/**
 * Check if keyboard is currently focused.
 */
export async function getKeyboardFocusState(conn: AppleTVConnection): Promise<boolean> {
  return _getKeyboardFocus(conn.protocol);
}

/**
 * Get the current text from a focused keyboard field.
 */
export async function getText(conn: AppleTVConnection): Promise<string | null> {
  return _getText(conn.protocol);
}

/**
 * Set (replace) the text in a focused keyboard field.
 */
export async function setText(conn: AppleTVConnection, text: string): Promise<void> {
  return _setText(conn.protocol, text);
}

// ---- Connection Management ----

/**
 * Set a handler for connection loss events.
 */
export function onConnectionLost(conn: AppleTVConnection, handler: (error?: Error) => void): void {
  conn.protocol.onConnectionLost = handler;
}

/**
 * Disconnect from the Apple TV.
 */
export function disconnect(conn: AppleTVConnection): void {
  conn.protocol.close();
}

/**
 * Check if still connected to the Apple TV.
 */
export function isConnected(conn: AppleTVConnection): boolean {
  return conn.protocol.connection.isConnected;
}
