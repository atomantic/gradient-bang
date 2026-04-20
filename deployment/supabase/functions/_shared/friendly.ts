/**
 * Friendly-ship checks for combat code.
 *
 * Combat (attacking, auto-engaging, targeting) uses a stricter "is this
 * person on my side?" rule than garrison authorization or ship piloting.
 * Two entities are FRIENDLY when any of the following holds:
 *
 *   1. They are the same character (same `character_id` / `owner_character_id`).
 *   2. They belong to the same corporation — this covers both real players in
 *      the corp AND corporation-owned ship pseudo-characters.
 *
 * This file is the single source of truth for that rule inside combat code.
 * Other domains (garrison transactions, actor authorization, event visibility)
 * have their own narrower or different semantics and deliberately do NOT go
 * through this helper.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getEffectiveCorporationId } from "./corporations.ts";
import type {
  CombatantState,
  CombatEncounterState,
} from "./combat_types.ts";

/**
 * owner_character_id / combatant_id → corp_id (null if not in a corp).
 *
 * For corp-owned ships the key is the ship's pseudo-character id and the
 * value is the corp's id. For human players it's the player's character_id.
 */
export type CorporationMap = Map<string, string | null>;

/**
 * Async friendly check. Use on request-entry paths where DB access is fine.
 * Pass the same id as both `character_id` and `ship_id` when checking a
 * pseudo-character (corp-owned ship) — the helper falls back to
 * `ship_instances.owner_corporation_id` in that case.
 */
export async function areFriendly(
  supabase: SupabaseClient,
  a: { character_id: string | null; ship_id?: string | null },
  b: { character_id: string | null; ship_id?: string | null },
): Promise<boolean> {
  if (a.character_id && b.character_id && a.character_id === b.character_id) {
    return true;
  }
  const [ca, cb] = await Promise.all([
    a.character_id
      ? getEffectiveCorporationId(supabase, a.character_id, a.ship_id)
      : Promise.resolve(null),
    b.character_id
      ? getEffectiveCorporationId(supabase, b.character_id, b.ship_id)
      : Promise.resolve(null),
  ]);
  return Boolean(ca && cb && ca === cb);
}

/**
 * Synchronous friendly check for use inside combat round resolution (no DB
 * access). Relies on a pre-built CorporationMap — see {@link buildCorporationMap}.
 */
export function areFriendlyFromMeta(
  corps: CorporationMap,
  a: { owner_character_id?: string | null; combatant_id: string },
  b: { owner_character_id?: string | null; combatant_id: string },
): boolean {
  const keyA = a.owner_character_id ?? a.combatant_id;
  const keyB = b.owner_character_id ?? b.combatant_id;
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  const corpA = corps.get(keyA) ?? null;
  const corpB = corps.get(keyB) ?? null;
  return Boolean(corpA && corpB && corpA === corpB);
}

/**
 * Build a CorporationMap from an encounter's in-memory participants.
 * Characters contribute `metadata.corporation_id`; garrisons contribute
 * `metadata.owner_corporation_id`. Both are populated at combat load time
 * by `loadCharacterCombatants` / `loadGarrisonCombatants` in
 * `_shared/combat_participants.ts`.
 */
export function buildCorporationMap(
  encounter: CombatEncounterState,
): CorporationMap {
  const map: CorporationMap = new Map();
  for (const participant of Object.values(encounter.participants)) {
    const metadata = participant.metadata as
      | Record<string, unknown>
      | undefined;
    if (participant.combatant_type === "character") {
      const corpId =
        typeof metadata?.corporation_id === "string"
          ? (metadata.corporation_id as string)
          : null;
      const key = participant.owner_character_id ?? participant.combatant_id;
      // Characters are authoritative for their own corp_id. Don't overwrite
      // with a later garrison entry that might be null.
      if (!map.has(key)) {
        map.set(key, corpId);
      } else if (corpId && !map.get(key)) {
        map.set(key, corpId);
      }
    } else if (
      participant.combatant_type === "garrison" &&
      participant.owner_character_id
    ) {
      const ownerCorpId =
        typeof metadata?.owner_corporation_id === "string"
          ? (metadata.owner_corporation_id as string)
          : null;
      const key = participant.owner_character_id;
      if (!map.has(key) || (ownerCorpId && !map.get(key))) {
        map.set(key, ownerCorpId);
      }
    }
  }
  return map;
}

/**
 * Convenience wrapper: friendly check between two combatants in a resolved
 * encounter. Accepts raw CombatantState objects as seen in pending_actions,
 * selectStrongestTarget filters, etc.
 */
export function combatantsAreFriendly(
  corps: CorporationMap,
  a: CombatantState,
  b: CombatantState,
): boolean {
  return areFriendlyFromMeta(corps, a, b);
}
