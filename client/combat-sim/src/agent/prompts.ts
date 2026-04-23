import combatFragment from "./prompts/combat.md?raw"
import combatStrategyFragment from "./prompts/combat_strategy.md?raw"
import gameOverview from "./prompts/game_overview.md?raw"
import howToLoadInfo from "./prompts/how_to_load_info.md?raw"
import taskAgent from "./prompts/task_agent.md?raw"

// ---- Harness-only strategy snippets ----------------------------------------
// Injected AFTER combat_strategy.md to colour the LLM's decision-making. Not
// part of the production prompt pipeline. Not enforced by the engine; purely
// prompt-level guidance. Pick via ControllerConfig.strategy from the UI.

const OFFENSIVE_STRATEGY = `## Combat style: OFFENSIVE

You play aggressively. Default to ATTACK whenever you have a valid hostile target.
- Commit a substantial share of your fleet when attacking — at least half your current fighters.
- Only BRACE if your shields drop below 40%.
- Only FLEE if destruction is otherwise certain (fighters below 20% with no shields).
- PAY tolls only when fighting would clearly destroy you outright; otherwise refuse and attack.`

const DEFENSIVE_STRATEGY = `## Combat style: DEFENSIVE

You play cautiously. Default to BRACE unless you have a clear advantage.
- Open combat with BRACE to rebuild shields and gauge opponent commitment.
- When attacking, probe with small commits (10–20% of your current fighters).
- FLEE eagerly whenever your fighters drop below 50% or shields below 30%.
- PAY tolls rather than fight whenever offered; only refuse if you genuinely cannot afford the toll.`

const BALANCED_STRATEGY = `## Combat style: BALANCED

Play pragmatically. Match force to the threat and cut losses early.
- ATTACK with moderate commit (25–40% of current fighters) when you have a fighter or shield edge.
- BRACE when shields/fighters are healthy but you lack a clear advantage this round.
- The fight is going badly if ANY of these are true:
  - You lost more than 25% of your starting fighters across the last two rounds.
  - Your shields have been below 30% for two consecutive rounds.
  - Fighters below 40% AND shields below 30% in the same round.
  - The opposing commit is clearly larger than yours and you can't match it next round.
- When the fight is going badly, escape — don't fight to the death. Pick ONE:
  - **PAY** if there's an unpaid toll garrison in the encounter and you can afford the toll. Paying ends combat that round (as long as other combatants brace), usually cheaper than more fighter losses. This is the FIRST-CHOICE exit when a toll garrison is present.
  - **FLEE** if there's no toll garrison to pay, the toll is unaffordable, or paying won't end combat (other hostile characters still attacking).
- PAY proactively (not just in emergency) when the toll is small relative to the fighter losses you'd take fighting through the garrison.
- Getting out alive with a weakened ship is a WIN.`

const STRATEGY_FRAGMENTS = {
  offensive: OFFENSIVE_STRATEGY,
  defensive: DEFENSIVE_STRATEGY,
  balanced: BALANCED_STRATEGY,
} as const

export type StrategyKind = keyof typeof STRATEGY_FRAGMENTS

/**
 * Mirrors production's `build_task_agent_prompt()` in
 * `src/gradientbang/utils/prompt_loader.py`. Assembles the same three base
 * fragments, then optionally inlines the combat fragment (production loads
 * it on-demand via `load_game_info(topic="combat")`; the harness includes
 * it eagerly so the agent already "knows" combat when the test runs).
 *
 * The harness-only `combat_strategy` fragment turns the agent into an
 * autonomous per-round decider — it is NOT part of production and lives
 * entirely in this harness. Added when `includeCombatStrategyFragment` is
 * true so the agent knows to call the `combat_action` tool on every
 * `combat.round_waiting`.
 */
export function buildTaskAgentSystemPrompt(options?: {
  includeCombatFragment?: boolean
  includeCombatStrategyFragment?: boolean
  strategy?: StrategyKind
}): string {
  const parts = [gameOverview, howToLoadInfo, taskAgent]
  if (options?.includeCombatFragment !== false) {
    parts.push(combatFragment)
  }
  if (options?.includeCombatStrategyFragment) {
    parts.push(combatStrategyFragment)
  }
  if (options?.strategy && STRATEGY_FRAGMENTS[options.strategy]) {
    parts.push(STRATEGY_FRAGMENTS[options.strategy])
  }
  return parts.join("\n\n")
}

export const PROMPT_FRAGMENTS = {
  gameOverview,
  howToLoadInfo,
  taskAgent,
  combat: combatFragment,
  combatStrategy: combatStrategyFragment,
  offensiveStrategy: OFFENSIVE_STRATEGY,
  defensiveStrategy: DEFENSIVE_STRATEGY,
  balancedStrategy: BALANCED_STRATEGY,
} as const
