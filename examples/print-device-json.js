const fs = require('node:fs');
const path = require('node:path');

// prints the contents of device.json in the format atv-desktop-remote uses, useful for debugging and testing

const devicePath = path.join(__dirname, 'device.json');
const raw = fs.readFileSync(devicePath, 'utf8');
const parsed = JSON.parse(raw);

const output = {
  airplay: parsed.credentials.airplay,
  companion: parsed.credentials.companion,
  device: {
    name: parsed.name,
    address: parsed.address,
    port: parsed.port,
    airplayPort: parsed.airplayPort,
    identifier: parsed.identifier,
  },
};

console.log(JSON.stringify(output, null, 2));
