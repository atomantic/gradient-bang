import { useMemo } from "react"

import { CombatPanel } from "./components/CombatPanel"
import { EntityRoster } from "./components/EntityRoster"
import { EventLog } from "./components/EventLog"
import { ScenarioBuilder } from "./components/ScenarioBuilder"
import { InMemoryEmitter } from "./engine/emitter"
import { CombatEngine } from "./engine/engine"
import { useEngineEvents } from "./hooks/useEngineEvents"
import { useWorld } from "./hooks/useWorld"

export function App() {
  const { engine, emitter } = useMemo(() => {
    const emitter = new InMemoryEmitter()
    const engine = new CombatEngine({ emitter })
    return { engine, emitter }
  }, [])

  const events = useEngineEvents(emitter)
  const world = useWorld(engine, emitter)

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800 bg-neutral-950 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide text-neutral-200">
          Combat Debug Harness
        </h1>
      </header>
      <ScenarioBuilder engine={engine} world={world} />
      <EntityRoster engine={engine} world={world} />
      <CombatPanel engine={engine} world={world} />
      <main className="flex-1 overflow-hidden">
        <EventLog events={events} />
      </main>
    </div>
  )
}
