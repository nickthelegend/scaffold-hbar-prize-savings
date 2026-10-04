import { useCallback, useRef, useState } from "react";

/**
 * Runs one async action at a time. A ref, not state, guards entry: a double-click fires both handlers before React
 * re-renders a disabled button, which would otherwise send the same transaction twice.
 */
export const useSingleFlight = () => {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    try {
      await action();
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }, []);
  return { run, running };
};
