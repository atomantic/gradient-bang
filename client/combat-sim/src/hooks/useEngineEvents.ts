import { useSyncExternalStore } from "react"

import type { InMemoryEmitter } from "../engine/emitter"
import type { CombatEvent } from "../engine/types"

export function useEngineEvents(emitter: InMemoryEmitter): readonly CombatEvent[] {
  return useSyncExternalStore(
    (cb) => emitter.subscribe(() => cb()),
    () => emitter.getLog(),
  )
}
