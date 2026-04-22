import type { CombatEvent } from "./types"

export type EventListener = (event: CombatEvent) => void

export interface Emitter {
  emit(event: CombatEvent): void
  subscribe(listener: EventListener): () => void
}

export class InMemoryEmitter implements Emitter {
  // Copy-on-write so useSyncExternalStore picks up changes via reference equality.
  private log: readonly CombatEvent[] = []
  private listeners = new Set<EventListener>()

  emit(event: CombatEvent): void {
    this.log = [...this.log, event]
    for (const l of this.listeners) l(event)
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getLog(): readonly CombatEvent[] {
    return this.log
  }

  clear(): void {
    this.log = []
  }
}
