// Localhost request guards shared by the Tutor and UI servers.
//
// Binding to 127.0.0.1 stops other machines, but not other *websites* open in the
// user's browser: DNS rebinding can point an attacker's hostname at 127.0.0.1, and
// any page can fire cross-origin POSTs. These checks close both holes.

const allowedHosts = (port) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

// Reject requests whose Host header isn't this server's loopback address (DNS rebinding).
// Part 18: `extraHosts` adds the machine's own network addresses (UI_HOST=0.0.0.0) and the PUBLIC_ORIGIN host —
// only for the UI server; every other server keeps loopback only. Any other Host name is still refused.
export function hostGuard(port, extraHosts = []) {
  const hosts = new Set([...allowedHosts(port), ...extraHosts]);
  return (req, res, next) => {
    if (hosts.has(req.headers.host)) return next();
    res.status(421).json({ error: 'Misdirected request: unexpected Host header.' });
  };
}

// For state-changing browser endpoints: if an Origin header is present it must be ours.
// (Non-browser clients, like tests, send no Origin.)
export function sameOriginGuard(port, extraOrigins = []) {
  const origins = new Set([...[...allowedHosts(port)].map((h) => `http://${h}`), ...extraOrigins]);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || origins.has(origin)) return next();
    res.status(403).json({ error: 'Cross-origin request refused.' });
  };
}
