import { useState } from "react"

import type { ControllerConfig } from "../controllers/types"
import { useAppStore } from "../store/appStore"
import type { EntityId } from "../engine/types"
import { StrategyEditorModal } from "./StrategyEditorModal"

interface Props {
  entityId: EntityId
  onSetController: (id: string, config: ControllerConfig | null) => void
  /** True when the entity is a participant in an active combat — locks the config. */
  disabled?: boolean
  /** Display label shown in the strategy editor header. Defaults to entityId. */
  displayLabel?: string
}

/** Models exposed in the dropdown. Add here when new ones land. */
const OPENAI_MODELS = [
  "gpt-5-mini",
  "gpt-5",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4o-mini",
  "gpt-4o",
] as const

const STRATEGIES = [
  { value: "balanced", label: "balanced" },
  { value: "offensive", label: "offensive" },
  { value: "defensive", label: "defensive" },
] as const

export function ControllerPicker({
  entityId,
  onSetController,
  disabled,
  displayLabel,
}: Props) {
  const controller = useAppStore((s) => s.controllers[entityId])
  const inFlight = useAppStore((s) => (s.inFlight[entityId] ?? 0) > 0)
  const [editorOpen, setEditorOpen] = useState(false)

  const kind = controller?.kind ?? "manual"
  const model = controller?.model ?? "gpt-4.1"
  const strategy = controller?.strategy ?? "balanced"
  const hasCustomStrategy = Boolean(controller?.customStrategy?.trim())

  const setKind = (v: "manual" | "llm") => {
    if (v === "manual") onSetController(entityId, null)
    else
      onSetController(entityId, {
        kind: "llm",
        model,
        strategy: controller?.strategy ?? "balanced",
        customStrategy: controller?.customStrategy,
      })
  }

  const setModel = (v: string) => {
    onSetController(entityId, {
      kind: "llm",
      model: v,
      strategy: controller?.strategy ?? "balanced",
      customStrategy: controller?.customStrategy,
    })
  }

  const setStrategy = (v: string) => {
    const strat = v as "offensive" | "defensive" | "balanced"
    onSetController(entityId, {
      kind: "llm",
      model,
      strategy: strat,
      customStrategy: controller?.customStrategy,
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] text-neutral-500">
      <span>controller</span>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as "manual" | "llm")}
        disabled={disabled}
        className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200 disabled:opacity-50"
      >
        <option value="manual">manual</option>
        <option value="llm">LLM</option>
      </select>
      {kind === "llm" && (
        <>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={disabled}
            title="OpenAI model"
            className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200 disabled:opacity-50"
          >
            {OPENAI_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            disabled={disabled}
            title={
              disabled
                ? "Strategy is locked during active combat"
                : "Decision-style override (prompt-level only)"
            }
            className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200 disabled:opacity-50"
          >
            {STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            disabled={disabled}
            title={
              disabled
                ? "Custom strategy is locked during active combat"
                : hasCustomStrategy
                  ? "Click to edit the custom strategy override"
                  : "Click to write a custom strategy for this ship"
            }
            className={`rounded border px-1 text-[9px] uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-60 ${
              inFlight
                ? "animate-pulse border-amber-400 bg-amber-900/50 text-amber-100"
                : hasCustomStrategy
                  ? "border-fuchsia-500 bg-fuchsia-900/60 text-fuchsia-100 hover:bg-fuchsia-900/80"
                  : "border-amber-700 bg-amber-950/50 text-amber-300 hover:bg-amber-900/40"
            }`}
          >
            {inFlight ? "thinking" : hasCustomStrategy ? "AI · custom" : "AI"}
          </button>
          {disabled && (
            <span
              title="Controller config locked while this entity is in active combat"
              className="rounded border border-neutral-700 bg-neutral-900 px-1 text-[9px] uppercase tracking-wider text-neutral-400"
            >
              locked
            </span>
          )}
        </>
      )}
      {controller?.kind === "llm" && (
        <StrategyEditorModal
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          label={displayLabel ?? entityId}
          config={controller}
          onSave={(next) => onSetController(entityId, next)}
        />
      )}
    </div>
  )
}
