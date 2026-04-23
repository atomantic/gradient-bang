import type { CombatEncounterState, CombatantState } from "./types"

// Ported from `deployment/supabase/functions/_shared/friendly.ts`.
// Synchronous flavour only — the harness has no async DB layer to wrap.

export type CorporationMap = Map<string, string | null>

/**
 * Friendly iff:
 *   1. Same owner_character_id (covers self and corp-ship pseudos).
 *   2. Same effective corp id via the supplied CorporationMap.
 */
export function areFriendlyFromMeta(
  corps: CorporationMap,
  a: { owner_character_id?: string | null; combatant_id: string },
  b: { owner_character_id?: string | null; combatant_id: string },
): boolean {
  const keyA = a.owner_character_id ?? a.combatant_id
  const keyB = b.owner_character_id ?? b.combatant_id
  if (!keyA || !keyB) return false
  if (keyA === keyB) return true
  const corpA = corps.get(keyA) ?? null
  const corpB = corps.get(keyB) ?? null
  return Boolean(corpA && corpB && corpA === corpB)
}

/**
 * Build a CorporationMap from an encounter's in-memory participants.
 * Characters contribute `metadata.corporation_id`; garrisons contribute
 * `metadata.owner_corporation_id`.
 */
export function buildCorporationMap(encounter: CombatEncounterState): CorporationMap {
  const map: CorporationMap = new Map()
  for (const participant of Object.values(encounter.participants)) {
    const metadata = participant.metadata as Record<string, unknown> | undefined
    if (participant.combatant_type === "character") {
      const corpId =
        typeof metadata?.corporation_id === "string" ? (metadata.corporation_id as string) : null
      const key = participant.owner_character_id ?? participant.combatant_id
      if (!map.has(key)) {
        map.set(key, corpId)
      } else if (corpId && !map.get(key)) {
        map.set(key, corpId)
      }
    } else if (
      participant.combatant_type === "garrison" &&
      participant.owner_character_id
    ) {
      const ownerCorpId =
        typeof metadata?.owner_corporation_id === "string"
          ? (metadata.owner_corporation_id as string)
          : null
      const key = participant.owner_character_id
      if (!map.has(key) || (ownerCorpId && !map.get(key))) {
        map.set(key, ownerCorpId)
      }
    }
  }
  return map
}

export function combatantsAreFriendly(
  corps: CorporationMap,
  a: CombatantState,
  b: CombatantState,
): boolean {
  return areFriendlyFromMeta(corps, a, b)
}
