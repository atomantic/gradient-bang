import type {
  CombatEncounterState,
  CombatRoundLog,
  CombatRoundOutcome,
  CombatantState,
  RoundActionState,
} from "./types"

// Ported from `deployment/supabase/functions/_shared/combat_events.ts`.
// Per-viewer ship injection (buildCombatEndedPayloadForViewer) lives on the
// engine class since it needs world-state access.

interface ParticipantCtx {
  shieldIntegrity: number
  shieldDamage?: number
  fighterLoss?: number
}

function basePayload(encounter: CombatEncounterState): Record<string, unknown> {
  return {
    combat_id: encounter.combat_id,
    sector: { id: encounter.sector_id },
    round: encounter.round,
  }
}

function isoOrNull(msOrNull: number | null): string | null {
  return msOrNull != null ? new Date(msOrNull).toISOString() : null
}

function computeShieldIntegrity(state: CombatantState): number {
  const maxShields = Math.max(0, state.max_shields ?? 0)
  const shields = Math.max(0, state.shields ?? 0)
  if (maxShields <= 0) return 0
  return (shields / maxShields) * 100
}

function buildParticipantPayload(
  participant: CombatantState,
  ctx: ParticipantCtx,
): Record<string, unknown> {
  if (participant.combatant_type !== "character") return {}
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>
  const fighters = Math.max(0, participant.fighters ?? 0)
  const destroyed = fighters <= 0
  const shipPayload = {
    ship_type: participant.ship_type ?? metadata.ship_type ?? "unknown",
    ship_name: metadata.ship_name ?? participant.name,
    shield_integrity: Number.isFinite(ctx.shieldIntegrity)
      ? Number(ctx.shieldIntegrity.toFixed(1))
      : 0,
    shield_damage:
      ctx.shieldDamage && ctx.shieldDamage !== 0 ? Number(ctx.shieldDamage.toFixed(1)) : null,
    fighter_loss: ctx.fighterLoss && ctx.fighterLoss > 0 ? ctx.fighterLoss : null,
  }
  return {
    id: participant.combatant_id,
    name: participant.name,
    player_type: (metadata.player_type as string) ?? "human",
    ship_id: typeof metadata.ship_id === "string" ? metadata.ship_id : null,
    ship: shipPayload,
    // Harness enhancements beyond production's payload. Production keeps
    // these internal; the harness surfaces them so agent-facing XML can
    // signal "don't target this ship" and so debug UIs can render the
    // correct badge.
    //   - corp_id: corp-mate detection in event_xml.ts
    //   - fighters: absolute count (production exposes only fighter_loss,
    //     which doesn't tell an LLM whether the target is still alive)
    //   - destroyed: boolean convenience — true when fighters <= 0, which
    //     keeps combat going for other factions but makes this participant
    //     a no-op target. Without this, agents will happily attack a
    //     corpse round after round (observed in live sessions).
    corp_id: typeof metadata.corporation_id === "string" ? metadata.corporation_id : null,
    fighters,
    destroyed,
  }
}

function buildGarrisonPayload(
  participant: CombatantState,
  fighterLoss = 0,
): Record<string, unknown> {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>
  const ownerName =
    typeof metadata.owner_name === "string"
      ? metadata.owner_name
      : (participant.owner_character_id ?? participant.combatant_id)
  return {
    id: participant.combatant_id,
    name: participant.name,
    owner_name: ownerName,
    // Harness enhancement: surface owner identity so the agent-facing XML
    // can mark a garrison as (yours) / [ally — your corp] / [opponent].
    // Production omits these from the payload; production's LLM infers
    // ownership from context or the bespoke voice prompt. For the harness
    // we'd rather be explicit.
    owner_character_id: participant.owner_character_id ?? null,
    owner_corp_id:
      typeof metadata.owner_corporation_id === "string"
        ? metadata.owner_corporation_id
        : null,
    fighters: participant.fighters,
    fighter_loss: fighterLoss > 0 ? fighterLoss : null,
    mode: metadata.mode ?? "offensive",
    toll_amount: metadata.toll_amount ?? 0,
    deployed_at: metadata.deployed_at ?? null,
  }
}

function garrisonSortKey(participant: CombatantState): [number, string] {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>
  const deployedRaw = metadata.deployed_at
  const ms =
    typeof deployedRaw === "string" ? Date.parse(deployedRaw) : NaN
  const sortMs = Number.isFinite(ms) ? ms : -1
  return [sortMs, participant.combatant_id]
}

function selectPrimaryGarrison(garrisons: CombatantState[]): CombatantState | null {
  if (garrisons.length === 0) return null
  const ordered = [...garrisons].sort((a, b) => {
    const [aTime, aId] = garrisonSortKey(a)
    const [bTime, bId] = garrisonSortKey(b)
    if (aTime !== bTime) return bTime - aTime
    return aId.localeCompare(bId)
  })
  return ordered[0]
}

export function buildRoundWaitingPayload(encounter: CombatEncounterState): Record<string, unknown> {
  const participants: Record<string, unknown>[] = []
  const garrisonStates: CombatantState[] = []
  for (const participant of Object.values(encounter.participants)) {
    if (participant.combatant_type === "character") {
      const shieldIntegrity = computeShieldIntegrity(participant)
      participants.push(buildParticipantPayload(participant, { shieldIntegrity }))
    } else if (participant.combatant_type === "garrison") {
      garrisonStates.push(participant)
    }
  }
  const primary = selectPrimaryGarrison(garrisonStates)
  const payload: Record<string, unknown> = {
    ...basePayload(encounter),
    current_time: new Date().toISOString(),
    deadline: isoOrNull(encounter.deadline),
    participants,
    garrison: primary ? buildGarrisonPayload(primary) : null,
  }
  if (encounter.round === 1 && typeof encounter.context?.initiator === "string") {
    const initiatorId = encounter.context.initiator as string
    const participant = encounter.participants[initiatorId]
    payload.initiator = participant?.name ?? initiatorId
  }
  return payload
}

export function buildRoundResolvedPayload(
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  actions?: Record<string, RoundActionState>,
): Record<string, unknown> {
  const participants: Record<string, unknown>[] = []
  const garrisonCandidates: Array<{ state: CombatantState; fighterLoss: number }> = []

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    const fightersStart = participant.fighters ?? 0
    const fightersRemaining = outcome.fighters_remaining?.[pid] ?? fightersStart
    const fighterLoss = Math.max(0, fightersStart - fightersRemaining)

    if (participant.combatant_type === "character") {
      const maxShields = Math.max(0, participant.max_shields ?? participant.shields ?? 0)
      const shieldsStart = participant.shields ?? maxShields
      const shieldsRemaining = outcome.shields_remaining?.[pid] ?? shieldsStart
      const shieldDamagePercent =
        maxShields > 0 ? ((shieldsStart - shieldsRemaining) / maxShields) * 100 : 0
      const shieldIntegrity = maxShields > 0 ? (shieldsRemaining / maxShields) * 100 : 0
      participants.push(
        buildParticipantPayload(participant, {
          shieldIntegrity,
          shieldDamage: shieldDamagePercent,
          fighterLoss,
        }),
      )
    } else if (participant.combatant_type === "garrison") {
      garrisonCandidates.push({ state: participant, fighterLoss })
    }
  }

  const primary = selectPrimaryGarrison(garrisonCandidates.map((g) => g.state))
  const primaryLoss = primary
    ? garrisonCandidates.find((g) => g.state.combatant_id === primary.combatant_id)?.fighterLoss ?? 0
    : 0
  const garrisonBlock = primary ? buildGarrisonPayload(primary, primaryLoss) : null

  const payload: Record<string, unknown> = {
    ...basePayload(encounter),
    hits: outcome.hits,
    offensive_losses: outcome.offensive_losses,
    defensive_losses: outcome.defensive_losses,
    shield_loss: outcome.shield_loss,
    damage_mitigated: outcome.damage_mitigated,
    fighters_remaining: outcome.fighters_remaining,
    shields_remaining: outcome.shields_remaining,
    flee_results: outcome.flee_results,
    end: outcome.end_state,
    result: outcome.end_state,
    deadline: isoOrNull(encounter.deadline),
    round_result: outcome.end_state,
    participants,
    garrison: garrisonBlock,
  }

  if (actions) {
    const actionsMap: Record<string, unknown> = {}
    for (const [pid, action] of Object.entries(actions)) {
      const participant = encounter.participants[pid]
      const key = participant?.name ?? pid
      actionsMap[key] = {
        action: action.action ?? "brace",
        commit: action.commit ?? 0,
        timed_out: action.timed_out ?? false,
        submitted_at: action.submitted_at ?? new Date().toISOString(),
        target: action.target_id ?? null,
        destination_sector: action.destination_sector ?? null,
      }
    }
    payload.actions = actionsMap
  }

  return payload
}

export function buildCombatEndedPayload(
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  logs: CombatRoundLog[],
): Record<string, unknown> {
  const payload = buildRoundResolvedPayload(encounter, outcome)
  payload.salvage = []
  payload.logs = logs
  return payload
}

export function collectParticipantIds(encounter: CombatEncounterState): string[] {
  const ids = new Set<string>()
  for (const participant of Object.values(encounter.participants)) {
    if (participant.combatant_type !== "character") continue
    const key = participant.owner_character_id ?? participant.combatant_id
    ids.add(key)
  }
  return Array.from(ids)
}
