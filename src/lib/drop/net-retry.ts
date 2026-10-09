/**
 * When a drive request gets no response at all. A read (GET/HEAD) is safe to repeat, so
 * while the browser still says it's online it gets one more go after a short pause: a
 * connection reset, a network switch, or a request cut off while the page was still
 * settling after the sign-in redirect is not worth a 「网络中断」 warning. A real outage fails
 * the second time too, and offline (or a write) fails at once. No imports: unit-tested.
 */
export const NETWORK_RETRY_MS = 1200;

export async function retryRead<T>(
  attempt: () => Promise<T>,
  options: { method?: string; online: () => boolean; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    const method = (options.method ?? "GET").toUpperCase();
    if ((method !== "GET" && method !== "HEAD") || !options.online()) throw error;
    await (options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(NETWORK_RETRY_MS);
    return attempt();
  }
}
