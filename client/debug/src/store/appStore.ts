import { create } from "zustand"

import type { EntityId } from "../engine/types"

interface AppState {
  selectedEntityId: EntityId | null
  selectEntity: (id: EntityId | null) => void
  toggleEntity: (id: EntityId) => void
}

export const useAppStore = create<AppState>()((set, get) => ({
  selectedEntityId: null,
  selectEntity: (id) => set({ selectedEntityId: id }),
  toggleEntity: (id) =>
    set({ selectedEntityId: get().selectedEntityId === id ? null : id }),
}))
