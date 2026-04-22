import { CombatEngine } from "../engine"
import { InMemoryEmitter } from "../emitter"
import {
  characterId as characterIdBrand,
  combatId as combatIdBrand,
  type CharacterId,
  type CombatEncounterState,
  type CombatEvent,
  type CombatId,
  type SectorId,
  type World,
} from "../types"

// Seeded LCG — identical output for a given seed across runs and machines.
// Used instead of Math.random so test outcomes are reproducible.
export function deterministicRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export interface TestHarness {
  engine: CombatEngine
  emitter: InMemoryEmitter
  advance: (ms: number) => void
  getNow: () => number
  /** Find the (single) active combat in a sector, if any. */
  activeCombatIn: (sector: SectorId) => CombatEncounterState | null
  /** Get a CombatId by sector — throws if none exists. */
  combatIdIn: (sector: SectorId) => CombatId
  /** Convenience: return the current World snapshot. */
  world: () => World
}

export function makeHarness(seed = 1, startMs = 1_700_000_000_000): TestHarness {
  let current = startMs
  const emitter = new InMemoryEmitter()
  const engine = new CombatEngine({
    emitter,
    now: () => current,
    rng: deterministicRng(seed),
  })
  return {
    engine,
    emitter,
    advance: (ms: number) => {
      current += ms
    },
    getNow: () => current,
    activeCombatIn: (sector: SectorId) => {
      const w = engine.getWorldSnapshot()
      for (const e of w.activeCombats.values()) {
        if (!e.ended && e.sector_id === sector) return e
      }
      return null
    },
    combatIdIn: (sector: SectorId) => {
      const w = engine.getWorldSnapshot()
      for (const e of w.activeCombats.values()) {
        if (e.sector_id === sector) return e.combat_id as CombatId
      }
      throw new Error(`No combat in sector ${sector}`)
    },
    world: () => engine.getWorldSnapshot(),
  }
}

// ---- Helpers for asserting on the event log ----

export function eventTypes(emitter: InMemoryEmitter): string[] {
  return emitter.getLog().map((e) => e.type)
}

export function eventsOfType(emitter: InMemoryEmitter, type: string): CombatEvent[] {
  return emitter.getLog().filter((e) => e.type === type)
}

export function lastOfType(emitter: InMemoryEmitter, type: string): CombatEvent | undefined {
  const log = emitter.getLog()
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === type) return log[i]
  }
  return undefined
}

export function payloadOf(event: CombatEvent | undefined): Record<string, unknown> {
  return (event?.payload as Record<string, unknown>) ?? {}
}

export function recipientsOf(event: CombatEvent | undefined): string[] {
  return [...(event?.recipients ?? [])].sort()
}

// Cast a raw string into the branded IDs the engine expects. Tests use
// these at the API boundary where compile-time branding would otherwise
// force a lot of noisy casts.
export function asCharacterId(s: string): CharacterId {
  return characterIdBrand(s)
}

export function asCombatId(s: string): CombatId {
  return combatIdBrand(s)
}
