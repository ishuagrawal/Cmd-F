import {
  EventSchema,
  StateSchema,
  type SearchState,
  type SearchRequest,
  type PageSnapshot,
} from '../../../../packages/contracts/src';
export function normalizeSearchState(state: SearchState): SearchState {
  if (state.lifecycle !== 'waiting_for_user' || state.requestedSections.length) return state;
  return {
    ...state,
    lifecycle: 'completed',
    message: 'No verified source found in the pages checked.',
    coverage: { ...state.coverage, stopReason: 'manual_inspection_unsupported' },
  };
}
export class Api {
  constructor(
    readonly base: string,
    private token: string,
  ) {}
  async call(path: string, method = 'GET', body?: unknown) {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    }).catch(() => {
      throw new Error(
        'The local search service is unavailable. Start pnpm dev:api, then reconnect in settings.',
      );
    });
    if (!r.ok)
      throw new Error(
        r.status === 401
          ? 'Connection token is missing or incorrect. Open Connection settings.'
          : r.status === 404
            ? 'This search expired. Start a new search.'
            : r.status === 429
              ? 'Too many active searches. Stop a search and try again.'
              : 'The search service rejected this request. Please try again.',
      );
    return r.json();
  }
  async create(request: SearchRequest) {
    return normalizeSearchState(
      StateSchema.parse(await this.call('/v1/searches', 'POST', request)),
    );
  }
  async resume(id: string, snapshot: PageSnapshot) {
    return StateSchema.parse(await this.call(`/v1/searches/${id}/snapshot`, 'POST', snapshot));
  }
  async events(id: string, signal: AbortSignal, onState: (state: SearchState) => void) {
    let cursor = 0;
    for (let retry = 0; retry < 3; retry++) {
      signal.throwIfAborted();
      try {
        const response = await fetch(`${this.base}/v1/searches/${id}/events`, {
          headers: { Authorization: `Bearer ${this.token}`, 'Last-Event-ID': String(cursor) },
          signal,
        });
        if (!response.ok || !response.body) throw new Error('Search event connection failed.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 1_000_000) throw new Error('Event too large');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = block.split('\n').find((l) => l.startsWith('data: '));
              if (!data) continue;
              const event = EventSchema.parse(JSON.parse(data.slice(6)));
              if (event.searchId !== id || event.id <= cursor) continue;
              cursor = event.id;
              const state = normalizeSearchState(event.state);
              onState(state);
              if (state !== event.state)
                void this.call(`/v1/searches/${id}/cancel`, 'POST').catch(() => {});
              if (['completed', 'cancelled', 'failed'].includes(state.lifecycle)) return;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (retry === 2)
          throw new Error('Connection interrupted. Reconnect to recover this search.', {
            cause: error,
          });
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (retry + 1)));
    }
  }
  close(id: string) {
    return fetch(`${this.base}/v1/searches/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` },
      keepalive: true,
    }).catch(() => {});
  }
}
