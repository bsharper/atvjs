#!/usr/bin/env npx ts-node
/**
 * Connect to a paired Apple TV, interactive remote control with keyboard input support.
 *
 * Usage: npx ts-node examples/remote.ts
 *
 * Reads credentials from examples/device.json (created by pair.ts).
 * Uses raw terminal mode to capture individual keypresses.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  connect,
  sendKey,
  getText,
  setText,
  getKeyboardFocusState,
  onConnectionLost,
  disconnect,
  isConnected,
  RemoteKey,
  AppleTVConnection,
} from '../src/index';
import { watchKeyboardFocus, KeyboardFocusState } from '../src/companion/keyboard';

const CREDS_PATH = path.join(__dirname, 'device.json');

// Keyboard mapping: terminal key → RemoteKey
const KEYMAP: Record<string, string> = {
  '\x1b[D': RemoteKey.Left,       // ArrowLeft
  '\x1b[C': RemoteKey.Right,      // ArrowRight
  '\x1b[A': RemoteKey.Up,         // ArrowUp
  '\x1b[B': RemoteKey.Down,       // ArrowDown
  '\r':     RemoteKey.Select,     // Enter
  ' ':      RemoteKey.PlayPause,  // Space
  '\x7f':   RemoteKey.Menu,       // Backspace
  '\x1b':   RemoteKey.Menu,       // Escape (raw)
  'n':      RemoteKey.Next,
  'p':      RemoteKey.Previous,
  ']':      RemoteKey.Next,
  '[':      RemoteKey.Previous,
  't':      RemoteKey.Home,
  'l':      RemoteKey.HomeHold,
  '-':      RemoteKey.VolumeDown,
  '=':      RemoteKey.VolumeUp
};

// Module-level cleanup function for keyboard watcher
let stopKeyboardWatcher: (() => void) | null = null;

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  // --- Load credentials ---
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`No credentials found at ${CREDS_PATH}`);
    console.error('Run pair.ts first to pair with an Apple TV.');
    process.exit(1);
  }

  const saved = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
  const device = {
    name: saved.name,
    address: saved.address,
    port: saved.port,
    airplayPort: saved.airplayPort,
    identifier: saved.identifier,
    model: saved.model,
    properties: {},
  };

  console.log(`Connecting to ${device.name} (${device.address})...`);

  let conn: AppleTVConnection;
  try {
    conn = await connect(device, saved.credentials);
  } catch (err: any) {
    console.error('Connection failed:', err.message || err);
    process.exit(1);
  }

  console.log('Connected!\n');

  onConnectionLost(conn, (err) => {
    console.log(`\nConnection lost${err ? ': ' + err.message : ''}`);
    process.exit(1);
  });

  // --- Watch keyboard focus (polls every 1 second) ---
  let keyboardFocused = false;

  stopKeyboardWatcher = watchKeyboardFocus(conn.protocol, (state) => {
    const wasFocused = keyboardFocused;
    keyboardFocused = state === KeyboardFocusState.Focused;

    if (keyboardFocused && !wasFocused) {
      console.log('\n[Keyboard focused — entering text input mode]');
      console.log('Type text and press Enter to send, or press Escape to go back.\n');
      enterTextMode(conn);
    } else if (!keyboardFocused && wasFocused) {
      console.log('\n[Keyboard unfocused — back to remote mode]');
      enterRemoteMode(conn);
    }
  });

  // --- Start in remote mode ---
  printRemoteHelp();
  enterRemoteMode(conn);
}

function printRemoteHelp() {
  console.log('--- Apple TV Remote ---');
  console.log('Arrow keys : Navigate');
  console.log('Enter      : Select');
  console.log('Space      : Play/Pause');
  console.log('Backspace  : Menu/Back');
  console.log('t          : Home (TV button)');
  console.log('l          : Long-press Home');
  console.log('n / ]      : Next track');
  console.log('p / [      : Previous track');
  console.log('- / =      : Volume down/up');
  console.log('Ctrl+C     : Quit');
  console.log('');
}

function enterRemoteMode(conn: AppleTVConnection) {
  if (!process.stdin.isTTY) {
    console.error('stdin is not a TTY — raw mode not available');
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('line');

  process.stdin.on('data', async (data: Buffer) => {
    const key = data.toString();

    // Ctrl+C
    if (key === '\x03') {
      console.log('\nDisconnecting...');
      if (stopKeyboardWatcher) stopKeyboardWatcher();
      disconnect(conn);
      process.exit(0);
    }

    const mapped = KEYMAP[key];
    if (mapped) {
      try {
        await sendKey(conn, mapped);
      } catch (err: any) {
        console.error(`Key error: ${err.message}`);
      }
    }
  });
}

function enterTextMode(conn: AppleTVConnection) {
  if (!process.stdin.isTTY) return;

  // Switch out of raw mode so readline works normally
  process.stdin.setRawMode(false);
  process.stdin.removeAllListeners('data');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const promptForText = async () => {
    // Show current text
    try {
      const current = await getText(conn);
      if (current !== null) {
        console.log(`Current text: "${current}"`);
      }
    } catch {}

    rl.question('> ', async (input) => {
      if (input === '\x1b' || input === '\\escape') {
        // User wants to exit text mode — send Menu to dismiss keyboard
        try {
          await sendKey(conn, RemoteKey.Menu);
        } catch {}
        rl.close();
        return;
      }

      // Set the text on the Apple TV
      try {
        await setText(conn, input);
        console.log(`Text set to: "${input}"`);
      } catch (err: any) {
        console.error(`setText error: ${err.message}`);
      }

      // Prompt again
      promptForText();
    });
  };

  rl.on('close', () => {
    // Re-enter remote mode when readline closes
    enterRemoteMode(conn);
  });

  promptForText();
}

main();
