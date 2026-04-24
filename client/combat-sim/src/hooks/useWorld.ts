import { useSyncExternalStore } from "react"

import type { InMemoryEmitter } from "../engine/emitter"
import type { CombatEngine } from "../engine/engine"
import type { World } from "../engine/types"

export function useWorld(engine: CombatEngine, emitter: InMemoryEmitter): World {
  return useSyncExternalStore(
    (cb) => emitter.subscribe(() => cb()),
    () => engine.getWorldSnapshot(),
  )
}
