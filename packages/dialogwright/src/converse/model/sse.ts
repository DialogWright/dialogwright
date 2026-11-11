/** The `data:` payloads of a server-sent event stream, across chunk boundaries; comments and other fields are ignored, `[DONE]` ends it. */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const line = (l: string): string | null | undefined => {
    if (l === '') {
      const payload = data.join('\n');
      const had = data.length > 0;
      data = [];
      return had ? payload : undefined;
    }
    if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, ''));
    return undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let i: number;
      while ((i = buffer.search(/\r\n|\n|\r/)) >= 0) {
        const l = buffer.slice(0, i);
        buffer = buffer.slice(i + (buffer.startsWith('\r\n', i) ? 2 : 1));
        const out = line(l);
        if (out === '[DONE]') return;
        if (out !== undefined && out !== null) yield out;
      }
      if (done) break;
    }
    if (buffer !== '') line(buffer);
    const last = line('');
    if (last !== undefined && last !== null && last !== '[DONE]') yield last;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
