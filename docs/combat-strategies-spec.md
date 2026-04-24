# Combat Strategies — Implementation Spec

## Context

Combat today requires players to manually pick `attack`, `brace`, `flee`, or `pay` each round within a 30-second timer. The mechanics are sound (fighters, shields, mitigation, hit chances) but the per-round input loop is a steep learning curve for new players and limits how much LLM-driven behavior we can layer on top.

This spec introduces **combat strategies** — per-ship configuration that describes *how* a ship should fight. A strategy is either one of a small set of built-in templates (offensive, defensive, evasive) or a free-form custom prompt. A ship's strategy is the player's authored policy; a future orchestration layer (out of scope for this spec) will read the strategy at round time and decide what action to submit.

It also adds a new `surrender` combat action that lets a player exit combat with their ship intact but forfeits all cargo and credits to the winning side, and cascades to all corp ships the player controls in the same combat.

It also closes a gap in how players track corp ships they aren't flying with: today, if a corp ship is in a combat the player isn't physically in, the player has no clean way to know how it's going. This spec makes corp-ship combat events flow silently into the voice agent's context and lets players remotely surrender an autonomous corp ship without being present.

This spec covers database schema, edge-function surface, voice-agent tools, and events only. The orchestration agent, UI work, and strategy marketplace are deliberately out of scope.

## Goals

- Keep the existing combat ruleset (fighters, shields, mitigation, hit chances, flee) **unchanged**.
- Add a single new table `combat_strategies` that attaches strategies to ships.
- Support both **template** strategies (for new players) and **custom text** strategies (for veterans).
- Introduce `surrender` as a first-class combat action with credit/cargo forfeiture and corp-ship cascade.
- Let players **remotely surrender** their corporation's autonomous ships without being in the combat themselves.
- Make corp-ship combat events flow into the voice agent's context **silently** so the commander can ask "how's my probe doing?" and get an accurate answer without a stream of unsolicited combat narration.
- Expose the smallest voice-agent surface needed: set, clear, and inspect a ship's strategy; surrender mid-combat (locally or remotely).

## Non-goals

- Server-side orchestration agent behavior (separate spec).
- Client-side UI for strategy editing or combat display.
- Strategy trading, marketplace, or pricing.
- Changes to damage formulas, shield regen, or flee probabilities.
- Combat log analysis / strategy feedback loop.

---

## Data Model

### New table: `combat_strategies`

One row per ship. A ship has zero or one strategy.

```sql
CREATE TABLE combat_strategies (
  strategy_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_id           UUID NOT NULL UNIQUE REFERENCES ship_instances(ship_id) ON DELETE CASCADE,
  template          TEXT NOT NULL
                      CHECK (template IN ('offensive', 'defensive', 'evasive', 'custom')),
  custom_prompt     TEXT,
  author_character_id UUID REFERENCES characters(character_id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A custom strategy must have a prompt; a template strategy must not.
  CONSTRAINT strategy_prompt_matches_template CHECK (
    (template = 'custom' AND custom_prompt IS NOT NULL AND length(custom_prompt) > 0)
    OR
    (template <> 'custom' AND custom_prompt IS NULL)
  )
);

CREATE INDEX idx_combat_strategies_ship ON combat_strategies(ship_id);
CREATE INDEX idx_combat_strategies_author ON combat_strategies(author_character_id);
```

**Why one row per ship:** a ship fights with one doctrine at a time. If we later want stored "preset" strategies that aren't attached to a specific ship (e.g. for trading), we add a separate `strategy_presets` table; this table stays as the active-strategy slot.

**Why `author_character_id`:** keeps a paper trail for corp ships (which character wrote the strategy the corp ship is running) and sets us up cleanly for future trading/sharing without a migration.

**`updated_at` trigger:** add the standard `moddatetime` trigger the repo already uses on other tables.

### Templates

The four allowed values of `template`:

| Template    | Intent                                                                     |
|-------------|----------------------------------------------------------------------------|
| `offensive` | Commit fighters aggressively, favor attack over brace, only flee near-dead |
| `defensive` | Brace by default, attack only when clearly advantaged, retreat early        |
| `evasive`   | Prioritize flee, commit minimum fighters, always choose survival           |
| `custom`    | Use `custom_prompt` text verbatim as the strategy                          |

Template *semantics* (what each one actually does) live in the orchestration layer, not the database. This table just stores the player's choice.

### What's deliberately **not** added

- No column on `ship_instances` — strategy lives in its own table so ship state stays untouched.
- No column on `characters` — strategies attach to ships, not players, so a player carries different doctrines per ship.
- No `stance` column separate from `template` — we collapse "stance" and "strategy type" into a single `template` field. An `offensive` template *is* the aggressive stance.
- No versioning table for strategy history — out of scope. `updated_at` is enough.

---

## New Combat Action: `surrender`

A new `CombatantAction` value alongside `attack | brace | flee | pay`.

### Semantics

When a player submits `surrender`:

1. **Ship survives.** The ship is not destroyed and is not converted to an escape pod. Fighters and shields remain as they are at resolution time.
2. **Ship exits combat immediately.** On round resolution, the surrendering ship is removed from the participant list before attacks resolve (similar to successful flee) — the ship is no longer a valid target.
3. **Ship is relocated.** The ship is moved to a random adjacent sector, same as a successful flee. This keeps it out of the ended-combat sector and gives it a survival beat.
4. **Cargo is forfeited.** All cargo (QF/RO/NS) on the ship is zeroed and deposited into salvage in the combat sector.
5. **Credits are forfeited.** All credits on the ship (not bank) are zeroed and added to the salvage credits pool.
6. **No scrap.** Unlike a destroyed ship, no scrap is produced — the ship isn't wrecked.
7. **Cascade to corp ships.** See below.

The salvage created by a surrender follows the same 15-minute TTL and claim semantics as combat-destruction salvage, and is emitted via `salvage.created`.

### Corp ship cascade (local surrender)

When a character surrenders their own ship:

- Find all ships in the **same active combat** whose `owner_corporation_id` equals the surrendering character's corporation.
- For each such ship still alive in the combat, inject a `surrender` action for it in the same round resolution.
- Those ships forfeit cargo/credits and relocate exactly as the player's ship does.

**Cascade scope:** every corp ship of the surrendering player's corporation currently in this combat. That matches the "you cannot attack corpmates" rule (corp cohesion) and avoids the thorny question of "who is piloting this corp ship." Tighten later if players complain.

### Remote surrender (player not in combat)

A player can order one of their corporation's autonomous ships to surrender without being in the combat themselves. This is the same resolution path as above, scoped to a single ship (no cascade).

**Who can be remotely surrendered:**
- Ships where `owner_type = 'corporation'` AND `owner_corporation_id` equals the caller's corporation.
- Because all corp ships are pseudo-characters (autonomous by design, `player_metadata.player_type = 'corporation_ship'`), the "not human-controlled" constraint is automatically satisfied by this ownership check. **There is no such thing as a human-piloted corp ship** in the current model, so we don't need extra filtering.

**Who cannot be remotely surrendered:**
- Another human player's personal ship, even if they're a corpmate. Personal ships have `owner_type = 'character'` and are filtered out by the ownership check.
- A corp ship owned by a different corporation.
- A ship not currently in an active combat.

**Effect on the target ship:**
- Same as local surrender: ship survives, relocates to a random adjacent sector, forfeits all cargo and credits as salvage in the combat sector, no scrap.
- Emits `combat.surrendered` with `cascade: false` and a new field `remote: true`.
- No further cascade — remote surrender is one-ship-at-a-time. If the commander wants to pull multiple corp ships out of the same fight remotely, they issue multiple surrender orders (or the orchestration layer can fan out; out of scope here).

**If the remote-surrendered ship is the last enemy combatant:** combat ends with `surrender_accepted`, same as local surrender.

### Validation

- Garrisons cannot surrender (they have no cargo/credits and no ship to preserve). Reject `surrender` from garrison combatants.
- Escape pods cannot surrender (nothing left to forfeit, already the minimum state). Reject.
- Cannot surrender if `commit > 0` provided — `commit` must be absent or 0.
- `target_id` is ignored for surrender.
- Remote surrender: target ship must be in active combat, must be a corp ship of the caller's corporation. Otherwise return 400 with a clear error.

### Round timeout behavior

Timeout default remains `brace`. Surrender is an opt-in choice, never a default.

---

## Remote Corp-Ship Combat Awareness

**Problem:** today, when a player's corp ship gets pulled into combat (e.g. an autonomous hauler gets jumped while the player is trading in a different sector), the commander has no clean way to know how that fight is going. Combat events already reach corp members via the existing sector+corp visibility rules, but the voice agent either ignores them or narrates them noisily.

**Goal:** the voice agent should *silently* ingest combat events for the player's corp ships (events they're not directly participating in), retain them in context, and be able to answer "how's the probe doing?" on demand. No unsolicited voice narration.

### Mechanism

Corp combat events (`combat.round_waiting`, `combat.round_resolved`, `combat.ended`, `combat.surrendered`, `ship.destroyed`, `salvage.created`) already route to corp members. We introduce two small changes:

1. **Event tagging.** In `_shared/combat_events.ts`, when a combat event is emitted to a recipient who is NOT a participant in that combat (i.e. a corp observer), include a new top-level field `observer: true` in the payload. Participants and sector observers at the combat site still get `observer: false` / field omitted. This tag is the signal that downstream consumers use to decide "narrate vs. silently absorb."

2. **Voice agent behavior.** The voice agent's system prompt gains a rule: "Combat events with `observer: true` describe combat happening to a corp ship, NOT the commander's own combat. Do NOT narrate these events. Absorb them so you can answer later questions about the corp ship's status. If the commander's own ship enters combat, normal combat narration rules apply." We should also route these events through EventRelay with an `ambient` classification so they land in conversation context without triggering the urgent-announcement path the voice agent uses for the commander's own combat.

### Inspecting corp-ship status on demand

When the commander asks about a corp ship's combat state, the voice agent should answer from context (cheapest path). If context is stale or missing, it falls back to `ships.list`, which we extend:

- `ships.list` entries for ships currently in combat gain a `combat` sub-block:
  ```json
  "combat": {
    "combat_id": "<combat_id>",
    "sector": 42,
    "round": 3,
    "participants_count": 4,
    "last_round_result": null
  }
  ```
- This block is `null` when the ship isn't in combat.
- `my_status` gets the same extension for the commander's personal ship.

No new tool is needed — `ships.list` is already wired into the voice agent and this extension keeps the information path flat.

### Prompt fragment

Add a short section to `src/gradientbang/prompts/fragments/combat.md` (or a new `corp_combat.md` fragment) covering:
- "Observer events": what `observer: true` means, when to narrate vs stay silent.
- "Asking about a corp ship in combat": route through `ships.list` first, use context as a fallback for details the structured data doesn't carry (who attacked, last-round recap).
- "Proactive alerts": break silence for exactly three observer events on our own corp ships:
  - `combat.round_waiting` for round 1 of a new combat → "Commander, one of our ships just entered combat in sector X."
  - `combat.ended` → "Commander, the probe's combat has ended — result: <outcome>."
  - `ship.destroyed` for one of our corp ships → "Commander, we've lost the probe in sector X."
  - Everything else (round resolutions, mid-combat surrenders, salvage-created) stays silent and is only surfaced on request.

---

## Edge Function Changes

### `combat_action`

Add `surrender` to `normalizeAction()` and extend `buildActionState()` with a `surrender` branch that stores the action with `commit = 0`, `target_id = null`, `destination_sector = null`.

### `combat_resolution.ts` / `combat_engine.ts`

Add a surrender resolution step, ordered **before** flee resolution (surrender is unconditional; flee has a dice roll):

1. Collect all surrendering combatants.
2. For each, zero out `credits` and cargo on the ship, capture totals.
3. Pick a random adjacent sector, move the ship there, remove from combat participant set.
4. Emit one `salvage.created` per surrendering ship (pooled cargo + credits from that ship).
5. Apply corp-ship cascade: for each surrendering player, add derived surrender actions for eligible corp ships.

Process attacks against the remaining participants only after surrender removal.

### Terminal-state logic

Update the end-of-combat check so that if the only ships left fighting are all friendly (e.g. the opposing side all surrendered), combat ends in a new `surrender_accepted` terminal state. Payload shape matches existing terminal states.

### New edge functions for strategy management

Two thin endpoints, consistent with existing `combat_set_garrison_mode` style:

- `combat_set_strategy` — upsert a `combat_strategies` row for a given `ship_id`. Body: `{ ship_id, template, custom_prompt? }`. Authorization: caller must own the ship (character or corp-ship pseudo-character, matching existing ownership rules).
- `combat_clear_strategy` — delete the row for a given `ship_id`.

`combat_get_strategy` is **not** needed — strategy can be surfaced via `ships.list` / `my_status` payload extensions (see below).

### New edge function for remote surrender

- `combat_surrender_ship` — surrender a specific corp ship that is currently in combat. Body: `{ ship_id }`.
  - Validates that `ship_id` refers to a ship with `owner_type = 'corporation'` AND `owner_corporation_id` matching the caller's corporation.
  - Validates that the ship is currently in an active combat (via `sector_contents.combat` lookup).
  - Derives the `combat_id` from the ship's sector, injects a `surrender` action for that ship into the current round, and triggers round resolution if the round is now complete.
  - Emits `combat.surrendered` with `remote: true, cascade: false`.
  - Returns 400 if any validation fails (ship not in combat, not a corp ship, wrong corp).

Local surrender continues to go through `combat_action` (`action: "surrender"`). Remote surrender goes through this dedicated endpoint so the authorization model is unambiguous and we never accidentally accept a `combat_action` from a player who isn't a participant.

### Status payload extensions

Extend the `ship` block returned by `my_status`, `ships.list`, and the `combat.round_waiting` participant entry with:

```json
"strategy": {
  "template": "offensive",
  "custom_prompt": null,
  "updated_at": "2026-04-22T12:00:00Z"
}
```

`strategy` is `null` when no row exists.

---

## Voice Agent Tools

Three new tools in `src/gradientbang/tools/schemas.py`, added to `VOICE_TOOLS`. All three are direct tools (no task required) since they're fast, idempotent configuration changes.

### `set_combat_strategy`

```python
SET_COMBAT_STRATEGY = FunctionSchema(
  name="set_combat_strategy",
  description=(
    "Set or update the combat strategy for a ship. Strategy determines how the ship "
    "fights when engaged in combat. Use template='custom' with custom_prompt for "
    "free-form strategies; otherwise pick offensive, defensive, or evasive."
  ),
  properties={
    "template": {
      "type": "string",
      "enum": ["offensive", "defensive", "evasive", "custom"],
      "description": "Strategy template. Use 'custom' when providing custom_prompt.",
    },
    "custom_prompt": {
      "type": "string",
      "description": "Free-form strategy text. Required when template='custom'; omit otherwise.",
    },
    "ship_id": {
      "type": "string",
      "description": "Target ship ID. Omit to target the commander's personal ship; pass a corp ship ID to configure a corp ship.",
    },
  },
  required=["template"],
)
```

### `clear_combat_strategy`

```python
CLEAR_COMBAT_STRATEGY = FunctionSchema(
  name="clear_combat_strategy",
  description="Remove the combat strategy from a ship so it reverts to default behavior.",
  properties={
    "ship_id": {
      "type": "string",
      "description": "Target ship ID. Omit for the commander's personal ship.",
    },
  },
  required=[],
)
```

### `surrender`

```python
SURRENDER = FunctionSchema(
  name="surrender",
  description=(
    "Surrender in combat. The ship survives and relocates to an adjacent sector, but "
    "ALL cargo and credits on the ship are forfeited as salvage. Use only when the "
    "commander explicitly asks to surrender, yield, or give up.\n\n"
    "Two modes:\n"
    "- LOCAL: omit ship_id. Surrenders the commander's own ship in their current "
    "combat. Cascades to all corp ships in the same combat.\n"
    "- REMOTE: pass ship_id of a corporation ship. Surrenders that single corp ship "
    "in its own combat, even if the commander is elsewhere. No cascade. Only works "
    "for the commander's corporation's ships."
  ),
  properties={
    "combat_id": {
      "type": "string",
      "description": (
        "Active combat encounter identifier. Required for LOCAL surrender. "
        "Omit for REMOTE surrender — the server resolves the combat from ship_id."
      ),
    },
    "ship_id": {
      "type": "string",
      "description": (
        "Corp ship ID for REMOTE surrender. Omit for LOCAL surrender of the "
        "commander's personal ship."
      ),
    },
    "round_number": {
      "type": "integer",
      "description": "Optional round hint for concurrency control (LOCAL only).",
    },
  },
  required=[],
)
```

`surrender` compiles to a `combat_action` call with `action="surrender"` under the hood (LOCAL mode) or to a dedicated remote-surrender edge call (REMOTE mode). We expose it as a distinct tool because it's a significant, irreversible choice and we want the voice agent's prompt routing to treat it that way (not auto-fire it from a casual "I'm done" phrasing).

**Voice agent guidance to add to the prompt:**
- "Surrender my ship" / "I surrender" / "yield" → LOCAL surrender (no `ship_id`).
- "Surrender the probe" / "pull the hauler out, tell it to surrender" / "have [corp ship name] surrender" → REMOTE surrender with that ship's `ship_id`.
- "Surrender all my corp ships" when the commander is NOT in combat → fan out multiple REMOTE `surrender` calls in a single response, one per corp ship currently in combat. No dedicated bulk endpoint — the voice agent is responsible for the fan-out.

### Prompt fragment updates

`src/gradientbang/prompts/fragments/combat.md` needs:
- New row in the actions table for `surrender` with the "ship survives, cargo+credits lost, cascades to corp ships" summary.
- New section "Strategies" describing templates and custom prompts, pointing the agent at `set_combat_strategy`.
- Updated guidance: "If the commander says surrender/yield/give up mid-combat, call `surrender` — don't try to flee or brace instead."

---

## New Event Types

### `combat.strategy_set`

Emitted after `combat_set_strategy` succeeds. Direct to the owning character (and the corp if corp-owned).

```json
{
  "source": { "type": "rpc", "method": "combat.set_strategy", "request_id": "...", "timestamp": "..." },
  "ship_id": "<ship_id>",
  "strategy": {
    "template": "custom",
    "custom_prompt": "Open aggressive. If below 50 fighters, flee.",
    "updated_at": "2026-04-22T12:00:00Z"
  },
  "player": { "id": "<character_id>" }
}
```

### `combat.strategy_cleared`

Emitted after `combat_clear_strategy`. Same recipients.

```json
{
  "source": { "type": "rpc", "method": "combat.clear_strategy", "request_id": "...", "timestamp": "..." },
  "ship_id": "<ship_id>",
  "player": { "id": "<character_id>" }
}
```

### `combat.surrendered`

Emitted per surrendering ship on round resolution. Fired **before** `combat.round_resolved` so the UI/voice agent can narrate it in order. Sector-visible (everyone in combat sees who surrendered) plus direct to the surrendering player plus corp-observer (so corp members see remote/cascade surrenders of their corp ships).

```json
{
  "source": { "type": "rpc", "method": "combat.round_resolved", "request_id": "...", "timestamp": "..." },
  "combat_id": "<combat_id>",
  "sector": { "id": 42 },
  "round": 3,
  "ship_id": "<ship_id>",
  "ship_name": "Asteria",
  "player_name": "Captain Vega",
  "cascade": false,
  "remote": false,
  "ordered_by_character_id": null,
  "forfeit": {
    "credits": 9520,
    "cargo": { "quantum_foam": 3, "retro_organics": 0, "neuro_symbolics": 0 }
  },
  "relocated_to_sector": 37,
  "salvage_id": "<salvage_id>",
  "observer": false
}
```

Field semantics:
- `cascade: true` — surrender was triggered by a corp leader's local surrender, not a direct order to this ship.
- `remote: true` — surrender was issued by a player who was NOT in this combat (via `combat_surrender_ship`).
- `ordered_by_character_id` — set when `remote: true` to identify who issued the order; useful for audit/log coloring. Null for local and cascade surrenders (order is implicit).
- `observer: true` — set when delivered to a recipient who is not a combat participant (corp-wide visibility). See "Remote Corp-Ship Combat Awareness."

A single surrender can have at most one of `cascade` or `remote` true. Both false = the player surrendered their own ship as a direct action in their own combat.

### Extensions to existing events

- `combat.round_resolved.actions` will now include `"surrender"` as a valid action value.
- `combat.ended.result` and `.end` get a new terminal state: `surrender_accepted` (all opposition surrendered).
- `combat.round_waiting.participants[].ship.strategy` — optional strategy block (see status payload extensions).

---

## Major Lifts

These are the larger pieces of work hidden inside this spec. Worth calling out so we size them before committing.

### 1. Reconciling corp-ship ownership for the cascade

The existing code has two columns, `owner_character_id` and `owner_corporation_id`, plus the pseudo-character pattern where `character_id == ship_id` for corp ships. The cascade needs a reliable way to answer "what corp ships is this character currently piloting in this combat?" We may need a helper in `_shared/combat_participants.ts` that resolves a character's controlled corp ships in a given combat encounter. **Not trivial — expect an afternoon.**

### 2. Surrender resolution ordering

Surrender must run before attacks resolve, because surrendered ships shouldn't take damage in the round they surrender. That reorders `resolveRound` in `combat_engine.ts`. Flee currently has similar pre-resolution handling, so the scaffolding exists, but we need to be careful that:
- Ships that attack a ship that surrenders this round don't waste their commit.
- Ships that surrender don't process their own attack commit (if the player toggled between attack and surrender in the same round, surrender wins).

### 3. Salvage accounting for multi-ship surrender

When a player + their corp ships all surrender in the same round, we create multiple salvage entries in the same sector. Confirm the existing `salvage` model handles N simultaneous salvages cleanly (it should — salvage is keyed by `salvage_id`, not by source ship) and that `combat.ended` / `salvage.created` events scale to the N-surrender case.

### 4. Authorization for `combat_set_strategy` on corp ships

Setting a strategy on a corp ship should be allowed by any corp member (consistent with "any corpmate can task a corp ship"). Setting a strategy on a character-owned ship must be restricted to that character. Confirm this matches existing auth patterns in `combat_set_garrison_mode` rather than inventing something new.

### 5. Retention of `custom_prompt` text

Custom prompts are player-authored text we'll later feed into an LLM. That means:
- Content-moderation / profanity policy: we don't have one yet. For MVP, store raw and accept the risk — custom prompts are player-visible only to themselves and their corp.
- Size limit: enforce `length(custom_prompt) <= 2000` in the CHECK constraint or in the edge function. Add to the spec once we settle on a limit.

### 6. `observer` tagging and voice-agent ambient routing

Tagging corp-observer combat events with `observer: true` is a small payload change, but wiring the voice agent to treat those events as ambient context (not voice narration) is a prompt and EventRelay change of moderate size. Watch for:
- False positives where the commander's *own* combat event gets tagged as observer (would cause silent missed narration — much worse failure mode than an extra narration).
- Context bloat: a long-running corp combat with many rounds could flood the voice agent's context with round-resolved events. We may need an EventRelay rule that collapses prior round events when a new one arrives for the same `combat_id` (keep the latest snapshot, drop prior).

### 7. Remote surrender authorization vs existing `combat_action` auth

`combat_action` today assumes the caller is a participant in the combat. Remote surrender deliberately isn't. We're keeping remote surrender on a separate edge function (`combat_surrender_ship`) specifically so we don't have to relax the participant check in `combat_action`. Worth double-checking no other edge function silently assumes "if you're referenced in a combat event you're a participant" — the new corp-observer events break that assumption.

---

## Verification

Once implemented:

1. **Schema**: `npx supabase migration up --workdir deployment` applies the migration cleanly. `select * from combat_strategies` returns empty on a fresh DB.
2. **Set/clear round-trip**: via `combat_set_strategy` → strategy appears in `my_status`. `combat_clear_strategy` → gone.
3. **Custom prompt validation**: setting `template='custom'` with no `custom_prompt` returns 400. Setting `template='offensive'` with a `custom_prompt` returns 400.
4. **Surrender, solo**: two-player combat, one surrenders → surrenderer's ship is in an adjacent sector with 0 credits, 0 cargo; salvage appears in combat sector with the forfeited credits/cargo; combat ends with `surrender_accepted`.
5. **Surrender cascade**: player + 2 corp ships in combat against a third party, player surrenders → all three ships relocate and forfeit; three salvages created; one `combat.surrendered` event per ship (one `cascade: false`, two `cascade: true`).
6. **Surrender vs attack ordering**: same round, attacker commits against surrenderer → attacker's fighters are not consumed on the surrendered target (attack against a missing target degrades to brace per existing rules).
7. **Remote surrender, happy path**: player in sector A trading; their corp probe in sector B is in combat; player says "surrender the probe" → `surrender` tool fires with `ship_id`; probe relocates to an adjacent sector of B, forfeits cargo/credits; `combat.surrendered` arrives with `remote: true, cascade: false`; player's ship is undisturbed.
8. **Remote surrender, rejected**: player attempts to remote-surrender another human corpmate's personal ship → 400 with "ship is not a corporation ship." Player attempts to remote-surrender a ship not in combat → 400 with "ship is not in an active combat."
9. **Corp-observer events**: player in sector A not in combat; their corp ship is in combat in sector B → player's voice agent receives `combat.round_waiting` / `combat.round_resolved` / `combat.surrendered` with `observer: true`; voice agent does NOT speak them unless the player asks. Player asks "how's my probe doing?" → voice agent answers from context (round number, last round's losses, participants).
10. **Proactive alerts**: voice agent breaks silence on exactly three observer events — combat start (round 1 `combat.round_waiting`), `combat.ended`, and `ship.destroyed` — each a single short sentence. Round-by-round observer events stay silent.
11. **Voice agent**: "set my strategy to aggressive" → `set_combat_strategy(template="offensive")`. "Set a custom strategy: open aggressive, flee below 50 fighters" → `set_combat_strategy(template="custom", custom_prompt="...")`. "Surrender" during combat → `surrender()` (local). "Surrender the probe" out of combat → `surrender(ship_id=...)` (remote).
12. **Integration tests**: extend `deployment/supabase/functions/tests/combat_test.ts` with (a) surrender scenario, (b) local cascade scenario, (c) remote surrender happy path, (d) remote surrender authorization failures. Extend Python integration tests under `scripts/run-integration-tests.sh` with a set-strategy round-trip.

## Critical files to touch

- `deployment/supabase/migrations/<new_timestamp>_combat_strategies.sql` — new table + trigger
- `deployment/supabase/functions/_shared/combat_types.ts` — extend `CombatantAction`, add `surrender_accepted` terminal state
- `deployment/supabase/functions/_shared/combat_engine.ts` — surrender resolution ordering
- `deployment/supabase/functions/_shared/combat_resolution.ts` — salvage/event emission for surrenders, cascade logic, remote-surrender injection
- `deployment/supabase/functions/_shared/combat_events.ts` — new event builders; `observer` tagging for corp-wide recipients
- `deployment/supabase/functions/_shared/combat_participants.ts` — controlled-corp-ships lookup helper; "ship currently in combat" lookup for remote surrender
- `deployment/supabase/functions/combat_action/index.ts` — `surrender` branch in `buildActionState`
- `deployment/supabase/functions/combat_set_strategy/index.ts` — new edge function
- `deployment/supabase/functions/combat_clear_strategy/index.ts` — new edge function
- `deployment/supabase/functions/combat_surrender_ship/index.ts` — new edge function (remote surrender)
- `src/gradientbang/tools/schemas.py` — `SET_COMBAT_STRATEGY`, `CLEAR_COMBAT_STRATEGY`, `SURRENDER`; update `COMBAT_ACTION` enum; extend `MY_STATUS` / `SHIPS_LIST` return docs with `combat` block
- `src/gradientbang/tools/__init__.py` — register new tools on `VOICE_TOOLS` (and `TASK_TOOLS` for `surrender` only, so task agents can surrender mid-task)
- `src/gradientbang/pipecat_server/subagents/event_relay.py` — ambient routing for observer-tagged combat events; collapse prior round events per `combat_id` to prevent context bloat
- `src/gradientbang/prompts/fragments/combat.md` — document surrender (local + remote), strategies, and observer-event behavior
- `docs/combat.md` and `docs/combat-events.md` — update the canonical docs once merged
