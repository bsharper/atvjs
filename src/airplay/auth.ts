/**
 * AirPlay HTTP-based HAP pair-setup and pair-verify.
 * Port of pyatv/protocols/airplay/auth/hap.py.
 */

import * as http from 'http';
import { SRPAuthHandler } from '../pairing/srp';
import { HapCredentials } from '../pairing/credentials';
import { TlvValue, readTlv, writeTlv } from '../pairing/tlv';

const AIRPLAY_HEADERS: Record<string, string> = {
  'User-Agent': 'AirPlay/320.20',
  'Connection': 'keep-alive',
  'X-Apple-HKP': '3',
  'Content-Type': 'application/octet-stream',
};

async function httpPost(
  host: string,
  port: number,
  path: string,
  body?: Buffer,
  agent?: http.Agent,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...AIRPLAY_HEADERS };
    if (body) {
      headers['Content-Length'] = body.length;
    }

    const req = http.request({ hostname: host, port, path, method: 'POST', headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export interface AirPlayPairingSession {
  srp: SRPAuthHandler;
  host: string;
  port: number;
  atvSalt: Buffer;
  atvPubKey: Buffer;
}

const AIRPLAY_AGENT_IDLE_MS = 2 * 60 * 1000;

type AgentEntry = {
  agent: http.Agent;
  lastUsed: number;
  timer: NodeJS.Timeout;
};

const agentCache = new Map<string, AgentEntry>();

function agentKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function touchAgent(entry: AgentEntry): void {
  entry.lastUsed = Date.now();
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (Date.now() - entry.lastUsed >= AIRPLAY_AGENT_IDLE_MS) {
      entry.agent.destroy();
      // Find and remove by identity
      for (const [key, value] of agentCache) {
        if (value === entry) {
          agentCache.delete(key);
          break;
        }
      }
    }
  }, AIRPLAY_AGENT_IDLE_MS);
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
}

function getPairingAgent(host: string, port: number): http.Agent {
  const key = agentKey(host, port);
  const existing = agentCache.get(key);
  if (existing) {
    touchAgent(existing);
    return existing.agent;
  }

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  agent.on('free', (socket) => {
    socket.unref();
  });
  const entry: AgentEntry = {
    agent,
    lastUsed: Date.now(),
    timer: setTimeout(() => {
      agent.destroy();
      agentCache.delete(key);
    }, AIRPLAY_AGENT_IDLE_MS),
  };
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
  agentCache.set(key, entry);
  return agent;
}

/**
 * Start AirPlay pairing: triggers PIN display on the Apple TV.
 * Returns a session object to pass to finishAirPlayPairing.
 */
export async function startAirPlayPairing(host: string, port: number): Promise<AirPlayPairingSession> {
  const srp = new SRPAuthHandler();
  srp.initialize();
  const agent = getPairingAgent(host, port);

  // Trigger PIN display
  await httpPost(host, port, '/pair-pin-start', undefined, agent);

  // Send pair-setup SeqNo 1
  const tlvData = writeTlv(new Map<number, Buffer>([
    [TlvValue.Method, Buffer.from([0x00])],
    [TlvValue.SeqNo, Buffer.from([0x01])],
  ]));

  const resp = await httpPost(host, port, '/pair-setup', tlvData, agent);
  const pairingData = readTlv(resp);

  const atvSalt = pairingData.get(TlvValue.Salt);
  const atvPubKey = pairingData.get(TlvValue.PublicKey);

  if (!atvSalt || !atvPubKey) {
    throw new Error('Missing salt or public key in pair-setup response');
  }

  return { srp, host, port, atvSalt, atvPubKey };
}

/**
 * Finish AirPlay pairing with the PIN shown on screen.
 * Returns credentials for later connection.
 */
export async function finishAirPlayPairing(
  session: AirPlayPairingSession,
  pin: string,
  displayName?: string,
): Promise<HapCredentials> {
  const { srp, host, port, atvSalt, atvPubKey } = session;
  const agent = getPairingAgent(host, port);

  console.log('[DEBUG] ATV Salt:', atvSalt.toString('hex'));
  console.log('[DEBUG] ATV PubKey length:', atvPubKey.length);
  console.log('[DEBUG] PIN:', pin);

  // SRP step 1: set PIN
  srp.step1(pin.trim());

  // SRP step 2: compute proof
  const [pubKey, proof] = srp.step2(atvPubKey, atvSalt);
  console.log('[DEBUG] Client PubKey length:', pubKey.length);
  console.log('[DEBUG] Client Proof length:', proof.length);

  // Send pair-setup SeqNo 3
  const seq3Data = writeTlv(new Map<number, Buffer>([
    [TlvValue.SeqNo, Buffer.from([0x03])],
    [TlvValue.PublicKey, pubKey],
    [TlvValue.Proof, proof],
  ]));
  const seq3Resp = await httpPost(host, port, '/pair-setup', seq3Data, agent);

  // Check for errors in SeqNo 3 response (wrong PIN, etc.)
  const seq3Tlv = readTlv(seq3Resp);
  console.log('[DEBUG] SeqNo 3 response TLV keys:', Array.from(seq3Tlv.keys()));
  const errorCode = seq3Tlv.get(TlvValue.Error);
  if (errorCode) {
    const code = errorCode[0];
    const errorMessages: Record<number, string> = {
      1: 'Unknown error',
      2: 'Authentication failed (wrong PIN?)',
      3: 'Too many attempts, backoff required',
      4: 'Unknown peer',
      5: 'Max peers reached',
      6: 'Max authentication attempts reached',
    };
    console.log('[DEBUG] Error code:', code);
    console.log('[DEBUG] Full response hex:', seq3Resp.toString('hex'));
    throw new Error(`Pairing failed: ${errorMessages[code] || `error code ${code}`}`);
  }

  // SRP step 3: sign and encrypt identity
  const encrypted = srp.step3(displayName || undefined);

  // Send pair-setup SeqNo 5
  const seq5Data = writeTlv(new Map<number, Buffer>([
    [TlvValue.SeqNo, Buffer.from([0x05])],
    [TlvValue.EncryptedData, encrypted],
  ]));
  const resp = await httpPost(host, port, '/pair-setup', seq5Data, agent);
  const pairingData = readTlv(resp);

  const encryptedResponse = pairingData.get(TlvValue.EncryptedData);
  if (!encryptedResponse) {
    throw new Error('Missing encrypted data in pair-setup step 4 response');
  }

  // SRP step 4: decrypt and extract credentials
  return srp.step4(encryptedResponse);
}
