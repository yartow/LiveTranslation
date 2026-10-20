// True only for a connection from the machine the server runs on. Checked on
// req.socket.remoteAddress, never a header — a header is spoofable.
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const stripped = addr.replace(/^::ffff:/, '');
  return stripped === '127.0.0.1' || stripped === '::1' || stripped === 'localhost';
}

/** Local-machine-only endpoints (mic volume, glossary writes) stay open to other devices only when the operator console itself is. */
export function isOperatorRequest(addr: string | undefined): boolean {
  return process.env.ALLOW_REMOTE_OPERATOR === 'true' || isLoopbackAddress(addr);
}
