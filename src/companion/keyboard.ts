/**
 * Keyboard/text input via Companion protocol.
 * Port of pyatv/protocols/companion/api.py text input handling +
 * pyatv/protocols/companion/__init__.py CompanionKeyboard.
 */

import { CompanionProtocol } from './protocol';
import { createRtiClearTextPayload, createRtiInputTextPayload, readArchiveProperties } from '../bplist';

export enum KeyboardFocusState {
  Unknown = 'unknown',
  Focused = 'focused',
  Unfocused = 'unfocused',
}

export interface KeyboardState {
  focusState: KeyboardFocusState;
}

/**
 * Start a text input session. Returns the response containing _tiD if keyboard is focused.
 */
async function textInputStart(protocol: CompanionProtocol): Promise<Record<string, unknown>> {
  return protocol.sendCommand('_tiStart', {});
}

/**
 * Stop a text input session.
 */
async function textInputStop(protocol: CompanionProtocol): Promise<Record<string, unknown>> {
  return protocol.sendCommand('_tiStop', {});
}

/**
 * Execute a text input command: optionally clear existing text, then append new text.
 * Returns the current text after the operation, or null if keyboard not focused.
 */
export async function textInputCommand(
  protocol: CompanionProtocol,
  text: string,
  clearPreviousInput: boolean,
): Promise<string | null> {
  // Restart session to get latest state
  await textInputStop(protocol);
  const response = await textInputStart(protocol);

  const content = (response._c || {}) as Record<string, unknown>;
  const tiData = content._tiD;

  if (!tiData || !Buffer.isBuffer(tiData)) {
    return null; // Keyboard not focused
  }

  // Extract session UUID and current text from NSKeyedArchiver data
  const [sessionUuid, currentTextRaw] = readArchiveProperties(
    tiData,
    ['sessionUUID'],
    ['documentState', 'docSt', 'contextBeforeInput'],
  );

  if (!sessionUuid || !Buffer.isBuffer(sessionUuid)) {
    return null;
  }

  let currentText: string = typeof currentTextRaw === 'string' ? currentTextRaw : '';

  // Clear text if requested
  if (clearPreviousInput) {
    protocol.sendEvent('_tiC', {
      _tiV: 1,
      _tiD: createRtiClearTextPayload(sessionUuid),
    });
    currentText = '';
  }

  // Append new text
  if (text) {
    protocol.sendEvent('_tiC', {
      _tiV: 1,
      _tiD: createRtiInputTextPayload(sessionUuid, text),
    });
    currentText += text;
  }

  return currentText;
}

/**
 * Get the current text from a focused keyboard.
 */
export async function getText(protocol: CompanionProtocol): Promise<string | null> {
  return textInputCommand(protocol, '', false);
}

/**
 * Set (replace) the text in a focused keyboard.
 */
export async function setText(protocol: CompanionProtocol, text: string): Promise<void> {
  await textInputCommand(protocol, text, true);
}

/**
 * Check if keyboard is currently focused by starting a text input session.
 */
export async function getKeyboardFocus(protocol: CompanionProtocol): Promise<boolean> {
  await textInputStop(protocol);
  const response = await textInputStart(protocol);
  const content = (response._c || {}) as Record<string, unknown>;
  return '_tiD' in content && content._tiD !== null && content._tiD !== undefined;
}

/**
 * Register keyboard focus state listeners on a protocol instance.
 * Uses polling since _tiStarted/_tiStopped events aren't reliably pushed.
 * Calls the callback whenever focus state changes.
 * Returns a function to stop the polling.
 */
export function watchKeyboardFocus(
  protocol: CompanionProtocol,
  callback: (state: KeyboardFocusState) => void,
  pollIntervalMs = 1000,
): () => void {
  let lastState: KeyboardFocusState = KeyboardFocusState.Unknown;
  let running = true;

  const poll = async () => {
    if (!running) return;

    try {
      const focused = await getKeyboardFocus(protocol);
      const newState = focused ? KeyboardFocusState.Focused : KeyboardFocusState.Unfocused;

      if (newState !== lastState) {
        lastState = newState;
        callback(newState);
      }
    } catch {
      // Connection may be closed, stop polling
      running = false;
      return;
    }

    if (running) {
      setTimeout(poll, pollIntervalMs);
    }
  };

  // Start polling
  poll();

  // Return stop function
  return () => {
    running = false;
  };
}
