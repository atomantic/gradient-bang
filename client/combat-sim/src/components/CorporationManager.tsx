import { useCallback, useState } from "react"

import type { CombatEngine } from "../engine/engine"
import {
  characterId as characterIdBrand,
  corpId as corpIdBrand,
  shipId as shipIdBrand,
  type Character,
  type CharacterId,
  type Corporation,
  type Ship,
  type ShipId,
  type World,
} from "../engine/types"

interface Props {
  engine: CombatEngine
  world: World
  open: boolean
  onClose: () => void
}

// Two distinct drag payload types so a drop zone can tell which chip kind
// was dropped (characters support "unassigned"; corp ships do not).
const CHAR_KEY = "application/x-gb-character-id"
const SHIP_KEY = "application/x-gb-ship-id"

type DragPayload =
  | { kind: "character"; id: string }
  | { kind: "ship"; id: string }

/**
 * Modal for creating corporations and dragging characters/corp-ships into
 * and out of them. Uses native HTML5 drag-and-drop. Each corp column is a
 * drop zone: dropping a character chip calls engine.addCharacterToCorp /
 * removeCharacterFromCorp, and dropping a corp-ship chip calls
 * engine.transferCorpShip. "Unassigned" accepts characters only — ships
 * must belong to some corp.
 */
export function CorporationManager({ engine, world, open, onClose }: Props) {
  const [newCorpName, setNewCorpName] = useState("")
  const [drag, setDrag] = useState<DragPayload | null>(null)

  const characters: Character[] = Array.from(world.characters.values())
  const corps: Corporation[] = Array.from(world.corporations.values())
  const unassigned = characters.filter((c) => !c.corpId)
  const corpShips: Ship[] = Array.from(world.ships.values()).filter(
    (s) => s.ownerCorpId,
  )

  const assignCharacter = useCallback(
    (charId: string, targetCorpId: string | null) => {
      try {
        const cid = characterIdBrand(charId)
        const current = world.characters.get(cid)?.corpId
        if (targetCorpId == null) {
          if (current) engine.removeCharacterFromCorp(cid)
          return
        }
        if (current === targetCorpId) return // no-op
        if (current) engine.removeCharacterFromCorp(cid)
        engine.addCharacterToCorp(cid, corpIdBrand(targetCorpId))
      } catch (err) {
        alert((err as Error).message)
      }
    },
    [engine, world],
  )

  const transferShip = useCallback(
    (rawShipId: string, targetCorpId: string | null) => {
      try {
        if (targetCorpId == null) {
          alert("Corp ships must belong to a corporation — drop on a corp column.")
          return
        }
        const sid = shipIdBrand(rawShipId)
        const result = engine.transferCorpShip(sid, corpIdBrand(targetCorpId))
        if (!result.ok) alert(result.reason ?? "transfer rejected")
      } catch (err) {
        alert((err as Error).message)
      }
    },
    [engine],
  )

  const handleDrop = useCallback(
    (payload: DragPayload, targetCorpId: string | null) => {
      if (payload.kind === "character") {
        assignCharacter(payload.id, targetCorpId)
      } else {
        transferShip(payload.id, targetCorpId)
      }
    },
    [assignCharacter, transferShip],
  )

  const createCorp = useCallback(() => {
    const name = newCorpName.trim()
    if (!name) return
    try {
      engine.createCorporation({ name })
      setNewCorpName("")
    } catch (err) {
      alert((err as Error).message)
    }
  }, [engine, newCorpName])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4 pt-12"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-neutral-100">
              Manage corporations
            </h2>
            <p className="text-[11px] text-neutral-500">
              Drag characters or corp ships between columns. Drop a character onto
              "Unassigned" to remove them from a corp. Ships must stay in some corp.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-300 hover:bg-neutral-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              createCorp()
            }}
            className="flex items-center gap-2"
          >
            <label className="text-[11px] text-neutral-500">new corp</label>
            <input
              type="text"
              value={newCorpName}
              onChange={(e) => setNewCorpName(e.target.value)}
              placeholder="name"
              className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600"
            />
            <button
              type="submit"
              disabled={!newCorpName.trim()}
              className="rounded bg-purple-900/40 px-3 py-1 text-xs text-purple-200 hover:bg-purple-900/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              + Corp
            </button>
          </form>
          <span className="ml-auto text-[11px] text-neutral-500">
            {characters.length} char{characters.length === 1 ? "" : "s"} ·{" "}
            {corpShips.length} corp ship{corpShips.length === 1 ? "" : "s"} ·{" "}
            {corps.length} corp{corps.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          <Column
            title="Unassigned"
            tone="neutral"
            subtitle={`${unassigned.length} character${unassigned.length === 1 ? "" : "s"}`}
            characters={unassigned}
            ships={[]}
            world={world}
            acceptsShips={false}
            onDrop={(payload) => handleDrop(payload, null)}
            drag={drag}
            onDragStart={setDrag}
            onDragEnd={() => setDrag(null)}
          />
          {corps.map((corp) => {
            const members = characters.filter((c) => c.corpId === corp.id)
            const ships = corpShips.filter((s) => s.ownerCorpId === corp.id)
            return (
              <Column
                key={corp.id}
                title={corp.name}
                tone="purple"
                subtitle={`${members.length} member${members.length === 1 ? "" : "s"} · ${ships.length} ship${ships.length === 1 ? "" : "s"}`}
                characters={members}
                ships={ships}
                world={world}
                acceptsShips={true}
                onDrop={(payload) => handleDrop(payload, corp.id)}
                drag={drag}
                onDragStart={setDrag}
                onDragEnd={() => setDrag(null)}
              />
            )
          })}
        </div>

        {corps.length === 0 && characters.length === 0 && corpShips.length === 0 && (
          <div className="px-4 pb-4 text-center text-xs text-neutral-500">
            No characters, ships, or corporations yet. Close this modal, create some
            entities, then come back to organize them.
          </div>
        )}
      </div>
    </div>
  )
}

function Column({
  title,
  subtitle,
  tone,
  characters,
  ships,
  world,
  acceptsShips,
  onDrop,
  drag,
  onDragStart,
  onDragEnd,
}: {
  title: string
  subtitle: string
  tone: "neutral" | "purple"
  characters: Character[]
  ships: Ship[]
  world: World
  acceptsShips: boolean
  onDrop: (payload: DragPayload) => void
  drag: DragPayload | null
  onDragStart: (p: DragPayload) => void
  onDragEnd: () => void
}) {
  const [isOver, setIsOver] = useState(false)
  const canAcceptDrag =
    drag != null && (drag.kind === "character" || acceptsShips)
  const toneStyles =
    tone === "purple"
      ? "border-purple-900/60 bg-purple-950/20"
      : "border-neutral-800 bg-neutral-900/50"
  const overStyles = "border-emerald-400 bg-emerald-950/30 ring-1 ring-emerald-400/40"
  const rejectStyles = "border-rose-500/60 bg-rose-950/20"

  return (
    <div
      onDragOver={(e) => {
        if (!drag) return
        if (!canAcceptDrag) return
        e.preventDefault()
        if (!isOver) setIsOver(true)
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setIsOver(false)
        const charId = e.dataTransfer.getData(CHAR_KEY)
        const sid = e.dataTransfer.getData(SHIP_KEY)
        if (charId) onDrop({ kind: "character", id: charId })
        else if (sid && acceptsShips) onDrop({ kind: "ship", id: sid })
      }}
      className={`flex min-h-[160px] flex-col rounded border p-2 transition ${
        isOver
          ? overStyles
          : drag && !canAcceptDrag
            ? rejectStyles
            : toneStyles
      }`}
    >
      <div className="mb-1 flex items-baseline gap-1">
        <span className="text-[12px] font-semibold text-neutral-100">{title}</span>
      </div>
      <div className="mb-2 text-[10px] uppercase tracking-wider text-neutral-500">{subtitle}</div>
      <div className="flex flex-1 flex-col gap-1">
        {characters.map((c) => (
          <CharacterChip
            key={c.id}
            character={c}
            world={world}
            onDragStart={() => onDragStart({ kind: "character", id: c.id })}
            onDragEnd={onDragEnd}
          />
        ))}
        {ships.map((s) => (
          <ShipChip
            key={s.id}
            ship={s}
            world={world}
            onDragStart={() => onDragStart({ kind: "ship", id: s.id })}
            onDragEnd={onDragEnd}
          />
        ))}
        {characters.length + ships.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-[10px] text-neutral-600">
            drop here
          </div>
        )}
      </div>
    </div>
  )
}

function CharacterChip({
  character,
  world,
  onDragStart,
  onDragEnd,
}: {
  character: Character
  world: World
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const ship = world.ships.get(character.currentShipId)
  const inCombat = isCharacterInActiveCombat(world, character.id)
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CHAR_KEY, character.id)
        e.dataTransfer.effectAllowed = "move"
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      title={inCombat ? "This character is currently in active combat" : "Drag to a corp column"}
      className={`cursor-grab rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-200 transition hover:border-neutral-600 active:cursor-grabbing ${
        inCombat ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-baseline gap-1">
        <span className="font-semibold">{character.name}</span>
        {inCombat && (
          <span className="rounded border border-rose-800 bg-rose-900/40 px-1 text-[9px] uppercase tracking-wider text-rose-200">
            combat
          </span>
        )}
      </div>
      <div className="font-mono text-[10px] text-neutral-500">
        {character.id} · sector {character.currentSector}
        {ship ? ` · ${ship.type}` : ""}
      </div>
    </div>
  )
}

function ShipChip({
  ship,
  world,
  onDragStart,
  onDragEnd,
}: {
  ship: Ship
  world: World
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const inCombat = isShipInActiveCombat(world, ship.id)
  return (
    <div
      draggable={!inCombat}
      onDragStart={(e) => {
        if (inCombat) {
          e.preventDefault()
          return
        }
        e.dataTransfer.setData(SHIP_KEY, ship.id)
        e.dataTransfer.effectAllowed = "move"
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      title={
        inCombat
          ? "This ship is in active combat — cannot reassign"
          : "Drag to another corp column"
      }
      className={`rounded border border-sky-900/60 bg-sky-950/30 px-2 py-1 text-xs text-sky-100 transition ${
        inCombat
          ? "cursor-not-allowed opacity-60"
          : "cursor-grab hover:border-sky-700 active:cursor-grabbing"
      }`}
    >
      <div className="flex items-baseline gap-1">
        <span className="font-semibold">{ship.name ?? ship.type}</span>
        <span className="rounded border border-sky-700 bg-sky-900/40 px-1 text-[9px] uppercase tracking-wider text-sky-200">
          ship
        </span>
        {inCombat && (
          <span className="rounded border border-rose-800 bg-rose-900/40 px-1 text-[9px] uppercase tracking-wider text-rose-200">
            combat
          </span>
        )}
      </div>
      <div className="font-mono text-[10px] text-sky-300/60">
        {ship.id} · sector {ship.sector} · {ship.type} · F{ship.fighters}/S{ship.shields}
      </div>
    </div>
  )
}

function isCharacterInActiveCombat(world: World, charId: CharacterId | string): boolean {
  for (const encounter of world.activeCombats.values()) {
    if (encounter.ended) continue
    if ((charId as string) in encounter.participants) return true
  }
  return false
}

function isShipInActiveCombat(world: World, sid: ShipId | string): boolean {
  for (const encounter of world.activeCombats.values()) {
    if (encounter.ended) continue
    if ((sid as string) in encounter.participants) return true
  }
  return false
}
