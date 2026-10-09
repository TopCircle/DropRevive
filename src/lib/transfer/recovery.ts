export function createRecovery(input: {
  graceMs: number;
  settleMs: number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  connectionState: () => string | undefined;
  onGrace: () => void;
  onSettle: () => void;
}): {
  recovering: boolean;
  graceExpired: boolean;
  settleElapsed: boolean;
  ensure(opened: boolean): void;
  armSettle(): void;
  connected(): void;
  clear(): void;
  reset(): void;
} {
  let recovering = false;
  let graceExpired = false;
  let settleElapsed = false;
  let graceTimer = 0;
  let settleTimer = 0;
  return {
    get recovering() {
      return recovering;
    },
    get graceExpired() {
      return graceExpired;
    },
    get settleElapsed() {
      return settleElapsed;
    },
    ensure(opened) {
      if (!opened || graceTimer || graceExpired) return;
      recovering = true;
      graceTimer = input.setTimeout(() => {
        graceExpired = true;
        input.onGrace();
      }, input.graceMs);
    },
    armSettle() {
      if (settleTimer) return;
      settleTimer = input.setTimeout(() => {
        settleTimer = 0;
        if (input.connectionState() !== "disconnected") return;
        settleElapsed = true;
        input.onSettle();
      }, input.settleMs);
    },
    connected() {
      if (!settleTimer) return;
      input.clearTimeout(settleTimer);
      settleTimer = 0;
    },
    clear() {
      if (graceTimer) input.clearTimeout(graceTimer);
      if (settleTimer) input.clearTimeout(settleTimer);
      graceTimer = 0;
      settleTimer = 0;
    },
    reset() {
      if (graceTimer) input.clearTimeout(graceTimer);
      if (settleTimer) input.clearTimeout(settleTimer);
      graceTimer = 0;
      settleTimer = 0;
      recovering = false;
      graceExpired = false;
      settleElapsed = false;
    },
  };
}

export type Recovery = ReturnType<typeof createRecovery>;
