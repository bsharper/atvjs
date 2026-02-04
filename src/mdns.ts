/**
 * mDNS device scanning for Apple TV discovery.
 * Queries for _companion-link._tcp and _airplay._tcp services.
 */

import mdns from 'multicast-dns';

export interface AppleTVDevice {
  name: string;
  address: string;
  /** Companion protocol port */
  port: number;
  /** AirPlay port */
  airplayPort: number;
  /** Unique device identifier (from mDNS name or properties) */
  identifier: string;
  /** Device model (e.g. "AppleTV6,2") */
  model: string;
  /** Raw mDNS TXT properties */
  properties: Record<string, string>;
}

interface DiscoveredService {
  name: string;
  address: string;
  port: number;
  properties: Record<string, string>;
}

const APPLE_TV_MODELS = new Set([
  'J33AP',
  'J33DAP',
  'J42dAP',
  'J105aAP',
  'J305AP',
  'J255AP',
]);

function isAppleTvModel(model: string): boolean {
  if (!model) return false;
  if (model.startsWith('J')) return true;
  return APPLE_TV_MODELS.has(model);
}

export async function scan(timeout = 5000, onlyAppleTV = true): Promise<AppleTVDevice[]> {
  return new Promise((resolve) => {
    const browser = mdns();
    const companionServices = new Map<string, DiscoveredService>();
    const airplayServices = new Map<string, DiscoveredService>();
    const deviceInfoModels = new Map<string, string>(); // device name → model from _device-info
    const addressMap = new Map<string, string>();

    browser.on('response', (response: any) => {
      // Collect A/AAAA records for hostname→IP resolution
      for (const answer of [...(response.answers || []), ...(response.additionals || [])]) {
        if (answer.type === 'A') {
          addressMap.set(answer.name, answer.data);
        }
      }

      // Process all records (answers + additionals)
      const allRecords = [...(response.answers || []), ...(response.additionals || [])];

      for (const answer of allRecords) {
        if (answer.type === 'SRV') {
          const name = answer.name;
          const isCompanion = name.endsWith('._companion-link._tcp.local');
          const isAirplay = name.endsWith('._airplay._tcp.local');

          if (isCompanion || isAirplay) {
            const deviceName = name.split('.')[0];
            const target = answer.data?.target;
            const port = answer.data?.port;
            const ip = addressMap.get(target) || '';

            const svc: DiscoveredService = {
              name: deviceName,
              address: ip,
              port,
              properties: {},
            };

            if (isCompanion) {
              companionServices.set(deviceName, svc);
            } else {
              airplayServices.set(deviceName, svc);
            }
          }
        }

        if (answer.type === 'TXT') {
          const name = answer.name;
          const isCompanion = name.endsWith('._companion-link._tcp.local');
          const isAirplay = name.endsWith('._airplay._tcp.local');
          const isDeviceInfo = name.endsWith('._device-info._tcp.local');
          const deviceName = name.split('.')[0];

          const props: Record<string, string> = {};
          if (Array.isArray(answer.data)) {
            for (const entry of answer.data) {
              const str = entry instanceof Buffer ? entry.toString('utf-8') : String(entry);
              const eqIdx = str.indexOf('=');
              if (eqIdx >= 0) {
                props[str.substring(0, eqIdx)] = str.substring(eqIdx + 1);
              }
            }
          }

          if (isCompanion) {
            const existing = companionServices.get(deviceName);
            if (existing) existing.properties = { ...existing.properties, ...props };
          } else if (isAirplay) {
            const existing = airplayServices.get(deviceName);
            if (existing) existing.properties = { ...existing.properties, ...props };
          } else if (isDeviceInfo && props['model']) {
            // _device-info._tcp.local contains the actual device model
            deviceInfoModels.set(deviceName, props['model']);
          }
        }
      }

      // Also resolve addresses found in SRV targets
      for (const svc of [...companionServices.values(), ...airplayServices.values()]) {
        if (!svc.address) {
          for (const answer of allRecords) {
            if (answer.type === 'A') {
              addressMap.set(answer.name, answer.data);
            }
          }
        }
      }
    });

    // Send queries for companion, airplay, and device-info services
    const queryServices = () => {
      browser.query([
        { name: '_companion-link._tcp.local', type: 'PTR' },
        { name: '_airplay._tcp.local', type: 'PTR' },
        { name: '_device-info._tcp.local', type: 'PTR' },
      ]);
    };

    // Send initial query
    queryServices();

    // Send a second query midway for better discovery
    setTimeout(queryServices, timeout / 2);

    setTimeout(() => {
      browser.destroy();

      // Merge companion and airplay services by device name
      const devices: AppleTVDevice[] = [];
      const allNames = new Set([...companionServices.keys(), ...airplayServices.keys()]);

      for (const name of allNames) {
        const companion = companionServices.get(name);
        const airplay = airplayServices.get(name);

        // Need at least companion service for remote control
        if (!companion) continue;

        // Resolve address from either service or address map
        let address = companion.address || airplay?.address || '';
        if (!address) {
          // Try to find address from addressMap
          for (const [hostname, ip] of addressMap) {
            if (hostname.includes(name.replace(/ /g, '-'))) {
              address = ip;
              break;
            }
          }
        }

        if (!address) continue;

        const allProps = { ...companion.properties, ...airplay?.properties };

        // Model comes from _device-info._tcp.local service, not companion/airplay
        const model = deviceInfoModels.get(name) || allProps['model'] || allProps['rpmd'] || '';

        if (onlyAppleTV && !isAppleTvModel(model)) continue;

        devices.push({
          name,
          address,
          port: companion.port,
          airplayPort: airplay?.port || 7000,
          identifier: allProps['deviceid'] || allProps['MACAddress'] || name,
          model,
          properties: allProps,
        });
      }

      resolve(devices);
    }, timeout);
  });
}
