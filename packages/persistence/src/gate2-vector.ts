import Database from 'better-sqlite3';

export interface ScopedVectorMatch {
  memoryId: string;
  distance: number;
}

/** Vector scoring only runs after SQL materializes the exact active Teammate scope. */
export const SCOPED_VECTOR_QUERY = `
  WITH scoped AS MATERIALIZED (
    SELECT id, updated_at FROM memories INDEXED BY memories_owner_scope_idx
    WHERE owner_type = 'TEAMMATE' AND owner_id = ? AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > ?)
  )
  SELECT scoped.id AS memory_id,
         vec_distance_cosine(e.embedding, ?) AS distance
  FROM scoped
  CROSS JOIN memory_embeddings AS e ON e.memory_id = scoped.id
  WHERE e.runtime_profile_id = ? AND e.model_id = ? AND e.dimension = ?
    AND e.updated_at >= scoped.updated_at
  ORDER BY distance ASC, scoped.id
  LIMIT ?
`;

function blob(vector: readonly number[]): Buffer {
  if (
    vector.length < 1 ||
    vector.length > 4_096 ||
    vector.some((number) => !Number.isFinite(number)) ||
    vector.every((number) => number === 0)
  ) {
    throw new Error('Invalid embedding vector');
  }
  return Buffer.from(new Float32Array(vector).buffer);
}

export class Gate2VectorRepository {
  constructor(
    private readonly db: Database.Database,
    readonly available: boolean,
  ) {}

  getRuntimeProfileId(): string | null {
    const row = this.db
      .prepare('SELECT runtime_profile_id FROM embedding_settings WHERE id = 1')
      .get() as { runtime_profile_id: string | null };
    return row.runtime_profile_id;
  }

  setRuntimeProfileId(runtimeProfileId: string | null): void {
    this.db
      .prepare('UPDATE embedding_settings SET runtime_profile_id = ?, updated_at = ? WHERE id = 1')
      .run(runtimeProfileId, new Date().toISOString());
  }

  saveEmbedding(input: {
    memoryId: string;
    runtimeProfileId: string;
    modelId: string;
    contentHash: string;
    vector: readonly number[];
  }): void {
    const embedding = blob(input.vector);
    this.db
      .prepare(
        `INSERT INTO memory_embeddings
           (memory_id, runtime_profile_id, model_id, content_hash, dimension, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, runtime_profile_id) DO UPDATE SET
           model_id=excluded.model_id, content_hash=excluded.content_hash,
           dimension=excluded.dimension, embedding=excluded.embedding,
           updated_at=excluded.updated_at`,
      )
      .run(
        input.memoryId,
        input.runtimeProfileId,
        input.modelId,
        input.contentHash,
        input.vector.length,
        embedding,
        new Date().toISOString(),
      );
  }

  deleteMemoryEmbeddings(memoryId: string): void {
    this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
  }

  hasCurrentEmbedding(
    memoryId: string,
    runtimeProfileId: string,
    modelId: string,
    contentHash: string,
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM memory_embeddings
           WHERE memory_id = ? AND runtime_profile_id = ? AND model_id = ? AND content_hash = ?`,
        )
        .get(memoryId, runtimeProfileId, modelId, contentHash),
    );
  }

  hasScopedEmbeddings(teammateId: string, runtimeProfileId: string, modelId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `WITH scoped AS MATERIALIZED (
             SELECT id, updated_at FROM memories INDEXED BY memories_owner_scope_idx
             WHERE owner_type = 'TEAMMATE' AND owner_id = ? AND status = 'ACTIVE'
               AND (expires_at IS NULL OR expires_at > ?)
           )
           SELECT 1 FROM scoped
           CROSS JOIN memory_embeddings AS e ON e.memory_id = scoped.id
           WHERE e.runtime_profile_id = ? AND e.model_id = ?
             AND e.updated_at >= scoped.updated_at LIMIT 1`,
        )
        .get(teammateId, new Date().toISOString(), runtimeProfileId, modelId),
    );
  }

  searchScoped(input: {
    teammateId: string;
    runtimeProfileId: string;
    modelId: string;
    vector: readonly number[];
    limit: number;
  }): ScopedVectorMatch[] {
    if (!this.available) return [];
    const rows = this.db
      .prepare(SCOPED_VECTOR_QUERY)
      .all(
        input.teammateId,
        new Date().toISOString(),
        blob(input.vector),
        input.runtimeProfileId,
        input.modelId,
        input.vector.length,
        Math.max(0, Math.min(20, Math.floor(input.limit))),
      ) as Array<{ memory_id: string; distance: number }>;
    return rows
      .filter((row) => Number.isFinite(row.distance))
      .map((row) => ({ memoryId: row.memory_id, distance: row.distance }));
  }
}
