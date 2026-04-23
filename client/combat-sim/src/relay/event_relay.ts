import type { InMemoryEmitter } from "../engine/emitter"
import type { CombatEngine } from "../engine/engine"
import type {
  AppendRule,
  CharacterId,
  CombatEvent,
  EntityId,
  InferenceRule,
  RelayDecision,
  ShipId,
} from "../engine/types"

/**
 * Per-event-type routing configuration. Mirrors the registry in
 * `src/gradientbang/pipecat_server/subagents/event_relay.py` (~line 313). Only
 * the combat-adjacent subset is modelled — the harness has no task / quest /
 * chat / corp-admin events, so those configs are omitted rather than stubbed.
 *
 * Event types not present in this map fall through to `DEFAULT_CONFIG`, which
 * matches production's "bare EventConfig()" default.
 */
export interface RelayConfig {
  append: AppendRule
  inference: InferenceRule
  /**
   * Comment copy-pasteable into production (what the config MEANS for this
   * event). Rendered by the event log's per-decision tooltip so debuggers
   * can see *why* an event did / didn't wake the LLM.
   */
  note: string
}

export const EVENT_CONFIGS: Record<string, RelayConfig> = {
  "combat.round_waiting": {
    append: "PARTICIPANT",
    inference: "ON_PARTICIPANT",
    note: "Participants see it and wake — it's their turn to act.",
  },
  "combat.round_resolved": {
    append: "PARTICIPANT",
    inference: "ALWAYS",
    note: "Every participant wakes on round results (production: InferenceRule.ALWAYS).",
  },
  "combat.ended": {
    append: "PARTICIPANT",
    inference: "NEVER",
    note: "Silent append — round_resolved already woke the voice agent; avoid re-narrating.",
  },
  "combat.action_accepted": {
    append: "PARTICIPANT",
    inference: "NEVER",
    note: "Confirmation to the actor only; don't wake their LLM for its own echo.",
  },
  "ship.destroyed": {
    append: "LOCAL",
    inference: "NEVER",
    note: "Sector-local append; voice notified via the next round_resolved.",
  },
  "salvage.created": {
    append: "LOCAL",
    inference: "NEVER",
    note: "Sector-local; agents can pick it up on a later scan.",
  },
  "garrison.destroyed": {
    append: "PARTICIPANT",
    inference: "OWNED",
    note: "Owner's voice should speak (OWNED) — garrison.destroyed is the loud signal.",
  },
}

const DEFAULT_CONFIG: RelayConfig = {
  append: "DIRECT",
  inference: "NEVER",
  note: "No custom config — default DIRECT append, no inference.",
}

export interface MockEventRelayOpts {
  engine: CombatEngine
  emitter: InMemoryEmitter
}

/**
 * Harness-only mock of production's `EventRelay`. Subscribes to the engine's
 * emitter and, for every emitted event, computes a per-recipient routing
 * decision matching the production rules:
 *   - `append`: does this event land in the recipient's LLM context?
 *   - `run_llm`: does appending it trigger an LLM turn?
 *
 * The decision is attached to `event.relay` for easy consumption by the
 * event log UI (so a debugger can see at a glance which events would have
 * woken which ship's agent from its POV).
 *
 * The relay is strictly OBSERVATIONAL — it does NOT replace `ControllerManager`
 * as the thing that actually drives decisions. It's a parallel layer that
 * annotates reality; the harness still only invokes agents on
 * `combat.round_waiting` (see `ControllerManager.handleEvent`). In production,
 * the same decision table controls real inference triggering — the harness's
 * role is to let you verify the table is correct before porting it back.
 */
export class MockEventRelay {
  private readonly engine: CombatEngine
  private readonly emitter: InMemoryEmitter
  private unsubscribe: (() => void) | null = null

  constructor(opts: MockEventRelayOpts) {
    this.engine = opts.engine
    this.emitter = opts.emitter
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.emitter.subscribe((e) => this.handleEvent(e))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /**
   * Compute + attach per-recipient decisions to the event. Mutation is the
   * simplest cross-cutting delivery — the emitter log holds the same object
   * references, so downstream consumers (EventLog, useEngineEvents) see the
   * annotations on the next render without extra wiring.
   */
  private handleEvent(event: CombatEvent): void {
    const cfg = EVENT_CONFIGS[event.type] ?? DEFAULT_CONFIG
    const decisions: RelayDecision[] = []
    const seen = new Set<string>()
    for (const rid of event.recipients) {
      if (seen.has(rid as string)) continue
      seen.add(rid as string)
      decisions.push(this.decide(event, rid, cfg))
    }
    event.relay = decisions
  }

  /** Exposed for direct unit-testing + ad-hoc "what would X see?" lookups. */
  decide(event: CombatEvent, viewerId: EntityId, cfg: RelayConfig): RelayDecision {
    const effectiveCfg = this.applyHarnessOverrides(event, viewerId, cfg)
    const { append, appendReason } = this.evalAppend(
      event,
      viewerId,
      effectiveCfg.append,
    )
    let run_llm = false
    let inferenceReason = ""
    if (!append) {
      inferenceReason = "append=false → never infer"
    } else {
      const ev = this.evalInference(event, viewerId, effectiveCfg.inference)
      run_llm = ev.run
      inferenceReason = ev.reason
    }
    return {
      viewer: viewerId,
      appendRule: effectiveCfg.append,
      inferenceRule: effectiveCfg.inference,
      append,
      run_llm,
      reason: `${effectiveCfg.append}: ${appendReason} / ${effectiveCfg.inference}: ${inferenceReason}`,
    }
  }

  /**
   * Apply harness-specific overrides to the base config for this viewer.
   *
   * The only override today: an absent garrison owner receives combat round
   * events (append=true) but should NOT wake their voice agent every round
   * (run_llm=false). Production doesn't model this because production doesn't
   * currently route these events to the absent owner at all. The harness adds
   * the routing AND the silencing together — documented in
   * `docs/combat-debug-harness-spec.md` under "Event flow for garrisons".
   */
  private applyHarnessOverrides(
    event: CombatEvent,
    viewerId: EntityId,
    cfg: RelayConfig,
  ): RelayConfig {
    if (
      event.type !== "combat.round_waiting" &&
      event.type !== "combat.round_resolved" &&
      event.type !== "combat.ended"
    ) {
      return cfg
    }
    // If the viewer is ONLY involved via garrison ownership (not a ship
    // participant), downgrade inference to NEVER. Ship participants keep the
    // configured inference rule.
    if (this.isShipParticipant(event, viewerId)) return cfg
    if (this.isGarrisonOwnerForEvent(event, viewerId)) {
      return {
        append: cfg.append,
        inference: "NEVER",
        note: `${cfg.note} (harness override: garrison-owner-only → silent)`,
      }
    }
    return cfg
  }

  // ---- AppendRule evaluation ----

  private evalAppend(
    event: CombatEvent,
    viewerId: EntityId,
    rule: AppendRule,
  ): { append: boolean; appendReason: string } {
    // The recipients list is the server-delivery precondition in all cases.
    // If the viewer isn't even a recipient, no rule can let the event through.
    const inRecipients = event.recipients.includes(viewerId)
    if (!inRecipients) return { append: false, appendReason: "not in recipients" }

    switch (rule) {
      case "NEVER":
        return { append: false, appendReason: "rule=NEVER" }
      case "PARTICIPANT": {
        if (this.isShipParticipant(event, viewerId))
          return { append: true, appendReason: "ship participant" }
        // Garrison ownership is the more semantic "why" when both this and
        // the actor fallback below would match (e.g. a garrison owner
        // auto-initiating combat is also the event actor). Check it first
        // so the decision reason surfaces the garrison link in the UI.
        if (this.isGarrisonOwnerForEvent(event, viewerId))
          return {
            append: true,
            appendReason: "garrison owner (harness-extended PARTICIPANT)",
          }
        // Actor-scoped events (combat.action_accepted) ship without a
        // participants[] array; production's PARTICIPANT rule treats
        // the actor as a participant in those cases too. Match that.
        if (event.actor && event.actor === viewerId)
          return { append: true, appendReason: "viewer is event actor" }
        return { append: false, appendReason: "not a participant / garrison owner" }
      }
      case "LOCAL": {
        const viewerSector = this.viewerSector(viewerId)
        const eventSector =
          typeof event.sector_id === "number" ? event.sector_id : null
        if (
          viewerSector != null &&
          eventSector != null &&
          viewerSector === eventSector
        ) {
          return { append: true, appendReason: `sector match (${eventSector})` }
        }
        return { append: false, appendReason: "sector mismatch" }
      }
      case "OWNED":
        return this.evalOwned(event, viewerId)
      case "DIRECT":
      default:
        return { append: true, appendReason: "in recipients (DIRECT)" }
    }
  }

  // ---- InferenceRule evaluation ----

  private evalInference(
    event: CombatEvent,
    viewerId: EntityId,
    rule: InferenceRule,
  ): { run: boolean; reason: string } {
    switch (rule) {
      case "NEVER":
        return { run: false, reason: "rule=NEVER" }
      case "ALWAYS":
        return { run: true, reason: "rule=ALWAYS" }
      case "ON_PARTICIPANT":
        if (this.isShipParticipant(event, viewerId))
          return { run: true, reason: "ship participant" }
        return { run: false, reason: "not a ship participant" }
      case "OWNED": {
        const o = this.evalOwned(event, viewerId)
        return { run: o.append, reason: o.appendReason }
      }
    }
  }

  // ---- Helpers ----

  private isShipParticipant(event: CombatEvent, viewerId: EntityId): boolean {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const participants = payload.participants
    if (!Array.isArray(participants)) return false
    for (const p of participants) {
      if (!p || typeof p !== "object") continue
      if ((p as Record<string, unknown>).id === viewerId) return true
    }
    return false
  }

  private isGarrisonOwnerForEvent(
    event: CombatEvent,
    viewerId: EntityId,
  ): boolean {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const garrison = payload.garrison as Record<string, unknown> | null | undefined
    if (garrison && typeof garrison === "object") {
      if (garrison.owner_character_id === viewerId) return true
      const ownerCorp =
        typeof garrison.owner_corp_id === "string" ? garrison.owner_corp_id : null
      if (ownerCorp && this.viewerCorp(viewerId) === ownerCorp) return true
    }
    // garrison.destroyed has ownership fields on the top-level payload.
    if (event.type === "garrison.destroyed") {
      if (payload.owner_character_id === viewerId) return true
      const ownerCorp =
        typeof payload.owner_corp_id === "string" ? payload.owner_corp_id : null
      if (ownerCorp && this.viewerCorp(viewerId) === ownerCorp) return true
    }
    return false
  }

  /** OWNED = viewer owns the event's subject (currently garrison or ship). */
  private evalOwned(
    event: CombatEvent,
    viewerId: EntityId,
  ): { append: boolean; appendReason: string } {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    // Direct owner_character_id match (garrison.destroyed / ship.destroyed payloads both have this).
    if (payload.owner_character_id === viewerId) {
      return { append: true, appendReason: "viewer is owner" }
    }
    // Corp ownership → the viewer is a corp-mate of the owner.
    const ownerCorp =
      typeof payload.owner_corp_id === "string"
        ? payload.owner_corp_id
        : typeof payload.corp_id === "string"
          ? payload.corp_id
          : null
    if (ownerCorp && this.viewerCorp(viewerId) === ownerCorp) {
      return { append: true, appendReason: "viewer is corp-mate of owner" }
    }
    return { append: false, appendReason: "not owner / corp-mate" }
  }

  private viewerSector(viewerId: EntityId): number | null {
    const world = this.engine.getWorldSnapshot()
    const char = world.characters.get(viewerId as CharacterId)
    if (char) return char.currentSector
    const ship = world.ships.get(viewerId as unknown as ShipId)
    if (ship) return ship.sector
    return null
  }

  private viewerCorp(viewerId: EntityId): string | null {
    const world = this.engine.getWorldSnapshot()
    const char = world.characters.get(viewerId as CharacterId)
    if (char?.corpId) return char.corpId
    const ship = world.ships.get(viewerId as unknown as ShipId)
    if (ship?.ownerCorpId) return ship.ownerCorpId
    return null
  }
}

/** Look up the per-viewer relay decision stored on an event, if any. */
export function decisionFor(
  event: CombatEvent,
  viewerId: string,
): RelayDecision | undefined {
  return event.relay?.find((d) => d.viewer === viewerId)
}
