import type { WeKnoraClient } from './weknora-worker.js';

export interface CitationTarget {
  knowledgeId: string;
  knowledgeBaseId: string;
}

const MAX_CHUNK_IDS = 50;

export class WeKnoraCitationResolver {
  private readonly cache = new Map<string, CitationTarget>();
  private readonly inflight = new Map<string, Promise<CitationTarget | null>>();

  constructor(private readonly client: WeKnoraClient) {}

  async resolve(chunkIds: string[]): Promise<Record<string, CitationTarget>> {
    const unique = [...new Set(chunkIds.filter(Boolean))].slice(0, MAX_CHUNK_IDS);
    const results = await Promise.all(unique.map((chunkId) => this.lookup(chunkId)));
    const citations: Record<string, CitationTarget> = {};
    unique.forEach((chunkId, index) => {
      const target = results[index];
      if (target) citations[chunkId] = target;
    });
    return citations;
  }

  private lookup(chunkId: string): Promise<CitationTarget | null> {
    const cached = this.cache.get(chunkId);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(chunkId);
    if (pending) return pending;

    const request = this.client
      .getChunk(chunkId)
      .then((target) => {
        if (target) this.cache.set(chunkId, target);
        return target;
      })
      .catch(() => null)
      .finally(() => {
        this.inflight.delete(chunkId);
      });
    this.inflight.set(chunkId, request);
    return request;
  }
}
