// Error type used by every public core operation.
export class DiagramError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'DiagramError';
    this.code = code;
  }
}
