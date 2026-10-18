import type { PtyProcess, TerminalScreen } from './contracts.js';

const OUTPUT_HIGH_WATER = 256 * 1024;
const OUTPUT_LOW_WATER = 64 * 1024;

/** Apply back pressure to the PTY until xterm has parsed queued output. */
export function pipeOutput(
  child: PtyProcess,
  screen: TerminalScreen,
  received: () => void,
  parsed: () => void,
): { dispose(): void } {
  let pending = 0;
  let paused = false;
  let disposed = false;
  let notificationPending = false;

  const subscription = child.onData((data) => {
    if (disposed) {
      return;
    }

    pending += data.length;
    if (!paused && pending >= OUTPUT_HIGH_WATER) {
      paused = true;
      child.pause();
    }

    received();
    screen.write(data, () => {
      pending -= data.length;
      if (disposed) {
        return;
      }

      if (paused && pending <= OUTPUT_LOW_WATER) {
        paused = false;
        child.resume();
      }

      // xterm can finish many queued chunks in one parser turn. Inspect the
      // final screen once instead of rescanning it after every chunk.
      if (!notificationPending) {
        notificationPending = true;
        queueMicrotask(() => {
          notificationPending = false;
          if (!disposed) {
            parsed();
          }
        });
      }
    });
  });

  return {
    dispose: () => {
      if (disposed) {
        return;
      }

      disposed = true;
      subscription.dispose();

      // Let the PTY drain and deliver its exit notification during shutdown.
      if (paused) {
        child.resume();
      }
    },
  };
}
