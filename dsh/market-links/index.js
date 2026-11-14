/**
 * Host half of `dsh-market-links`.
 *
 * The feature is pure browser UI: a sidebar row and a panel that lists the
 * community plugin markets and opens one in the system browser. Nothing here
 * registers a service, a tool, or a model-facing section, so the Host half is
 * deliberately empty — the Client module in `client.js` owns all of it.
 */
export function apply() {}
