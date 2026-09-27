/**
 * Terminal output. Two rules that matter:
 *   1. Secrets must never reach the terminal through this module — `redact()`
 *      scrubs anything that looks like an opaque token before printing.
 *   2. `--quiet` and `--json` must both be honoured consistently, so the sandbox
 *      harness and CI can assert on output instead of scraping prose.
 */

const TOKEN_LIKE = /[A-Za-z0-9_+=]{32,}/g;

export const redact = (value) => {
  const text = typeof value === 'string' ? value : String(value);
  return text.replace(TOKEN_LIKE, (m) => `${m.slice(0, 4)}…<redacted:${m.length}>`);
};

const createLogger = ({ quiet = false, json = false } = {}) => {
  const emit = (stream, line) => stream.write(`${line}\n`);
  return {
    quiet,
    json,
    /** Ordinary progress line. Suppressed by --quiet. */
    info: (msg) => { if (!quiet && !json) emit(process.stdout, redact(msg)); },
    /** Always shown, even with --quiet. */
    say: (msg) => { if (!json) emit(process.stdout, redact(msg)); },
    ok: (msg) => { if (!json) emit(process.stdout, redact(msg)); },
    warn: (msg) => { if (!json) emit(process.stderr, redact(`warn: ${msg}`)); },
    error: (msg) => { if (!json) emit(process.stderr, redact(`error: ${msg}`)); },
    /** Machine-readable payload. Printed only under --json. */
    payload: (obj) => { if (json) emit(process.stdout, JSON.stringify(obj, null, 2)); },
  };
};

export default createLogger;
