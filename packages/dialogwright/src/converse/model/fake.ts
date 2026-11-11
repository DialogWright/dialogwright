import type { ConverseModel, ModelEvent, ModelRequest } from './types';

/** A model that answers each request with the next scripted turn of events; for tests (never a real call). `requests` keeps what it was asked. */
export function fakeModel(turns: ModelEvent[][]): ConverseModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let next = 0;
  return {
    id: 'fake',
    requests,
    async *stream(req): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(req));
      const turn = turns[next++];
      if (turn === undefined) {
        yield { type: 'error', kind: 'http', detail: 'the fake model has no more scripted turns' };
        return;
      }
      yield* turn;
    },
  };
}
