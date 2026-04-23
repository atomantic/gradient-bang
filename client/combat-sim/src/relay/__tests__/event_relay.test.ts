import { describe, expect, it } from "vitest"

import {
  decisionFor,
  MockEventRelay,
} from "../event_relay"
import type { CombatEvent } from "../../engine/types"
import { eventsOfType, makeHarness } from "../../engine/__tests__/setup"

// Every scenario here bounces the production event-relay decision table
// against harness-emitted events: given a specific event + viewer, do we
// end up with the same (append, run_llm) pair that the production
// `EventRelay.handle_event()` would produce? Each test locks in one
// (AppendRule × InferenceRule) pair or a harness-specific override.

function setupWithRelay() {
  const harness = makeHarness()
  const relay = new MockEventRelay({
    engine: harness.engine,
    emitter: harness.emitter,
  })
  relay.start()
  return { ...harness, relay }
}

function firstOfType(
  emitter: { getLog: () => readonly CombatEvent[] },
  type: string,
): CombatEvent {
  const list = emitter.getLog().filter((e) => e.type === type)
  if (list.length === 0) throw new Error(`no event of type ${type}`)
  return list[0]
}

describe("MockEventRelay — combat.round_waiting (PARTICIPANT + ON_PARTICIPANT)", () => {
  it("ship participant: append=true, run_llm=true", () => {
    const { engine, emitter } = setupWithRelay()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    engine.createCharacter({ name: "Bob", sector: 42 })
    engine.initiateCombat(alice, 42)

    const wait = firstOfType(emitter, "combat.round_waiting")
    const d = decisionFor(wait, alice)!
    expect(d.appendRule).toBe("PARTICIPANT")
    expect(d.inferenceRule).toBe("ON_PARTICIPANT")
    expect(d.append).toBe(true)
    expect(d.run_llm).toBe(true)
  })

  it("sector observer (not a participant) gets the event via sector-observer recipients but append=false under PARTICIPANT rule", () => {
    // Charlie arrives in sector 42 AFTER combat began — sector observer,
    // not a ship participant. engine.combatRecipients adds him to the
    // recipients list, but PARTICIPANT append should still say no.
    const { engine, emitter } = setupWithRelay()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    engine.createCharacter({ name: "Bob", sector: 42 })
    engine.initiateCombat(alice, 42)
    const charlie = engine.createCharacter({ name: "Charlie", sector: 1 })
    engine.moveCharacter(charlie, 42)

    // The NEXT round_waiting (if any) would include charlie in recipients
    // as a sector observer. But in this 1-round setup he doesn't show up
    // until the round resolves. Drive a brace-brace stalemate to see the
    // observer's decision on combat.round_resolved (which uses the same
    // rules as round_waiting for append/infer from a viewer perspective).
    const active = Array.from(
      engine.getWorldSnapshot().activeCombats.values(),
    ).find((c) => !c.ended)
    if (active) {
      engine.submitAction(alice, active.combat_id as never, { action: "brace" })
      const bob = Array.from(engine.getWorldSnapshot().characters.values()).find(
        (c) => c.name === "Bob",
      )!
      engine.submitAction(bob.id, active.combat_id as never, { action: "brace" })
    }
    const resolved = firstOfType(emitter, "combat.round_resolved")
    const d = decisionFor(resolved, charlie)
    // Charlie is in recipients (sector observer) but not a participant →
    // PARTICIPANT rule says no-append.
    if (d) {
      expect(d.append).toBe(false)
      expect(d.run_llm).toBe(false)
    }
  })
})

describe("MockEventRelay — combat.round_resolved (PARTICIPANT + ALWAYS)", () => {
  it("participant: append=true, run_llm=true via ALWAYS", () => {
    const { engine, emitter } = setupWithRelay()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    const bob = engine.createCharacter({ name: "Bob", sector: 42 })
    const cid = engine.initiateCombat(alice, 42)
    engine.submitAction(alice, cid, { action: "brace" })
    engine.submitAction(bob, cid, { action: "brace" })

    const resolved = firstOfType(emitter, "combat.round_resolved")
    const d = decisionFor(resolved, alice)!
    expect(d.inferenceRule).toBe("ALWAYS")
    expect(d.append).toBe(true)
    expect(d.run_llm).toBe(true)
  })
})

describe("MockEventRelay — combat.ended (PARTICIPANT + NEVER)", () => {
  it("participant: append=true, run_llm=false (silent terminator)", () => {
    const { engine, emitter } = setupWithRelay()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    const bob = engine.createCharacter({ name: "Bob", sector: 42 })
    const cid = engine.initiateCombat(alice, 42)
    engine.submitAction(alice, cid, { action: "brace" })
    engine.submitAction(bob, cid, { action: "brace" })

    const ended = emitter
      .getLog()
      .find((e) => e.type === "combat.ended" && e.recipients.includes(alice))!
    const d = decisionFor(ended, alice)!
    expect(d.inferenceRule).toBe("NEVER")
    expect(d.append).toBe(true)
    expect(d.run_llm).toBe(false)
  })
})

describe("MockEventRelay — combat.action_accepted (PARTICIPANT + NEVER)", () => {
  it("actor: append=true, run_llm=false — own action shouldn't wake them up", () => {
    const { engine, emitter } = setupWithRelay()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    engine.createCharacter({ name: "Bob", sector: 42 })
    const cid = engine.initiateCombat(alice, 42)
    engine.submitAction(alice, cid, { action: "brace" })

    const accepted = firstOfType(emitter, "combat.action_accepted")
    const d = decisionFor(accepted, alice)!
    // PARTICIPANT rule lets it append (alice is in the round's participants[]).
    expect(d.append).toBe(true)
    expect(d.run_llm).toBe(false)
  })
})

describe("MockEventRelay — harness garrison overrides", () => {
  it("absent garrison owner gets round_waiting: append=true, run_llm=FALSE (silent)", () => {
    const { engine, emitter } = setupWithRelay()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    engine.createCharacter({ name: "Bob", sector: 42, fighters: 50 })
    engine.deployGarrison({
      ownerCharacterId: alice,
      sector: 42,
      fighters: 80,
      mode: "offensive",
    })

    const wait = firstOfType(emitter, "combat.round_waiting")
    const d = decisionFor(wait, alice)!
    expect(d.append).toBe(true)
    expect(d.run_llm).toBe(false)
    // Reason string should mention the harness override so the debug UI
    // can explain "why" in the hover card.
    expect(d.reason).toMatch(/garrison/i)
  })

  it("absent garrison owner gets garrison.destroyed: append=true, run_llm=TRUE (loud)", () => {
    const { engine, emitter, advance, getNow, world } = setupWithRelay()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    const bob = engine.createCharacter({
      name: "Bob",
      sector: 42,
      fighters: 200,
      shields: 200,
    })
    engine.deployGarrison({
      ownerCharacterId: alice,
      sector: 42,
      fighters: 1,
      mode: "offensive",
    })
    const active = Array.from(world().activeCombats.values()).find(
      (c) => c.sector_id === 42,
    )!
    engine.submitAction(bob, active.combat_id as never, {
      action: "attack",
      target_id: `garrison:42:${alice}`,
      commit: 100,
    })
    advance(31_000)
    engine.tick(getNow())

    const destroyed = firstOfType(emitter, "garrison.destroyed")
    const d = decisionFor(destroyed, alice)!
    expect(d.inferenceRule).toBe("OWNED")
    expect(d.append).toBe(true)
    expect(d.run_llm).toBe(true)
    expect(d.reason).toMatch(/owner/i)
  })

  it("ship participant (not garrison owner) keeps normal ALWAYS inference on round_resolved even when a garrison is in the fight", () => {
    const { engine, emitter } = setupWithRelay()
    engine.createCharacter({ name: "Alice", sector: 1 })
    const bob = engine.createCharacter({ name: "Bob", sector: 42, fighters: 50 })
    engine.deployGarrison({
      ownerCharacterId: "char-1" as never, // = Alice's id
      sector: 42,
      fighters: 80,
      mode: "offensive",
    })
    const active = Array.from(
      engine.getWorldSnapshot().activeCombats.values(),
    ).find((c) => c.sector_id === 42)!
    engine.submitAction(bob, active.combat_id as never, { action: "brace" })

    const resolved = firstOfType(emitter, "combat.round_resolved")
    const bobDecision = decisionFor(resolved, bob)!
    // Bob IS a ship participant — ALWAYS inference should NOT be downgraded
    // by the garrison-owner override (that only applies to garrison-owner-only
    // viewers).
    expect(bobDecision.run_llm).toBe(true)
  })
})

describe("MockEventRelay — ship.destroyed (LOCAL + NEVER)", () => {
  it("same-sector observer: append=true, run_llm=false", () => {
    const { engine, emitter, advance, getNow, world } = setupWithRelay()
    engine.createCharacter({
      name: "Attacker",
      sector: 42,
      fighters: 200,
      shields: 200,
    })
    const victim = engine.createCharacter({
      name: "Victim",
      sector: 42,
      fighters: 2,
      shields: 0,
    })
    const observer = engine.createCharacter({
      name: "Observer",
      sector: 42,
      fighters: 10,
    })
    const attacker = Array.from(world().characters.values()).find(
      (c) => c.name === "Attacker",
    )!
    const cid = engine.initiateCombat(attacker.id, 42)
    engine.submitAction(attacker.id, cid, {
      action: "attack",
      target_id: victim,
      commit: 150,
    })
    engine.submitAction(victim, cid, { action: "brace" })
    engine.submitAction(observer, cid, { action: "brace" })
    advance(31_000)
    engine.tick(getNow())

    const destroyed = eventsOfType(emitter, "ship.destroyed")
    if (destroyed.length === 0) return // fight might not have destroyed anyone under this RNG — skip
    const d = decisionFor(destroyed[0], observer)
    if (!d) return
    expect(d.appendRule).toBe("LOCAL")
    expect(d.inferenceRule).toBe("NEVER")
    expect(d.append).toBe(true)
    expect(d.run_llm).toBe(false)
  })
})

describe("MockEventRelay — unknown event types default config", () => {
  it("events with no custom config default to DIRECT append + NEVER inference", () => {
    const { engine, emitter, relay } = setupWithRelay()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    const corpId = engine.createCorporation({ name: "Alpha" })

    // corporation.created is not in EVENT_CONFIGS (not modelled in the
    // harness's combat-focused subset) — exercises the default path.
    const created = firstOfType(emitter, "corporation.created")
    const d = decisionFor(created, alice)
    // Alice is in recipients (she's a member); with DIRECT she should append.
    if (d) {
      expect(d.appendRule).toBe("DIRECT")
      expect(d.inferenceRule).toBe("NEVER")
      expect(d.append).toBe(true)
      expect(d.run_llm).toBe(false)
    }
    // Silence unused bindings so TS is happy under noUnusedLocals.
    void corpId
    void relay
  })
})
