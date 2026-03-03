/**
 * Integration tests for corp ship my_status event visibility.
 *
 * Tests cover:
 *   - Corp ship status.snapshot is visible to the actor via events_since
 *   - Corp ship status.snapshot carries task_id when provided
 *   - Corp ship status.snapshot carries corp_id for polling
 *
 * These tests reproduce a bug where the status.snapshot event emitted by
 * my_status for a corp ship was invisible to the polling system because:
 *   1. recipient_character_id was set to the ship's pseudo-character (never polled)
 *   2. corp_id was not set on the event
 *
 * Setup: P1 in sector 0 (mega-port), creates a corp, buys a corp ship.
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  apiOk,
  characterIdFor,
  shipIdFor,
  eventsOfType,
  eventsSince,
  getEventCursor,
  setShipCredits,
  setMegabankBalance,
  createCorpShip,
  queryEvents,
} from "./helpers.ts";

const P1 = "test_corp_status_p1";

let p1Id: string;
let p1ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "corp_ship_status — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Corp ship status.snapshot visible to actor via events_since
// ============================================================================

Deno.test({
  name: "corp_ship_status — status.snapshot visible to actor via corp_id polling",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p1ShipId = await shipIdFor(P1);

    let corpId: string;
    let corpShipId: string;

    await t.step("reset and create corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Status Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;

      // Create a corp ship directly in the DB
      const shipResult = await createCorpShip(corpId, 0, "Status Probe");
      corpShipId = shipResult.pseudoCharacterId;
    });

    let cursorP1: number;

    await t.step("capture cursor before my_status", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("call my_status for corp ship", async () => {
      const result = await apiOk("my_status", {
        character_id: corpShipId,
        actor_character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("actor sees status.snapshot via events_since with corp_id", async () => {
      // The actor (P1) polls events_since with their own character_id and corp_id.
      // The status.snapshot for the corp ship should be visible because the event
      // should carry the corp_id.
      const events = await eventsOfType(p1Id, "status.snapshot", cursorP1, corpId);
      assert(
        events.length >= 1,
        `Expected >= 1 status.snapshot visible to actor via corp_id polling, got ${events.length}. ` +
          "The corp ship status.snapshot event must have corp_id set so it is " +
          "returned by events_since when polling with the corporation's corp_id.",
      );
    });
  },
});

// ============================================================================
// Group 2: Corp ship status.snapshot carries task_id when provided
// ============================================================================

Deno.test({
  name: "corp_ship_status — status.snapshot carries task_id",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and create corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "TaskId Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const shipResult = await createCorpShip(corpId, 0, "TaskId Probe");
      corpShipId = shipResult.pseudoCharacterId;
    });

    const taskId = crypto.randomUUID();

    await t.step("call my_status with task_id", async () => {
      const result = await apiOk("my_status", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
      });
      assert(result.success);
    });

    await t.step("status.snapshot event in DB has task_id set", async () => {
      // Query the events table directly to check the task_id column
      const rows = await queryEvents(
        "event_type = $1 AND ship_id = $2",
        ["status.snapshot", corpShipId],
      );
      assert(rows.length >= 1, `Expected >= 1 status.snapshot in DB, got ${rows.length}`);
      const latestEvent = rows[rows.length - 1];
      assertEquals(
        latestEvent.task_id,
        taskId,
        "status.snapshot event should carry the task_id passed to my_status",
      );
    });
  },
});

// ============================================================================
// Group 3: Corp ship status.snapshot has corp_id set in event row
// ============================================================================

Deno.test({
  name: "corp_ship_status — status.snapshot event row has corp_id",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and create corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "CorpId Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const shipResult = await createCorpShip(corpId, 0, "CorpId Probe");
      corpShipId = shipResult.pseudoCharacterId;
    });

    await t.step("call my_status for corp ship", async () => {
      await apiOk("my_status", {
        character_id: corpShipId,
        actor_character_id: p1Id,
      });
    });

    await t.step("status.snapshot event has corp_id in DB", async () => {
      const rows = await queryEvents(
        "event_type = $1 AND ship_id = $2",
        ["status.snapshot", corpShipId],
      );
      assert(rows.length >= 1, `Expected >= 1 status.snapshot, got ${rows.length}`);
      const latestEvent = rows[rows.length - 1];
      assertEquals(
        latestEvent.corp_id,
        corpId,
        "status.snapshot for a corp ship must have corp_id set so it is " +
          "visible via events_since corp_id polling. Currently corp_id is null " +
          "because my_status does not pass corpId to emitCharacterEvent.",
      );
    });
  },
});
