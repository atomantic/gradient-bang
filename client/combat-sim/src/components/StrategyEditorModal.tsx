import { useEffect, useState } from "react"

import { PROMPT_FRAGMENTS } from "../agent/prompts"
import type { ControllerConfig } from "../controllers/types"

interface Props {
  open: boolean
  onClose: () => void
  /** Display label used in the header ("custom strategy for {name}"). */
  label: string
  config: ControllerConfig
  /** Called with the next config when the user saves. */
  onSave: (next: ControllerConfig) => void
}

/**
 * Inline strategy editor. Lets the operator replace the canonical strategy
 * fragment (offensive / defensive / balanced) with arbitrary text for one
 * specific LLM ship. The replacement is applied via `ControllerConfig.customStrategy`
 * and replayed the moment the agent rebuilds (see `App.handleSetController`).
 *
 * Shows the canonical fragment underneath so the operator can see what
 * they're replacing — and crib from it if they want.
 */
export function StrategyEditorModal({ open, onClose, label, config, onSave }: Props) {
  const [draft, setDraft] = useState(config.customStrategy ?? "")

  useEffect(() => {
    if (open) setDraft(config.customStrategy ?? "")
  }, [open, config.customStrategy])

  if (!open) return null

  const canonicalKind = config.strategy ?? "balanced"
  const canonicalText =
    canonicalKind === "offensive"
      ? PROMPT_FRAGMENTS.offensiveStrategy
      : canonicalKind === "defensive"
        ? PROMPT_FRAGMENTS.defensiveStrategy
        : PROMPT_FRAGMENTS.balancedStrategy

  const handleSave = () => {
    const trimmed = draft.trim()
    onSave({
      ...config,
      customStrategy: trimmed.length > 0 ? trimmed : undefined,
    })
    onClose()
  }

  const handleClear = () => {
    onSave({ ...config, customStrategy: undefined })
    setDraft("")
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4 pt-12"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-neutral-100">
              Custom strategy — {label}
            </h2>
            <p className="text-[11px] text-neutral-500">
              Replaces the canonical "{canonicalKind}" fragment in this
              ship's system prompt. Locked once combat starts; until then,
              saving here rebuilds the agent with the new text.
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

        <div className="space-y-3 px-4 py-3">
          <div>
            <label className="mb-1 flex items-baseline gap-2 text-[11px] text-neutral-400">
              <span>Custom text</span>
              <span className="text-[10px] text-neutral-600">
                will be wrapped as ## Combat style: CUSTOM
              </span>
            </label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSave()
                }
              }}
              placeholder='e.g. "ATTACK Bob every round with commit=30; if shields below 20% FLEE toward sector 41."'
              rows={8}
              className="w-full resize-y rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 font-mono text-[11px] text-neutral-200 placeholder:text-neutral-600"
            />
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={handleSave}
                className="rounded bg-emerald-900/40 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-900/60"
              >
                Save (⌘/Ctrl+Enter)
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={!config.customStrategy}
                className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                title="Revert to the canonical strategy fragment"
              >
                Clear override
              </button>
              <span className="ml-auto text-[10px] text-neutral-600">
                {draft.length.toLocaleString()} char
                {draft.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <details className="rounded border border-neutral-800 bg-neutral-900/50">
            <summary className="cursor-pointer px-2 py-1 text-[11px] text-neutral-400">
              canonical "{canonicalKind}" fragment (for reference — what
              you're replacing)
            </summary>
            <pre className="whitespace-pre-wrap border-t border-neutral-800 px-2 py-1.5 font-mono text-[10px] leading-snug text-neutral-500">
              {canonicalText}
            </pre>
          </details>
        </div>
      </div>
    </div>
  )
}
