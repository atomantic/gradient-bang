import { useMemo, useState } from "react"

import { useAppStore } from "../store/appStore"
import type { CombatEvent, EntityId } from "../engine/types"

interface Props {
  events: readonly CombatEvent[]
}

type Direction = "sent" | "received"

interface RoundGroup {
  kind: "round"
  round: number
  events: CombatEvent[]
}

interface CombatGroup {
  kind: "combat"
  combat_id: string
  sector?: number
  events: CombatEvent[]
  rounds: RoundGroup[]
  tailEvents: CombatEvent[] // combat.ended and anything that doesn't carry a round number
  latestTimestamp: number
  ended: boolean
  endState: string | null
}

interface StandaloneNode {
  kind: "standalone"
  event: CombatEvent
  timestamp: number
}

type RootNode = CombatGroup | StandaloneNode

export function EventLog({ events }: Props) {
  const selectedId = useAppStore((s) => s.selectedEntityId)

  // Filter at the event level first — then group the filtered set so empty
  // combats/rounds drop out of the tree.
  const filteredEvents = useMemo(
    () =>
      selectedId
        ? events.filter((e) => eventConcerns(e, selectedId))
        : events,
    [events, selectedId],
  )
  const tree = useMemo(() => groupEvents(filteredEvents), [filteredEvents])

  return (
    <div className="h-full overflow-auto px-4 py-2">
      {selectedId && (
        <div className="mb-2 flex items-center gap-2 rounded border border-emerald-700 bg-emerald-950/40 px-2 py-1 text-xs">
          <span className="rounded border border-emerald-300 bg-emerald-950 px-1 text-[9px] font-bold uppercase tracking-wider text-emerald-200">
            POV
          </span>
          <span className="text-emerald-100">
            Viewing from <span className="font-semibold">{selectedId}</span>'s perspective
          </span>
          <span className="ml-auto text-[11px] text-neutral-400">
            {filteredEvents.length} of {events.length} events
          </span>
        </div>
      )}
      <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">
        Event log ({filteredEvents.length}
        {selectedId ? (
          <>
            <span className="text-emerald-400"> filtered</span>
            <span className="text-neutral-600"> · {events.length} total</span>
          </>
        ) : null}
        ) · newest first
      </div>
      {tree.length === 0 ? (
        <p className="text-xs text-neutral-600">
          {events.length === 0
            ? "No events yet. Reset the world or create a character."
            : "No events match the selected entity filter yet."}
        </p>
      ) : (
        <ul className="space-y-1">
          {tree.map((node) =>
            node.kind === "combat" ? (
              <CombatGroupView key={node.combat_id} group={node} selectedId={selectedId} />
            ) : (
              <EventRow key={node.event.id} event={node.event} selectedId={selectedId} />
            ),
          )}
        </ul>
      )}
    </div>
  )
}

function groupEvents(events: readonly CombatEvent[]): RootNode[] {
  const combatsById = new Map<string, CombatGroup>()
  const standalone: StandaloneNode[] = []

  for (const e of events) {
    const cid = e.combat_id
    if (cid) {
      let group = combatsById.get(cid)
      if (!group) {
        group = {
          kind: "combat",
          combat_id: cid,
          sector: e.sector_id,
          events: [],
          rounds: [],
          tailEvents: [],
          latestTimestamp: 0,
          ended: false,
          endState: null,
        }
        combatsById.set(cid, group)
      }
      group.events.push(e)
      if (e.timestamp > group.latestTimestamp) group.latestTimestamp = e.timestamp
    } else {
      standalone.push({ kind: "standalone", event: e, timestamp: e.timestamp })
    }
  }

  for (const group of combatsById.values()) {
    const roundMap = new Map<number, CombatEvent[]>()
    for (const e of group.events) {
      const payload = e.payload as Record<string, unknown> | undefined
      const round = typeof payload?.round === "number" ? (payload.round as number) : null

      if (e.type === "combat.ended") {
        group.tailEvents.push(e)
        group.ended = true
        const end = payload?.end ?? payload?.result
        if (typeof end === "string") group.endState = end
        continue
      }

      if (round != null) {
        const list = roundMap.get(round) ?? []
        list.push(e)
        roundMap.set(round, list)
      } else {
        group.tailEvents.push(e)
      }
    }
    group.rounds = [...roundMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, es]) => ({ kind: "round" as const, round, events: es }))
  }

  // Root-level: newest first, by latest timestamp touching that group (or the
  // standalone event's own timestamp).
  const root: RootNode[] = [...standalone, ...combatsById.values()]
  root.sort((a, b) => {
    const ta = a.kind === "standalone" ? a.timestamp : a.latestTimestamp
    const tb = b.kind === "standalone" ? b.timestamp : b.latestTimestamp
    return tb - ta
  })
  return root
}

function CombatGroupView({
  group,
  selectedId,
}: {
  group: CombatGroup
  selectedId: EntityId | null
}) {
  const [expanded, setExpanded] = useState(true)
  const roundCount = group.rounds.length
  const status = group.ended ? `ended: ${group.endState ?? "unknown"}` : "active"
  return (
    <li className="rounded border border-emerald-900/40 bg-emerald-950/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-emerald-950/40"
      >
        <Chevron expanded={expanded} />
        <span className="font-semibold text-emerald-200">combat {group.combat_id}</span>
        <span className="text-[11px] text-neutral-500">
          {group.sector != null ? `sector ${group.sector} · ` : ""}
          {roundCount} round{roundCount === 1 ? "" : "s"} · {status}
        </span>
        <span className="ml-auto text-[11px] text-neutral-600">
          {new Date(group.latestTimestamp).toLocaleTimeString()}
        </span>
      </button>
      {expanded && (
        <ul className="ml-3 space-y-1 border-l border-emerald-900/40 pl-3 pb-2 pr-2">
          {group.rounds.map((round) => (
            <RoundGroupView key={round.round} round={round} selectedId={selectedId} />
          ))}
          {group.tailEvents.map((e) => (
            <EventRow key={e.id} event={e} selectedId={selectedId} />
          ))}
        </ul>
      )}
    </li>
  )
}

function RoundGroupView({
  round,
  selectedId,
}: {
  round: RoundGroup
  selectedId: EntityId | null
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <li className="rounded border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-baseline gap-2 px-2 py-0.5 text-left text-[11px] text-neutral-300 hover:bg-neutral-900/70"
      >
        <Chevron expanded={expanded} />
        <span className="font-semibold text-neutral-200">Round {round.round}</span>
        <span className="text-neutral-500">
          ({round.events.length} event{round.events.length === 1 ? "" : "s"})
        </span>
      </button>
      {expanded && (
        <ul className="ml-3 space-y-1 border-l border-neutral-800 pl-3 pb-2 pr-2">
          {round.events.map((e) => (
            <EventRow key={e.id} event={e} selectedId={selectedId} />
          ))}
        </ul>
      )}
    </li>
  )
}

function EventRow({
  event,
  selectedId,
}: {
  event: CombatEvent
  selectedId: EntityId | null
}) {
  const [expanded, setExpanded] = useState(false)
  const direction = selectedId ? classifyDirection(event, selectedId) : null
  const typeColor = eventTypeColor(event.type)
  return (
    <li className="rounded border border-neutral-800 bg-neutral-900/60">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-[12px] hover:bg-neutral-900/80"
      >
        <Chevron expanded={expanded} />
        {direction && <DirectionBadge direction={direction} />}
        <span className={`font-semibold ${typeColor}`}>{event.type}</span>
        {event.actor && (
          <span className="text-[11px] text-neutral-500">
            · actor <span className="text-neutral-300">{event.actor}</span>
          </span>
        )}
        <span className="font-mono text-[10px] text-neutral-600">{event.id}</span>
        <span className="ml-auto font-mono text-[10px] text-neutral-600">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-neutral-800 px-2 py-1">
          <pre className="whitespace-pre-wrap text-[11px] leading-snug text-neutral-400">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
          {event.recipients.length > 0 && (
            <div className="mt-1 text-[11px] text-neutral-500">
              recipients:{" "}
              <span className="font-mono text-neutral-400">{event.recipients.join(", ")}</span>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function eventTypeColor(type: string): string {
  if (type.startsWith("combat.")) return "text-emerald-300"
  if (type.startsWith("ship.")) return "text-rose-300"
  if (type.startsWith("salvage.")) return "text-amber-300"
  if (type.startsWith("garrison.")) return "text-sky-300"
  if (type.startsWith("corporation.")) return "text-purple-300"
  if (type.startsWith("character.")) return "text-cyan-300"
  if (type.startsWith("world.")) return "text-neutral-400"
  return "text-neutral-300"
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      className={`inline-block w-3 text-[10px] text-neutral-500 transition ${
        expanded ? "rotate-90" : ""
      }`}
    >
      ▶
    </span>
  )
}

function DirectionBadge({ direction }: { direction: Direction }) {
  const styles: Record<Direction, string> = {
    sent: "bg-sky-900/50 text-sky-200 border-sky-800",
    received: "bg-violet-900/40 text-violet-200 border-violet-800",
  }
  return (
    <span
      className={`rounded border px-1 py-0 text-[10px] uppercase tracking-wide ${styles[direction]}`}
    >
      {direction}
    </span>
  )
}

function eventConcerns(event: CombatEvent, id: EntityId): boolean {
  if (event.actor === id) return true
  return event.recipients.includes(id)
}

// Self-notifications (actor === selected AND recipients includes selected)
// are classified as "sent" — treat the self-receipt as implicit.
function classifyDirection(event: CombatEvent, id: EntityId): Direction | null {
  const isSender = event.actor === id
  const isReceiver = event.recipients.includes(id)
  if (isSender) return "sent"
  if (isReceiver) return "received"
  return null
}
