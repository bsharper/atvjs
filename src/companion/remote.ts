/**
 * Remote control via Companion protocol HID and media control commands.
 * Port of pyatv/protocols/companion/api.py + __init__.py remote control.
 */

import { CompanionProtocol } from './protocol';

/** HID command values matching pyatv's HidCommand enum. */
export enum HidCommand {
  Up = 1,
  Down = 2,
  Left = 3,
  Right = 4,
  Menu = 5,
  Select = 6,
  Home = 7,
  VolumeUp = 8,
  VolumeDown = 9,
  Siri = 10,
  Screensaver = 11,
  Sleep = 12,
  Wake = 13,
  PlayPause = 14,
  ChannelIncrement = 15,
  ChannelDecrement = 16,
  Guide = 17,
  PageUp = 18,
  PageDown = 19,
}

/** Media control command values matching pyatv's MediaControlCommand enum. */
export enum MediaControlCommand {
  Play = 1,
  Pause = 2,
  NextTrack = 3,
  PreviousTrack = 4,
  GetVolume = 5,
  SetVolume = 6,
  SkipBy = 7,
}

/** Named remote keys. */
export enum RemoteKey {
  Up = 'up',
  Down = 'down',
  Left = 'left',
  Right = 'right',
  Select = 'select',
  Menu = 'menu',
  TopMenu = 'top_menu',
  Home = 'home',
  HomeHold = 'home_hold',
  PlayPause = 'play_pause',
  Next = 'next',
  Previous = 'previous',
  SkipForward = 'skip_forward',
  SkipBackward = 'skip_backward',
  VolumeUp = 'volume_up',
  VolumeDown = 'volume_down',
  Guide = 'guide',
}

const KEY_TO_HID: Record<string, HidCommand> = {
  [RemoteKey.Up]: HidCommand.Up,
  [RemoteKey.Down]: HidCommand.Down,
  [RemoteKey.Left]: HidCommand.Left,
  [RemoteKey.Right]: HidCommand.Right,
  [RemoteKey.Select]: HidCommand.Select,
  [RemoteKey.Menu]: HidCommand.Menu,
  [RemoteKey.TopMenu]: HidCommand.Menu,
  [RemoteKey.Home]: HidCommand.Home,
  [RemoteKey.HomeHold]: HidCommand.Home,
  [RemoteKey.PlayPause]: HidCommand.PlayPause,
  [RemoteKey.VolumeUp]: HidCommand.VolumeUp,
  [RemoteKey.VolumeDown]: HidCommand.VolumeDown,
  [RemoteKey.Guide]: HidCommand.Guide,
};

/** Keys that are media control commands rather than HID. */
const KEY_TO_MEDIA: Record<string, MediaControlCommand> = {
  [RemoteKey.Next]: MediaControlCommand.NextTrack,
  [RemoteKey.Previous]: MediaControlCommand.PreviousTrack,
};

/** Keys that require a long press (hold down, delay, release). */
const LONG_PRESS_KEYS = new Set<string>([RemoteKey.HomeHold]);

const LONG_PRESS_DELAY_MS = 1000;

/**
 * Send a media control command.
 */
export async function sendMediaControl(
  protocol: CompanionProtocol,
  command: MediaControlCommand,
  args?: Record<string, unknown>,
): Promise<void> {
  await protocol.sendCommand('_mcc', { _mcc: command, ...(args || {}) });
}

/**
 * Send a remote control key press. Handles HID keys, media control keys,
 * and long-press keys automatically.
 */
export async function sendKeyPress(protocol: CompanionProtocol, key: RemoteKey | string): Promise<void> {
  // Media control keys
  const mediaCommand = KEY_TO_MEDIA[key];
  if (mediaCommand !== undefined) {
    await sendMediaControl(protocol, mediaCommand);
    return;
  }

  const hidCommand = KEY_TO_HID[key];
  if (hidCommand === undefined) {
    throw new Error(`Unknown remote key: ${key}`);
  }

  if (LONG_PRESS_KEYS.has(key)) {
    // Long press: hold down, wait, release
    await protocol.sendCommand('_hidC', { _hBtS: 1, _hidC: hidCommand });
    await new Promise((r) => setTimeout(r, LONG_PRESS_DELAY_MS));
    await protocol.sendCommand('_hidC', { _hBtS: 2, _hidC: hidCommand });
    return;
  }

  // Normal press: down + up
  await protocol.sendCommand('_hidC', { _hBtS: 1, _hidC: hidCommand });
  await protocol.sendCommand('_hidC', { _hBtS: 2, _hidC: hidCommand });
}

/**
 * Send a HID button down event only (for long press behavior).
 */
export async function sendKeyDown(protocol: CompanionProtocol, key: RemoteKey | string): Promise<void> {
  const hidCommand = KEY_TO_HID[key];
  if (hidCommand === undefined) {
    throw new Error(`Unknown remote key: ${key}`);
  }
  await protocol.sendCommand('_hidC', { _hBtS: 1, _hidC: hidCommand });
}

/**
 * Send a HID button up event only (to release a held button).
 */
export async function sendKeyUp(protocol: CompanionProtocol, key: RemoteKey | string): Promise<void> {
  const hidCommand = KEY_TO_HID[key];
  if (hidCommand === undefined) {
    throw new Error(`Unknown remote key: ${key}`);
  }
  await protocol.sendCommand('_hidC', { _hBtS: 2, _hidC: hidCommand });
}
