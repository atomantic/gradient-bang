import {
  buildCorporationMap,
  combatantsAreFriendly,
  type CorporationMap,
} from "./friendly"
import type {
  CombatEncounterState,
  CombatantAction,
  CombatantState,
  RoundActionState,
} from "./types"

// Ported from `deployment/supabase/functions/_shared/combat_garrison.ts`.
// Slice 4 adds corp-aware friendly checks. Slice 5 adds full toll-mode handling
// (demand round → attack if unpaid, brace if paid; toll_registry on context).

function calculateCommit(mode: string, fighters: number): number {
  if (fighters <= 0) return 0
  const normalized = mode?.toLowerCase() ?? "offensive"
  if (normalized === "defensive") {
    return Math.max(1, Math.min(fighters, Math.max(25, Math.floor(fighters / 4))))
  }
  if (normalized === "toll") {
    return Math.max(1, Math.min(fighters, Math.max(50, Math.floor(fighters / 3))))
  }
  return Math.max(1, Math.min(fighters, Math.max(50, Math.floor(fighters / 2))))
}

function selectStrongestTarget(
  encounter: CombatEncounterState,
  garrison: CombatantState,
  corps: CorporationMap,
): CombatantState | null {
  const candidates = Object.values(encounter.participants).filter((p) => {
    if (p.combatant_type !== "character") return false
    if (p.combatant_id === garrison.combatant_id) return false
    if (p.fighters <= 0) return false
    if (combatantsAreFriendly(corps, p, garrison)) return false
    if (p.is_escape_pod) return false
    return true
  })
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    if (a.fighters !== b.fighters) return b.fighters - a.fighters
    if (a.shields !== b.shields) return b.shields - a.shields
    return a.combatant_id.localeCompare(b.combatant_id)
  })
  return candidates[0]
}

export interface TollRegistryEntry {
  owner_id?: string | null
  toll_amount: number
  toll_balance: number
  target_id?: string | null
  paid?: boolean
  paid_round?: number | null
  demand_round: number
  payments?: Array<{ payer: string; amount: number; round: number }>
}

export function ensureTollRegistry(
  encounter: CombatEncounterState,
): Record<string, TollRegistryEntry> {
  if (!encounter.context || typeof encounter.context !== "object") {
    encounter.context = {}
  }
  const ctx = encounter.context as Record<string, unknown>
  const existing = ctx.toll_registry
  if (existing && typeof existing === "object") {
    return existing as Record<string, TollRegistryEntry>
  }
  const created: Record<string, TollRegistryEntry> = {}
  ctx.toll_registry = created
  return created
}

function buildTollAction(
  encounter: CombatEncounterState,
  participant: CombatantState,
  corps: CorporationMap,
  now: () => number,
): RoundActionState {
  const registry = ensureTollRegistry(encounter)
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>

  const existingEntry = registry[participant.combatant_id]
  const entry: TollRegistryEntry = existingEntry ?? {
    owner_id: participant.owner_character_id,
    toll_amount: typeof metadata.toll_amount === "number" ? metadata.toll_amount : 0,
    toll_balance: typeof metadata.toll_balance === "number" ? metadata.toll_balance : 0,
    demand_round: encounter.round,
  }
  registry[participant.combatant_id] = entry

  // Pick target: prefer the initiator if hostile, else strongest hostile.
  if (!entry.target_id) {
    const initiatorId =
      typeof encounter.context?.initiator === "string"
        ? (encounter.context.initiator as string)
        : null
    const initiator = initiatorId ? encounter.participants[initiatorId] : undefined
    if (
      initiator &&
      initiator.combatant_type === "character" &&
      initiator.fighters > 0 &&
      (initiator.owner_character_id ?? initiator.combatant_id) !== participant.owner_character_id &&
      !combatantsAreFriendly(corps, initiator, participant) &&
      !initiator.is_escape_pod
    ) {
      entry.target_id = initiator.combatant_id
    } else {
      const fallback = selectStrongestTarget(encounter, participant, corps)
      entry.target_id = fallback ? fallback.combatant_id : null
    }
  }

  const targetState = entry.target_id ? encounter.participants[entry.target_id] : null
  const targetAvailable = Boolean(targetState && targetState.fighters > 0)
  const demandRound = entry.demand_round ?? encounter.round
  const alreadyPaid = Boolean(entry.paid)

  let action: CombatantAction = "brace"
  let commit = 0
  let targetId: string | null = null

  if (alreadyPaid && (!entry.paid_round || entry.paid_round <= encounter.round)) {
    action = "brace"
  } else if (!alreadyPaid && targetAvailable) {
    if (encounter.round === demandRound) {
      // Round 1 in toll mode: stand off; payment window.
      action = "brace"
    } else {
      // Round 2+ without payment: escalate to full-strength attack.
      action = "attack"
      commit = participant.fighters
      targetId = targetState?.combatant_id ?? null
    }
  }

  return {
    action,
    commit,
    timed_out: false,
    target_id: targetId,
    destination_sector: null,
    submitted_at: new Date(now()).toISOString(),
  }
}

export function buildGarrisonActions(
  encounter: CombatEncounterState,
  now: () => number,
): Record<string, RoundActionState> {
  const actions: Record<string, RoundActionState> = {}
  const corps = buildCorporationMap(encounter)

  for (const participant of Object.values(encounter.participants)) {
    if (participant.combatant_type !== "garrison") continue
    if ((participant.fighters ?? 0) <= 0) continue

    const metadata = (participant.metadata ?? {}) as Record<string, unknown>
    const mode = String(metadata.mode ?? "offensive").toLowerCase()

    if (mode === "toll") {
      actions[participant.combatant_id] = buildTollAction(encounter, participant, corps, now)
      continue
    }

    const commit = calculateCommit(mode, participant.fighters)
    const target = selectStrongestTarget(encounter, participant, corps)
    const submittedAt = new Date(now()).toISOString()
    if (!commit || !target) {
      actions[participant.combatant_id] = {
        action: "brace",
        commit: 0,
        timed_out: false,
        target_id: null,
        destination_sector: null,
        submitted_at: submittedAt,
      }
      continue
    }
    actions[participant.combatant_id] = {
      action: "attack",
      commit,
      timed_out: false,
      target_id: target.combatant_id,
      destination_sector: null,
      submitted_at: submittedAt,
    }
  }
  return actions
}
