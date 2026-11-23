export class DiagramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiagramError';
  }
}

export function newId(prefix = 'e') {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
}
