import { useEffect, useState } from "react"

import type { CombatEngine } from "../engine/engine"
import {
  characterId,
  combatId as combatIdBrand,
  type CombatEncounterState,
  type CombatantAction,
  type RoundActionState,
  type World,
} from "../engine/types"

interface Props {
  engine: CombatEngine
  world: World
}

export function CombatPanel({ engine, world }: Props) {
  const active = Array.from(world.activeCombats.values()).filter((c) => !c.ended)
  if (active.length === 0) return null

  return (
    <div className="border-b border-neutral-800 bg-neutral-950/60 px-4 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">
        Active combat ({active.length})
      </div>
      <div className="space-y-3">
        {active.map((encounter) => (
          <EncounterCard key={encounter.combat_id} engine={engine} encounter={encounter} />
        ))}
      </div>
    </div>
  )
}

function EncounterCard({
  engine,
  encounter,
}: {
  engine: CombatEngine
  encounter: CombatEncounterState
}) {
  const participants = Object.values(encounter.participants)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  const remainingMs = encounter.deadline != null ? encounter.deadline - now : null
  const expired = remainingMs != null && remainingMs <= 0

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/50 p-2">
      <div className="mb-2 flex items-center gap-3 text-[11px] text-neutral-500">
        <span>
          <span className="text-neutral-400">{encounter.combat_id}</span> · sector{" "}
          {encounter.sector_id} · round {encounter.round}
        </span>
        <span className="ml-auto">
          deadline:{" "}
          {remainingMs == null ? (
            "—"
          ) : expired ? (
            <span className="text-amber-400">expired (tick to resolve)</span>
          ) : (
            <span className="text-neutral-300">{(remainingMs / 1000).toFixed(1)}s</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => engine.tick(Date.now())}
          className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700"
        >
          Tick now
        </button>
        <button
          type="button"
          onClick={() => {
            if (
              !window.confirm(
                "Force-end this combat? No more damage will be applied; the engine emits a final combat.ended so you can summarize. Harness-only — not in production.",
              )
            )
              return
            const result = engine.forceEndCombat(
              combatIdBrand(encounter.combat_id),
            )
            if (!result.ok) alert(result.reason)
          }}
          className="rounded bg-rose-900/40 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-900/60"
          title="Hard-terminate this combat (debug only)"
        >
          Force end
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {participants.map((p) =>
          p.combatant_type === "garrison" ? (
            <GarrisonCard key={p.combatant_id} participant={p} />
          ) : (
            <ParticipantDock
              key={p.combatant_id}
              engine={engine}
              encounter={encounter}
              participantId={p.combatant_id}
            />
          ),
        )}
      </div>
    </div>
  )
}

function GarrisonCard({
  participant,
}: {
  participant: CombatEncounterState["participants"][string]
}) {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>
  const mode = String(metadata.mode ?? "offensive")
  const dead = participant.fighters <= 0
  return (
    <div
      className={`rounded border p-2 text-xs ${
        dead
          ? "border-neutral-900 bg-neutral-950/60 opacity-60"
          : "border-sky-900/60 bg-sky-950/30"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-neutral-100">{participant.name}</span>
        <span className="text-[11px] uppercase tracking-wider text-sky-400">{mode}</span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-neutral-400">
        <div>
          fighters{" "}
          <span className="text-neutral-200">
            {participant.fighters}/{participant.max_fighters}
          </span>
        </div>
        <div>
          <span className="text-sky-300">auto-controlled</span>
        </div>
      </div>
    </div>
  )
}

function ParticipantDock({
  engine,
  encounter,
  participantId,
}: {
  engine: CombatEngine
  encounter: CombatEncounterState
  participantId: string
}) {
  const participant = encounter.participants[participantId]
  const opponents = Object.values(encounter.participants).filter(
    (p) => p.combatant_id !== participantId,
  )
  const [target, setTarget] = useState<string>(opponents[0]?.combatant_id ?? "")
  const [commit, setCommit] = useState<number>(
    Math.max(1, Math.floor((participant?.fighters ?? 0) / 2)),
  )
  const [destination, setDestination] = useState<number>(encounter.sector_id - 1)

  // Any toll-mode garrison in this combat with an unpaid entry → this
  // participant can submit `pay` against it.
  const tollRegistry = (encounter.context as Record<string, unknown> | undefined)
    ?.toll_registry as Record<string, { toll_amount?: number; paid?: boolean }> | undefined
  const unpaidTollGarrison = Object.values(encounter.participants).find((p) => {
    if (p.combatant_type !== "garrison") return false
    const mode = (p.metadata as Record<string, unknown> | undefined)?.mode
    if (mode !== "toll") return false
    const entry = tollRegistry?.[p.combatant_id]
    return !entry || !entry.paid
  })
  const tollAmount =
    (unpaidTollGarrison?.metadata as Record<string, unknown> | undefined)?.toll_amount ?? 0

  if (!participant) return null
  const submitted = encounter.pending_actions[participantId]
  // Fall back to the round-just-resolved buffer so a ship whose tool call
  // triggered the final round resolution still shows its chosen action —
  // otherwise the sync emit chain wipes `pending_actions` before React
  // paints, and the badge appears "stuck on awaiting".
  const lastAction = encounter.ui_last_actions[participantId]
  const dead = participant.fighters <= 0

  const submit = (action: CombatantAction) => {
    const actor = characterId(participantId)
    const cid = combatIdBrand(encounter.combat_id)
    let result
    if (action === "attack") {
      result = engine.submitAction(actor, cid, { action: "attack", target_id: target, commit })
    } else if (action === "brace") {
      result = engine.submitAction(actor, cid, { action: "brace" })
    } else if (action === "flee") {
      result = engine.submitAction(actor, cid, { action: "flee", destination_sector: destination })
    } else {
      result = engine.submitAction(actor, cid, {
        action: "pay",
        target_id: unpaidTollGarrison?.combatant_id ?? null,
      })
    }
    if (!result.ok) alert(result.reason)
  }

  return (
    <div
      className={`rounded border p-2 text-xs ${
        dead
          ? "border-neutral-900 bg-neutral-950/60 opacity-60"
          : "border-neutral-800 bg-neutral-900"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-neutral-100">{participant.name}</span>
        <span className="text-[11px] text-neutral-500">
          {participant.combatant_id} · {participant.ship_type}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-neutral-400">
        <div>
          fighters{" "}
          <span className="text-neutral-200">
            {participant.fighters}/{participant.max_fighters}
          </span>
        </div>
        <div>
          shields{" "}
          <span className="text-neutral-200">
            {participant.shields}/{participant.max_shields}
          </span>
        </div>
        <div>
          {dead ? (
            <span className="text-rose-400">destroyed</span>
          ) : submitted ? (
            <span className="text-emerald-300">
              submitted: {formatAction(submitted, encounter)}
            </span>
          ) : lastAction ? (
            <span className="text-neutral-400">
              resolved: {formatAction(lastAction, encounter)}
              {lastAction.timed_out ? " (timeout)" : ""}
            </span>
          ) : (
            <span className="text-amber-400">awaiting</span>
          )}
        </div>
      </div>
      {!dead && !submitted && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded bg-neutral-800 px-1 py-0.5 text-[11px]"
          >
            {opponents.map((o) => (
              <option key={o.combatant_id} value={o.combatant_id}>
                {o.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={participant.fighters}
            value={commit}
            onChange={(e) => setCommit(Number(e.target.value))}
            className="w-14 rounded bg-neutral-800 px-1 py-0.5 text-[11px]"
          />
          <button
            type="button"
            onClick={() => submit("attack")}
            className="rounded bg-red-900/40 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-900/60"
          >
            Attack
          </button>
          <button
            type="button"
            onClick={() => submit("brace")}
            className="rounded bg-blue-900/40 px-2 py-0.5 text-[11px] text-blue-200 hover:bg-blue-900/60"
          >
            Brace
          </button>
          <input
            type="number"
            value={destination}
            onChange={(e) => setDestination(Number(e.target.value))}
            className="w-14 rounded bg-neutral-800 px-1 py-0.5 text-[11px]"
          />
          <button
            type="button"
            onClick={() => submit("flee")}
            className="rounded bg-amber-900/40 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-900/60"
          >
            Flee
          </button>
          {unpaidTollGarrison && (
            <button
              type="button"
              onClick={() => submit("pay")}
              className="rounded bg-sky-900/50 px-2 py-0.5 text-[11px] text-sky-100 hover:bg-sky-900/70"
              title={`Pay ${String(tollAmount)}c to ${unpaidTollGarrison.name}`}
            >
              Pay ({String(tollAmount)}c)
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Render a RoundActionState as a compact one-liner suitable for the
 * submitted/resolved badge. Includes target name, commit size, or destination
 * sector where relevant — stops the user from having to hover to see what
 * the agent actually picked.
 */
function formatAction(
  action: RoundActionState,
  encounter: CombatEncounterState,
): string {
  const base = action.action ?? "brace"
  if (base === "attack") {
    const targetName =
      (action.target_id &&
        encounter.participants[action.target_id]?.name) ||
      (action.target_id ? `${action.target_id.slice(0, 8)}…` : "?")
    return `attack → ${targetName}${action.commit ? ` (${action.commit})` : ""}`
  }
  if (base === "flee") {
    return action.destination_sector != null
      ? `flee → sector ${action.destination_sector}`
      : "flee"
  }
  if (base === "pay") {
    const targetName =
      (action.target_id &&
        encounter.participants[action.target_id]?.name) ||
      "toll"
    return `pay → ${targetName}`
  }
  return base
}
