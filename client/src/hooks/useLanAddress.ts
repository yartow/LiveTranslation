import { useCallback, useEffect, useState } from 'react';

interface LanAddressResponse {
  addresses: string[];
  port: string;
}

/**
 * The MBP's LAN address(es) as ready-to-share URLs, from GET /api/lan-address
 * (CLAUDE.md "Listener mode"). Fetches only while `open` is true — the address
 * doesn't change while someone is looking at it, so there's no polling;
 * `refresh` re-reads it after a network change (e.g. joining the church wifi).
 */
export function useLanAddress(open: boolean) {
  const [urls, setUrls] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(false);
    setLoaded(false);
    fetch('/api/lan-address')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: LanAddressResponse) => {
        if (cancelled) return;
        setUrls(json.addresses.map(addr => `http://${addr}:${json.port}`));
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [open, nonce]);

  const refresh = useCallback(() => setNonce(n => n + 1), []);

  return { urls, loaded, error, refresh };
}
