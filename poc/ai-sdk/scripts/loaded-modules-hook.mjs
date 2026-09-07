// ESM loader hook for scripts/loaded-modules.mjs - see that file's header for why this
// measurement exists. Reports each module resolved from a `node_modules/` directory back
// to the parent over the MessagePort it was registered with; everything else passes
// through untouched.
let port;

export async function initialize(data) {
  port = data.port;
}

export async function load(url, context, nextLoad) {
  if (port && url.includes("/node_modules/")) port.postMessage(url);
  return nextLoad(url, context);
}
