/**
 * Minimal binary plist support for RTI (Remote Text Input) NSKeyedArchiver payloads.
 * Uses bplist-creator for encoding and bplist-parser for decoding.
 */

// @ts-ignore - no type definitions
import bplistCreator from 'bplist-creator';
// @ts-ignore - no type definitions
import bplistParser from 'bplist-parser';

/** UID reference type for NSKeyedArchiver plists. */
class UID {
  UID: number;
  constructor(value: number) {
    this.UID = value;
  }
}

/**
 * Create an RTI "clear text" payload (NSKeyedArchiver encoded).
 * Matches pyatv/protocols/companion/plist_payloads/rti_text_operations.py
 */
export function createRtiClearTextPayload(sessionUuid: Buffer): Buffer {
  return bplistCreator({
    '$version': 100000,
    '$archiver': 'RTIKeyedArchiver',
    '$top': {
      textOperations: new UID(1),
    },
    '$objects': [
      '$null',
      {
        '$class': new UID(7),
        targetSessionUUID: new UID(5),
        keyboardOutput: new UID(2),
        textToAssert: new UID(4),
      },
      {
        '$class': new UID(3),
      },
      {
        '$classname': 'TIKeyboardOutput',
        '$classes': ['TIKeyboardOutput', 'NSObject'],
      },
      '',  // empty text assertion = clear
      {
        'NS.uuidbytes': sessionUuid,
        '$class': new UID(6),
      },
      {
        '$classname': 'NSUUID',
        '$classes': ['NSUUID', 'NSObject'],
      },
      {
        '$classname': 'RTITextOperations',
        '$classes': ['RTITextOperations', 'NSObject'],
      },
    ],
  });
}

/**
 * Create an RTI "input text" payload (NSKeyedArchiver encoded).
 */
export function createRtiInputTextPayload(sessionUuid: Buffer, text: string): Buffer {
  return bplistCreator({
    '$version': 100000,
    '$archiver': 'RTIKeyedArchiver',
    '$top': {
      textOperations: new UID(1),
    },
    '$objects': [
      '$null',
      {
        keyboardOutput: new UID(2),
        '$class': new UID(7),
        targetSessionUUID: new UID(5),
      },
      {
        insertionText: new UID(3),
        '$class': new UID(4),
      },
      text,
      {
        '$classname': 'TIKeyboardOutput',
        '$classes': ['TIKeyboardOutput', 'NSObject'],
      },
      {
        'NS.uuidbytes': sessionUuid,
        '$class': new UID(6),
      },
      {
        '$classname': 'NSUUID',
        '$classes': ['NSUUID', 'NSObject'],
      },
      {
        '$classname': 'RTITextOperations',
        '$classes': ['RTITextOperations', 'NSObject'],
      },
    ],
  });
}

/**
 * Parse a binary plist buffer and extract properties by path.
 * Matches pyatv/protocols/companion/keyed_archiver.py read_archive_properties().
 */
export function readArchiveProperties(archive: Buffer, ...paths: string[][]): (unknown | null)[] {
  let parsed: any[];
  try {
    parsed = bplistParser.parseBuffer(archive);
  } catch {
    return paths.map(() => null);
  }
  if (!parsed || !Array.isArray(parsed) || parsed.length < 1) return paths.map(() => null);

  const data = parsed[0];
  const objects = data['$objects'];
  const top = data['$top'];

  return paths.map((path) => {
    let element: any = top;
    try {
      for (const key of path) {
        element = element[key];
        // Resolve UID references
        if (element && typeof element === 'object' && 'UID' in element) {
          element = objects[element.UID];
        }
      }
      return element ?? null;
    } catch {
      return null;
    }
  });
}
