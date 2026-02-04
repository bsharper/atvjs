#!/usr/bin/env npx ts-node
/**
 * Scan for Apple TVs, select one, pair AirPlay + Companion, save credentials.
 *
 * Usage: npx ts-node examples/pair.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  scan,
  startAirPlayPairing,
  finishAirPlayPairing,
  startCompanionPairing,
  finishCompanionPairing,
  serializeCredentials,
  AppleTVDevice,
} from '../src/index';

const CREDS_PATH = path.join(__dirname, 'device.json');

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // --- Scan ---
    console.log('Scanning for Apple TVs (5 seconds)...');
    const devices = await scan(5000);

    if (devices.length === 0) {
      console.log('No devices found.');
      process.exit(1);
    }

    console.log('\nFound devices:');
    devices.forEach((d, i) => {
      console.log(`  [${i}] ${d.name} (${d.address}) — model: ${d.model || 'unknown'}`);
    });

    // --- Select ---
    let device: AppleTVDevice;
    if (devices.length === 1) {
      device = devices[0];
      console.log(`\nAuto-selecting: ${device.name}`);
    } else {
      const idx = await ask(rl, `\nSelect device [0-${devices.length - 1}]: `);
      device = devices[parseInt(idx, 10)];
      if (!device) {
        console.log('Invalid selection.');
        process.exit(1);
      }
    }

    // --- AirPlay pairing (phase 1) ---
    console.log(`\nStarting AirPlay pairing with ${device.name}...`);
    console.log('A PIN should appear on your Apple TV screen.');
    const airplaySession = await startAirPlayPairing(device);

    const pin1 = await ask(rl, 'Enter the PIN shown on screen: ');
    console.log('Completing AirPlay pairing...');
    const airplayCreds = await finishAirPlayPairing(airplaySession, pin1.trim(), 'atv-js');
    console.log('AirPlay pairing successful!');

    // --- Companion pairing (phase 2) ---
    console.log(`\nStarting Companion pairing with ${device.name}...`);
    console.log('A new PIN should appear on your Apple TV screen.');
    const companionSession = await startCompanionPairing(device);

    const pin2 = await ask(rl, 'Enter the PIN shown on screen: ');
    console.log('Completing Companion pairing...');
    const companionCreds = await finishCompanionPairing(companionSession, pin2.trim(), 'atv-js');
    console.log('Companion pairing successful!');

    // --- Save credentials ---
    const savedData = {
      name: device.name,
      address: device.address,
      port: device.port,
      airplayPort: device.airplayPort,
      identifier: device.identifier,
      model: device.model,
      credentials: {
        airplay: serializeCredentials(airplayCreds),
        companion: serializeCredentials(companionCreds),
      },
    };

    fs.writeFileSync(CREDS_PATH, JSON.stringify(savedData, null, 2));
    console.log(`\nCredentials saved to ${CREDS_PATH}`);
  } catch (err: any) {
    console.error('Error:', err.message || err);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
