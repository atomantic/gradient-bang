-- =============================================================================
-- Fix: prevent duplicate events for corp member event subjects
-- Date: 2026-03-02
--
-- Problem: When the event subject (p_character_id) is an active member of the
-- target corporation (p_corp_id), the function creates both an individual row
-- (self-event exception from 20260227183211) and a corp row. events_since
-- matches both when the client polls with character_id + corp_id, producing
-- a duplicate for every corp-scoped action (warp, fighters, trade, move, etc).
--
-- Fix: Remove the self-event exception. Corp member subjects receive events
-- via the corp row only. To preserve fallback delivery (so the subject can
-- still find its own events when polling without corp_id), set
-- recipient_character_id on the corp row when the subject is a corp member.
-- This merges the two rows into one:
--
--   Before: individual (char=P1, corp=NULL) + corp (char=NULL, corp=A) → 2 matches
--   After:  merged corp (char=P1, corp=A)                              → 1 match
-- =============================================================================

SET check_function_bodies = OFF;
SET search_path = public;

CREATE OR REPLACE FUNCTION public.record_event_with_recipients(
  p_event_type TEXT,
  p_direction TEXT DEFAULT 'event_out',
  p_scope TEXT DEFAULT 'direct',
  p_actor_character_id UUID DEFAULT NULL,
  p_corp_id UUID DEFAULT NULL,
  p_sector_id INTEGER DEFAULT NULL,
  p_ship_id UUID DEFAULT NULL,
  p_character_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_meta JSONB DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL,
  p_recipients UUID[] DEFAULT ARRAY[]::UUID[],
  p_reasons TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_is_broadcast BOOLEAN DEFAULT FALSE,
  p_task_id UUID DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first_event_id BIGINT;
  v_now TIMESTAMPTZ := NOW();
  v_has_recipients BOOLEAN := COALESCE(array_length(p_recipients, 1), 0) > 0;
  v_subject_is_corp_member BOOLEAN := FALSE;
BEGIN
  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN
    RAISE EXCEPTION 'recipient/reason length mismatch'
      USING ERRCODE = '22023';
  END IF;

  -- Check if the event subject is an active member of the target corporation.
  -- When true, the subject's delivery is merged into the corp row (by setting
  -- recipient_character_id on it) instead of creating a separate individual row.
  IF p_corp_id IS NOT NULL AND p_character_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.corporation_members cm
      WHERE cm.character_id = p_character_id
        AND cm.corp_id = p_corp_id
        AND cm.left_at IS NULL
    ) INTO v_subject_is_corp_member;
  END IF;

  -- Individual recipient rows (corp_id is always NULL on these).
  -- When a corp_id is provided, ALL active corp members are excluded —
  -- they receive the event via the corp row instead.
  IF v_has_recipients THEN
    WITH inserted AS (
      INSERT INTO public.events (
        direction, event_type, scope, actor_character_id, corp_id,
        sector_id, ship_id, character_id, sender_id, payload, meta,
        request_id, task_id, inserted_at,
        recipient_character_id, recipient_reason, is_broadcast
      )
      SELECT
        p_direction, p_event_type, p_scope, p_actor_character_id,
        NULL,  -- corp_id is NULL on individual rows
        p_sector_id, p_ship_id, p_character_id, p_sender_id,
        COALESCE(p_payload, '{}'::jsonb), p_meta,
        p_request_id, p_task_id, v_now,
        t.recipient, t.reason, FALSE
      FROM UNNEST(p_recipients, p_reasons) AS t(recipient, reason)
      WHERE p_corp_id IS NULL
         OR t.recipient NOT IN (
              SELECT cm.character_id
              FROM public.corporation_members cm
              WHERE cm.corp_id = p_corp_id
                AND cm.left_at IS NULL
            )
      RETURNING id
    )
    SELECT MIN(id) INTO v_first_event_id FROM inserted;
  END IF;

  -- Corp row: one row for the corporation.
  -- When the subject is a corp member, set recipient_character_id so the
  -- subject can also find this event by character_id alone (without needing
  -- corp_id in the poll). This merges individual + corp delivery into one row.
  IF p_corp_id IS NOT NULL AND NOT p_is_broadcast THEN
    INSERT INTO public.events (
      direction, event_type, scope, actor_character_id, corp_id,
      sector_id, ship_id, character_id, sender_id, payload, meta,
      request_id, task_id, inserted_at,
      recipient_character_id, recipient_reason, is_broadcast
    ) VALUES (
      p_direction, p_event_type, p_scope, p_actor_character_id, p_corp_id,
      p_sector_id, p_ship_id, p_character_id, p_sender_id,
      COALESCE(p_payload, '{}'::jsonb), p_meta,
      p_request_id, p_task_id, v_now,
      CASE WHEN v_subject_is_corp_member THEN p_character_id ELSE NULL END,
      'corp_broadcast', FALSE
    );
    -- Set first event id if no recipients were inserted
    IF v_first_event_id IS NULL THEN
      SELECT currval(pg_get_serial_sequence('public.events', 'id')) INTO v_first_event_id;
    END IF;
  END IF;

  -- Broadcast row (corp_id is NULL, no individual recipient)
  IF p_is_broadcast AND NOT v_has_recipients THEN
    INSERT INTO public.events (
      direction, event_type, scope, actor_character_id, corp_id,
      sector_id, ship_id, character_id, sender_id, payload, meta,
      request_id, task_id, inserted_at,
      recipient_character_id, recipient_reason, is_broadcast
    ) VALUES (
      p_direction, p_event_type, p_scope, p_actor_character_id,
      NULL,  -- corp_id is NULL on broadcast rows
      p_sector_id, p_ship_id, p_character_id, p_sender_id,
      COALESCE(p_payload, '{}'::jsonb), p_meta,
      p_request_id, p_task_id, v_now,
      NULL, NULL, TRUE
    ) RETURNING id INTO v_first_event_id;
  END IF;

  RETURN v_first_event_id;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts denormalized event rows (one-of individual/corp/broadcast per row). Corp members are excluded from individual rows when corp_id is set; they receive events via the corp row. When the subject is a corp member, the corp row includes their character_id for fallback delivery. Returns first event ID.';
