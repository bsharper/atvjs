import { CompanionConnection } from './connection';

const COMPANION_AGENT_IDLE_MS = 2 * 60 * 1000;

type Entry = {
  connection: CompanionConnection;
  lastUsed: number;
  timer: NodeJS.Timeout;
};

const connectionCache = new Map<string, Entry>();

function connectionKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function scheduleCleanup(key: string, entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.lastUsed = Date.now();
  entry.timer = setTimeout(() => {
    if (Date.now() - entry.lastUsed >= COMPANION_AGENT_IDLE_MS) {
      entry.connection.close();
      connectionCache.delete(key);
    }
  }, COMPANION_AGENT_IDLE_MS);
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
}

export function getCompanionPairingConnection(host: string, port: number): CompanionConnection {
  const key = connectionKey(host, port);
  const existing = connectionCache.get(key);
  if (existing) {
    if (existing.connection.isConnected) {
      scheduleCleanup(key, existing);
      return existing.connection;
    }
    existing.connection.close();
    connectionCache.delete(key);
  }

  const connection = new CompanionConnection(host, port);
  const entry: Entry = {
    connection,
    lastUsed: Date.now(),
    timer: setTimeout(() => {
      connection.close();
      connectionCache.delete(key);
    }, COMPANION_AGENT_IDLE_MS),
  };
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
  connectionCache.set(key, entry);
  return connection;
}

export function releaseCompanionPairingConnection(connection: CompanionConnection): void {
  const key = connectionKey(connection.getHost(), connection.getPort());
  const existing = connectionCache.get(key);
  if (existing) {
    scheduleCleanup(key, existing);
  } else {
    const entry: Entry = {
      connection,
      lastUsed: Date.now(),
      timer: setTimeout(() => {
        connection.close();
        connectionCache.delete(key);
      }, COMPANION_AGENT_IDLE_MS),
    };
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    connectionCache.set(key, entry);
  }

  // Detach listener to avoid delivering stale events.
  connection.setListener({ frameReceived: () => {}, connectionLost: () => {} });
}
