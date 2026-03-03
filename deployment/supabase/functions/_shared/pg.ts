import {
  Client,
  Pool,
} from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import type { PoolClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const POOL_SIZE = 3;

let _pool: Pool | null = null;

function getPgUrl(): string {
  const url =
    Deno.env.get("POSTGRES_POOLER_URL") ?? Deno.env.get("POSTGRES_URL");
  if (!url) {
    throw new Error("POSTGRES_POOLER_URL is required for direct PG access");
  }
  return url;
}

/** Get or create the global connection pool (lazy, size 3). */
export function getPgPool(): Pool {
  if (!_pool) {
    _pool = new Pool(getPgUrl(), POOL_SIZE, true /* lazy */);
  }
  return _pool;
}

/** Acquire a client from the global pool. Caller MUST call client.release() when done. */
export async function acquirePgClient(): Promise<PoolClient> {
  return await getPgPool().connect();
}

/** @deprecated Use acquirePgClient() instead. Kept for test compatibility. */
export function createPgClient(): Client {
  return new Client(getPgUrl());
}

/** @deprecated Pool clients do not need cleanup. Kept for test compatibility. */
export async function connectWithCleanup(pg: Client): Promise<void> {
  await pg.connect();
  try {
    await pg.queryObject("DEALLOCATE ALL");
  } catch (err) {
    console.debug("pg.deallocate_all.ignored", err);
  }
}
