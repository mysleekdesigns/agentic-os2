/**
 * Runtime-detected storage capabilities.
 *
 * Other Agent OS subsystems (memory, semantic search, embeddings) consult
 * this to decide whether vector search is available. We do NOT mutate
 * `agent-os.config.yaml` from here — that wiring is done by higher layers.
 *
 * PRD §2.4 / Phase 1: "semantic search marked disabled in capabilities" when
 * the sqlite-vec extension isn't available.
 */

import type { AgentOsDb } from './db.js';
import { tryLoadVec } from './vec.js';

export interface StorageCapabilities {
  /** True only if sqlite-vec successfully loaded into the connection. */
  semantic_search: boolean;
  /** Populated when `semantic_search` is false. */
  vec_reason?: string;
}

/**
 * Probe the given database for optional capabilities.
 *
 * Side-effect: this call attempts to load sqlite-vec into the connection if
 * it isn't already loaded — that's intentional, so capabilities reflect
 * what the connection can do *right now*.
 */
export async function detectCapabilities(db: AgentOsDb): Promise<StorageCapabilities> {
  const vec = await tryLoadVec(db);
  if (vec.available) {
    return { semantic_search: true };
  }
  return {
    semantic_search: false,
    vec_reason: vec.reason,
  };
}
