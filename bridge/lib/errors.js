/**
 * Process exit codes and the error type that carries them.
 *
 * 0 ok | 1 business failure | 2 usage error | 3 environment error
 */

export const EXIT = {
  OK: 0,
  BUSINESS: 1,
  USAGE: 2,
  ENV: 3,
};

export class BridgeError extends Error {
  /**
   * @param {string} code   short machine-readable reason
   * @param {string} message human-readable, shown to the user
   * @param {number} exit   one of EXIT
   * @param {object} [details]
   */
  constructor(code, message, exit = EXIT.BUSINESS, details = undefined) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.exit = exit;
    this.details = details;
  }
}

export const usageError = (message) => new BridgeError('USAGE', message, EXIT.USAGE);
export const envError = (code, message, details) => new BridgeError(code, message, EXIT.ENV, details);
export const businessError = (code, message, details) => new BridgeError(code, message, EXIT.BUSINESS, details);
