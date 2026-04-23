import type { CombatEvent } from "../engine/types"

// Ports the combat-event summary functions from
// `src/gradientbang/pipecat_server/subagents/event_relay.py` (_summarize_* +
// the XML envelope at relay line 1184):
//   <event name="{event_name}" combat_id="{combat_id}">{summary}</event>
//
// Harness enhancements over production:
//   - Recognises corp-mate participation so a player's LLM agent sees XML for
//     combat events involving their corp ships, even when the player is not
//     personally in the fight. Framing identifies the corp ship by ship_id +
//     ship_name so the LLM can reason about "which of my ships is engaged".
//   - Handles ship.destroyed + salvage.created for UI/RTVI-style updates.
//   - Participant lines always carry ship_id + ship_name alongside combatant_id.

/** Who is reading this event — used to filter + frame. */
export interface AgentViewerContext {
  characterId: string
  corpId?: string | null
}

const ID_PREFIX_LEN = 8

function shortId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, ID_PREFIX_LEN)
}

function isPlayerParticipant(payload: unknown, characterId: string): boolean {
  if (!payload || typeof payload !== "object") return false
  const participants = (payload as Record<string, unknown>).participants
  if (!Array.isArray(participants)) return false
  return participants.some(
    (p) => p && typeof p === "object" && (p as Record<string, unknown>).id === characterId,
  )
}

interface ParticipantEntry {
  id: string
  name: string
  ship_id: string | null
  ship_type: string
  ship_name: string | null
  shield_integrity: number | null
  fighters: number | null
  destroyed: boolean
  corp_id: string | null
  /** "human" | "corporation_ship" from the payload. */
  player_type: string
  is_self: boolean
  is_corp_mate: boolean
}

function readParticipants(payload: unknown, viewer: AgentViewerContext): ParticipantEntry[] {
  if (!payload || typeof payload !== "object") return []
  const raw = (payload as Record<string, unknown>).participants
  if (!Array.isArray(raw)) return []
  const out: ParticipantEntry[] = []
  for (const p of raw) {
    if (!p || typeof p !== "object") continue
    const pp = p as Record<string, unknown>
    const id = typeof pp.id === "string" ? pp.id : null
    if (!id) continue
    const ship = (pp.ship ?? {}) as Record<string, unknown>
    const corp = typeof pp.corp_id === "string" ? pp.corp_id : null
    const isSelf = id === viewer.characterId
    const isCorpMate =
      !isSelf &&
      typeof viewer.corpId === "string" &&
      viewer.corpId.length > 0 &&
      corp === viewer.corpId
    const fighters =
      typeof pp.fighters === "number" ? pp.fighters : null
    const destroyed =
      typeof pp.destroyed === "boolean"
        ? pp.destroyed
        : fighters != null && fighters <= 0
    out.push({
      id,
      name: typeof pp.name === "string" ? pp.name : id,
      ship_id: typeof pp.ship_id === "string" ? pp.ship_id : null,
      ship_type: typeof ship.ship_type === "string" ? ship.ship_type : "unknown",
      ship_name: typeof ship.ship_name === "string" ? ship.ship_name : null,
      shield_integrity:
        typeof ship.shield_integrity === "number" ? ship.shield_integrity : null,
      fighters,
      destroyed,
      corp_id: corp,
      player_type:
        typeof pp.player_type === "string" ? pp.player_type : "human",
      is_self: isSelf,
      is_corp_mate: isCorpMate,
    })
  }
  return out
}

/** Friendly ships (self + corp-mates) in the combat — what the viewer has skin in the game for. */
function ownSideShips(participants: ParticipantEntry[]): ParticipantEntry[] {
  return participants.filter((p) => p.is_self || p.is_corp_mate)
}

function combatContext(
  payload: Record<string, unknown>,
  participants: ParticipantEntry[],
  viewer: AgentViewerContext,
): string {
  const combatId = payload.combat_id
  const round = payload.round
  const sector =
    payload.sector && typeof payload.sector === "object"
      ? (payload.sector as Record<string, unknown>).id
      : undefined
  const details: string[] = []
  if (typeof round === "number") details.push(`round ${round}`)
  if (typeof combatId === "string" && combatId.trim()) details.push(`combat_id ${combatId}`)
  const suffix = details.length ? ` (${details.join(", ")})` : ""

  const self = participants.find((p) => p.is_self)
  if (self) {
    return `Combat state: you are currently in active combat.${suffix}`
  }
  const corpShips = participants.filter((p) => p.is_corp_mate)
  if (corpShips.length > 0) {
    const names = corpShips
      .map((p) => {
        const nm = p.ship_name ?? p.name
        return p.ship_id ? `${nm} [ship_id=${p.ship_id}]` : nm
      })
      .join(", ")
    return `Combat state: your corp's ${names} is engaged in combat.${suffix}`
  }
  // Absent-owner case: the viewer isn't a combat participant themselves and
  // has no ship in the fight, but they DO own the garrison that's being
  // engaged (or a corp-mate does). Frame the event accordingly so the LLM
  // knows this is their fixed asset under attack, not just noise.
  const ownership = garrisonOwnership(payload, viewer)
  if (ownership === "self") {
    const where = typeof sector === "number" ? ` in sector ${sector}` : ""
    return `Combat state: your garrison${where} is engaged in combat.${suffix}`
  }
  if (ownership === "corp_mate") {
    const where = typeof sector === "number" ? ` in sector ${sector}` : ""
    return `Combat state: your corp's garrison${where} is engaged in combat.${suffix}`
  }
  return `Combat state: this combat event is not your fight.${suffix}`
}

/**
 * Inspect payload.garrison's ownership fields (which the harness enriches
 * in buildGarrisonPayload) and tell the XML filter whether the viewer
 * owns the garrison, a corp-mate does, or it's an opponent's garrison.
 */
function garrisonOwnership(
  payload: Record<string, unknown>,
  viewer: AgentViewerContext,
): "self" | "corp_mate" | "other" {
  const garrison = payload.garrison as Record<string, unknown> | null | undefined
  if (!garrison || typeof garrison !== "object") return "other"
  const ownerCharId =
    typeof garrison.owner_character_id === "string"
      ? garrison.owner_character_id
      : null
  const ownerCorpId =
    typeof garrison.owner_corp_id === "string" ? garrison.owner_corp_id : null
  if (ownerCharId && ownerCharId === viewer.characterId) return "self"
  if (
    ownerCorpId &&
    typeof viewer.corpId === "string" &&
    viewer.corpId.length > 0 &&
    ownerCorpId === viewer.corpId
  )
    return "corp_mate"
  return "other"
}

function participantLine(p: ParticipantEntry): string {
  // Side marker — the single most important piece of tactical context.
  // Without this, a viewer sees four identical-looking sparrow_scouts and
  // has no way to tell which are allies vs opponents.
  const sideMarker = p.is_self
    ? " (you)"
    : p.is_corp_mate
      ? " [ally — your corp]"
      : " [opponent]"

  // Player-type + corp-id suffix: tells the LLM whether the participant
  // is a human-piloted ship or an autonomous corp ship, and which corp
  // they belong to when it isn't your own. Helps spot things like
  // "that autonomous probe shares a corp with the human I'm fighting".
  const typeSuffix = p.player_type === "corporation_ship" ? " (corp ship)" : ""
  let corpSuffix = ""
  if (p.corp_id && !p.is_corp_mate && !p.is_self) {
    const short = p.corp_id.length > 10 ? `${p.corp_id.slice(0, 8)}…` : p.corp_id
    corpSuffix = ` [corp=${short}]`
  }

  const shipInfo =
    p.ship_name && p.ship_name !== p.name
      ? `${p.ship_type} "${p.ship_name}"`
      : p.ship_type
  const shipIdStr = p.ship_id ? ` [ship_id=${p.ship_id}]` : ""

  // Destroyed participants stay in the roster (combat continues for the
  // surviving factions) but are flagged loudly so targeting agents don't
  // waste commits attacking a corpse.
  if (p.destroyed) {
    return `  - ${p.name}${sideMarker}: combatant_id=${p.id}, ${shipInfo}${shipIdStr}${typeSuffix}${corpSuffix} [DESTROYED — do NOT target; attacks will be rejected]`
  }
  const fightersStr =
    typeof p.fighters === "number" ? `, fighters ${p.fighters}` : ""
  const shieldStr =
    typeof p.shield_integrity === "number"
      ? `, shields ${Math.round(p.shield_integrity)}%`
      : ""
  return `  - ${p.name}${sideMarker}: combatant_id=${p.id}, ${shipInfo}${shipIdStr}${typeSuffix}${corpSuffix}${fightersStr}${shieldStr}`
}

function garrisonLine(
  garrison: Record<string, unknown>,
  viewer: AgentViewerContext,
): string {
  const gid = typeof garrison.id === "string" ? garrison.id : "?"
  const gName =
    typeof garrison.name === "string"
      ? garrison.name
      : typeof garrison.owner_name === "string"
        ? garrison.owner_name
        : "Garrison"
  const mode = String(garrison.mode ?? "")
  const fighters = garrison.fighters
  const tollAmt = garrison.toll_amount
  const tollStr = mode === "toll" ? `, toll ${tollAmt}c` : ""
  const ownerCharId =
    typeof garrison.owner_character_id === "string"
      ? garrison.owner_character_id
      : null
  const ownerCorpId =
    typeof garrison.owner_corp_id === "string" ? garrison.owner_corp_id : null
  // Side marker — same convention as participant lines so the LLM can read
  // both in the same glance. Toll-mode garrisons keep the marker because
  // "my-corp's toll garrison" is a legitimate (if weird) scenario.
  let sideMarker: string
  if (ownerCharId && ownerCharId === viewer.characterId) {
    sideMarker = " (yours)"
  } else if (
    ownerCorpId &&
    typeof viewer.corpId === "string" &&
    viewer.corpId.length > 0 &&
    ownerCorpId === viewer.corpId
  ) {
    sideMarker = " [ally — your corp]"
  } else {
    sideMarker = " [opponent]"
  }
  const ownerName =
    typeof garrison.owner_name === "string" ? garrison.owner_name : null
  const ownerStr = ownerName ? `, owner=${ownerName}` : ""
  return `Garrison: ${gName}${sideMarker} id=${gid}, ${fighters} fighters, mode=${mode}${tollStr}${ownerStr}`
}

function summarizeCombatWaiting(event: CombatEvent, viewer: AgentViewerContext): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const participants = readParticipants(payload, viewer)
  let ctx = combatContext(payload, participants, viewer)
  const deadline = payload.deadline
  if (typeof deadline === "string" && deadline.trim()) {
    ctx += ` deadline ${deadline.trim()}`
  }
  if (participants.length > 0) {
    ctx += "\nParticipants:"
    for (const p of participants) ctx += `\n${participantLine(p)}`
  }
  const garrison = payload.garrison as Record<string, unknown> | null | undefined
  if (garrison && typeof garrison === "object") {
    ctx += `\n${garrisonLine(garrison, viewer)}`
  }
  if (participants.some((p) => p.is_self)) {
    ctx += "\nSubmit a combat action now."
  }
  return ctx
}

function summarizeCombatRound(event: CombatEvent, viewer: AgentViewerContext): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const participants = readParticipants(payload, viewer)
  const ctx = combatContext(payload, participants, viewer)
  const result = (payload.result ?? payload.end ?? "in_progress") as string

  // Summarize the viewer's side-of-the-fight losses — self + any corp-mate
  // ships. Gives the LLM / UI a quick "how are we doing?" read.
  const ownSide = ownSideShips(participants)
  const lines: string[] = []
  for (const p of ownSide) {
    const pRaw = Array.isArray(payload.participants)
      ? (payload.participants as Array<Record<string, unknown>>).find(
          (raw) => raw.id === p.id,
        )
      : undefined
    const ship = (pRaw?.ship ?? {}) as Record<string, unknown>
    const fighterLoss = typeof ship.fighter_loss === "number" ? ship.fighter_loss : null
    const shieldDamage = typeof ship.shield_damage === "number" ? ship.shield_damage : null
    const prefix = p.is_self
      ? "your"
      : `corp ship "${p.ship_name ?? p.name}" (ship_id=${p.ship_id ?? p.id})`
    const fighterStr = fighterLoss && fighterLoss > 0 ? `fighters lost ${fighterLoss}` : "no fighter losses"
    const shieldStr =
      shieldDamage && shieldDamage > 0
        ? `shield damage ${shieldDamage.toFixed(1)}%`
        : "no shield damage"
    lines.push(`${prefix}: ${fighterStr}, ${shieldStr}`)
  }

  // Add the garrison's loss line when one is in the encounter. Side marker
  // tells the LLM if it's the viewer's / a corp-mate's / an opponent's
  // garrison so "X fighters lost" reads correctly in context.
  const garrison = payload.garrison as Record<string, unknown> | null | undefined
  if (garrison && typeof garrison === "object") {
    lines.push(garrisonRoundLine(garrison, viewer))
  }

  const payloadLines = lines.length > 0
    ? lines.join("; ")
    : "no friendly ships present"
  let out = `${ctx}\nRound resolved: ${result}; ${payloadLines}.`
  if (garrison && typeof garrison === "object") {
    out += `\n${garrisonLine(garrison, viewer)}`
  }
  return out
}

/** Compact "garrison X: Y fighters lost" line for the round-summary sentence. */
function garrisonRoundLine(
  garrison: Record<string, unknown>,
  viewer: AgentViewerContext,
): string {
  const ownerCharId =
    typeof garrison.owner_character_id === "string"
      ? garrison.owner_character_id
      : null
  const ownerCorpId =
    typeof garrison.owner_corp_id === "string" ? garrison.owner_corp_id : null
  const isMine = ownerCharId === viewer.characterId
  const isCorp =
    !isMine &&
    ownerCorpId != null &&
    typeof viewer.corpId === "string" &&
    viewer.corpId.length > 0 &&
    ownerCorpId === viewer.corpId
  const who = isMine ? "your garrison" : isCorp ? "corp garrison" : "enemy garrison"
  const fighterLoss =
    typeof garrison.fighter_loss === "number" ? garrison.fighter_loss : null
  const lossStr =
    fighterLoss && fighterLoss > 0
      ? `fighters lost ${fighterLoss}`
      : "no fighter losses"
  return `${who}: ${lossStr}`
}

function summarizeCombatAction(event: CombatEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const round = typeof payload.round === "number" ? String(payload.round) : "?"
  const actionNested = (payload.action ?? {}) as Record<string, unknown>
  const action =
    (typeof actionNested.action === "string" ? actionNested.action : null) ??
    (typeof payload.action === "string" ? payload.action : "unknown")
  const commitRaw = actionNested.commit ?? payload.commit
  const commit =
    typeof commitRaw === "number" && Math.floor(commitRaw) > 0
      ? ` commit ${Math.floor(commitRaw)}`
      : ""
  const targetRaw = actionNested.target_id ?? payload.target_id
  const targetStr =
    typeof targetRaw === "string" && targetRaw.trim()
      ? `, target ${shortId(targetRaw) ?? targetRaw}`
      : ""
  return `Action accepted for round ${round}: ${String(action).toLowerCase()}${commit}${targetStr}.`
}

function summarizeCombatEnded(event: CombatEvent, viewer: AgentViewerContext): string {
  const participants = readParticipants(event.payload, viewer)
  if (participants.some((p) => p.is_self)) {
    return "Combat state: your combat has ended."
  }
  const corpShips = participants.filter((p) => p.is_corp_mate)
  if (corpShips.length > 0) {
    const names = corpShips.map((p) => p.ship_name ?? p.name).join(", ")
    return `Combat state: the combat involving your corp's ${names} has ended.`
  }
  return "Combat state: observed combat ended."
}

function summarizeShipDestroyed(event: CombatEvent, viewer: AgentViewerContext): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const shipId = typeof payload.ship_id === "string" ? payload.ship_id : null
  const shipType = typeof payload.ship_type === "string" ? payload.ship_type : "unknown"
  const shipName = typeof payload.ship_name === "string" ? payload.ship_name : null
  const playerName = typeof payload.player_name === "string" ? payload.player_name : null
  const playerType = typeof payload.player_type === "string" ? payload.player_type : "human"
  const sector =
    payload.sector && typeof payload.sector === "object"
      ? (payload.sector as Record<string, unknown>).id
      : undefined
  const sectorStr = typeof sector === "number" ? ` in sector ${sector}` : ""

  const label = shipName ? `"${shipName}" (${shipType})` : shipType
  const idStr = shipId ? ` ship_id=${shipId}` : ""

  // Framing: was this YOUR ship? a corp-mate's? someone else's?
  const ownerCharacterId =
    typeof payload.owner_character_id === "string"
      ? payload.owner_character_id
      : null
  const ownerCorpId =
    typeof payload.corp_id === "string" ? payload.corp_id : null
  const isSelf =
    ownerCharacterId === viewer.characterId || shipId === viewer.characterId
  const isCorpMate =
    !isSelf &&
    typeof viewer.corpId === "string" &&
    viewer.corpId.length > 0 &&
    ownerCorpId === viewer.corpId

  if (isSelf) {
    return `Your ship ${label}${idStr} was destroyed${sectorStr}.`
  }
  if (isCorpMate) {
    return `Your corp's ship ${label}${idStr}${sectorStr} was destroyed (pilot: ${playerName ?? "unknown"}, ${playerType}).`
  }
  return `Ship destroyed: ${label}${idStr}${sectorStr} (pilot: ${playerName ?? "unknown"}, ${playerType}).`
}

/**
 * Wraps a summary string in the production XML envelope. Adds discriminator
 * attributes on the envelope (ship_id / ship_name for ship events, garrison_id
 * / garrison_owner for combat events that include a garrison or for
 * garrison.destroyed) so a consumer can quickly route / filter without
 * parsing the summary body.
 */
function wrapXml(event: CombatEvent, summary: string): string {
  const attrs: string[] = [`name="${event.type}"`]
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const combatId = event.combat_id ?? payload.combat_id
  if (typeof combatId === "string" && combatId.trim()) {
    attrs.push(`combat_id="${combatId.trim()}"`)
  }
  if (event.type === "ship.destroyed") {
    const shipId = payload.ship_id
    if (typeof shipId === "string" && shipId.trim()) {
      attrs.push(`ship_id="${shipId.trim()}"`)
    }
    const shipName = payload.ship_name
    if (typeof shipName === "string" && shipName.trim()) {
      attrs.push(`ship_name="${shipName.trim().replace(/"/g, '\\"')}"`)
    }
  }
  if (event.type === "garrison.destroyed") {
    const gid = payload.garrison_id
    if (typeof gid === "string" && gid.trim()) {
      attrs.push(`garrison_id="${gid.trim()}"`)
    }
    const ownerChar = payload.owner_character_id
    if (typeof ownerChar === "string" && ownerChar.trim()) {
      attrs.push(`garrison_owner="${ownerChar.trim()}"`)
    }
  }
  // Combat events that involve a garrison get garrison_id + garrison_owner
  // on the envelope too — lets an absent garrison owner's consumer cheaply
  // say "this round event is about MY garrison".
  if (
    event.type === "combat.round_waiting" ||
    event.type === "combat.round_resolved" ||
    event.type === "combat.ended"
  ) {
    const garrison = payload.garrison as Record<string, unknown> | null | undefined
    if (garrison && typeof garrison === "object") {
      const gid = garrison.id
      if (typeof gid === "string" && gid.trim()) {
        attrs.push(`garrison_id="${gid.trim()}"`)
      }
      const ownerChar = garrison.owner_character_id
      if (typeof ownerChar === "string" && ownerChar.trim()) {
        attrs.push(`garrison_owner="${ownerChar.trim()}"`)
      }
    }
  }
  return `<event ${attrs.join(" ")}>\n${summary}\n</event>`
}

function summarizeGarrisonDestroyed(
  event: CombatEvent,
  viewer: AgentViewerContext,
): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const gid = typeof payload.garrison_id === "string" ? payload.garrison_id : null
  const ownerCharId =
    typeof payload.owner_character_id === "string"
      ? payload.owner_character_id
      : null
  const ownerCorpId =
    typeof payload.owner_corp_id === "string" ? payload.owner_corp_id : null
  const ownerName =
    typeof payload.owner_name === "string" ? payload.owner_name : "unknown"
  const mode = typeof payload.mode === "string" ? payload.mode : "unknown"
  const sector =
    payload.sector && typeof payload.sector === "object"
      ? (payload.sector as Record<string, unknown>).id
      : undefined
  const sectorStr = typeof sector === "number" ? ` in sector ${sector}` : ""
  const idStr = gid ? ` garrison_id=${gid}` : ""
  const modeStr = mode !== "unknown" ? `, mode=${mode}` : ""

  const isSelf = ownerCharId != null && ownerCharId === viewer.characterId
  const isCorpMate =
    !isSelf &&
    ownerCorpId != null &&
    typeof viewer.corpId === "string" &&
    viewer.corpId.length > 0 &&
    ownerCorpId === viewer.corpId
  if (isSelf) {
    return `Your garrison was destroyed${sectorStr}${idStr}${modeStr}.`
  }
  if (isCorpMate) {
    return `Your corp's garrison (owner ${ownerName}) was destroyed${sectorStr}${idStr}${modeStr}.`
  }
  return `Garrison destroyed${sectorStr}${idStr}${modeStr} (owner: ${ownerName}).`
}

/**
 * Build the XML string for an event from this viewer's POV, or return null
 * if the event should NOT be appended to the viewer's LLM context.
 *
 * Append rules:
 *   - combat.round_waiting / round_resolved / ended: append if viewer is a
 *     participant OR a corp-mate of any participant.
 *   - combat.action_accepted: append only for the viewer's own submissions.
 *   - ship.destroyed: append if the viewer is a participant-recipient
 *     (`event.recipients` already encodes sector + corp scope).
 *
 * All branches also enforce the server-delivery precondition: the viewer's
 * id must be in `event.recipients`.
 */
export function toAgentEventXml(
  event: CombatEvent,
  viewer: AgentViewerContext | string,
): string | null {
  const ctx: AgentViewerContext =
    typeof viewer === "string" ? { characterId: viewer } : viewer
  if (!event.recipients.includes(ctx.characterId as never)) return null

  switch (event.type) {
    case "combat.round_waiting":
    case "combat.round_resolved":
    case "combat.ended": {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      const participants = readParticipants(payload, ctx)
      // "Involved" = viewer is a ship participant, a corp-mate of one,
      // OR the owner / corp-mate-owner of the garrison in this encounter.
      // Without the garrison check, an absent garrison owner never sees
      // the combat XML even though the engine correctly routes the event
      // to their recipient set.
      const garrisonOwn = garrisonOwnership(payload, ctx)
      const isInvolved =
        participants.some((p) => p.is_self) ||
        participants.some((p) => p.is_corp_mate) ||
        garrisonOwn !== "other"
      if (!isInvolved) return null
      if (event.type === "combat.round_waiting") {
        return wrapXml(event, summarizeCombatWaiting(event, ctx))
      }
      if (event.type === "combat.round_resolved") {
        return wrapXml(event, summarizeCombatRound(event, ctx))
      }
      return wrapXml(event, summarizeCombatEnded(event, ctx))
    }
    case "combat.action_accepted": {
      if (event.actor !== ctx.characterId) return null
      return wrapXml(event, summarizeCombatAction(event))
    }
    case "ship.destroyed": {
      return wrapXml(event, summarizeShipDestroyed(event, ctx))
    }
    case "garrison.destroyed": {
      // Scope: owner + corp-mates + sector observers receive this event
      // (engine's recipient list encodes that already). The XML filter
      // additionally gates the VIEWER: only append when the viewer actually
      // has a stake — owner or corp-mate of the garrison. An unrelated
      // same-sector observer would have been pruned by the recipients
      // check at the top of this function if they weren't in the set.
      // We still render the opponent-frame summary for sector observers so
      // they know a nearby garrison just popped.
      return wrapXml(event, summarizeGarrisonDestroyed(event, ctx))
    }
    default:
      return null
  }
}

// Re-export for any external callers that still expect the participant check.
export { isPlayerParticipant }
