import { useLayoutEffect, useRef } from 'react';

/**
 * A ref that always holds the value from the latest committed render, for
 * callbacks and long-lived listeners that must not capture a stale one.
 * Written in a layout effect, not during render, so an uncommitted render can
 * never leak its value into the ref.
 */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => { ref.current = value; });
  return ref;
}
