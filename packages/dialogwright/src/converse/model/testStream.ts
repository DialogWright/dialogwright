/** Test helpers: a fetch stub that replays an SSE body, in small chunks to cross boundaries. */
export function sseResponse(events: string[], chunk = 7): Response {
  const text = events.join('');
  const enc = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < enc.length; i += chunk) c.enqueue(enc.slice(i, i + chunk));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const sse = (data: unknown, event?: string): string => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

export function stubFetch(res: () => Response): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return res();
    }) as unknown as typeof fetch,
  };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}
