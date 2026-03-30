"""Tests for idle report scheduling in bot.py."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    LLMMessagesAppendFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from gradientbang.pipecat_server.bot import IdleReportController
from gradientbang.pipecat_server.frames import TaskActivityFrame, UserTextInputFrame


def _make_controller(*, idle_report_result: bool = True) -> tuple[IdleReportController, SimpleNamespace, SimpleNamespace]:
    voice_agent = SimpleNamespace(
        on_idle_report=AsyncMock(return_value=idle_report_result),
        reset_idle_report_cooldown=MagicMock(),
    )
    idle_controller = SimpleNamespace(
        _user_idle_timeout=0.0,
        _user_turn_in_progress=False,
        _function_calls_in_progress=0,
        _start_idle_timer=AsyncMock(),
    )
    controller = IdleReportController(
        voice_agent=voice_agent,
        idle_controller=idle_controller,
        idle_report_time=8.0,
        idle_report_cooldown=30.0,
    )
    controller.push_frame = AsyncMock()
    return controller, voice_agent, idle_controller


@pytest.mark.unit
class TestIdleReportController:
    async def test_user_turn_idle_arms_cooldown_when_report_fires(self):
        controller, voice_agent, idle_controller = _make_controller(idle_report_result=True)

        await controller.on_user_turn_idle()

        voice_agent.on_idle_report.assert_awaited_once()
        assert idle_controller._user_idle_timeout == pytest.approx(30.1)
        idle_controller._start_idle_timer.assert_awaited_once()

    async def test_user_turn_idle_does_nothing_when_report_skips(self):
        controller, voice_agent, idle_controller = _make_controller(idle_report_result=False)

        await controller.on_user_turn_idle()

        voice_agent.on_idle_report.assert_awaited_once()
        idle_controller._start_idle_timer.assert_not_awaited()
        assert idle_controller._user_idle_timeout == 0.0

    async def test_task_activity_resets_cooldown_and_restarts_base_timer(self):
        controller, voice_agent, idle_controller = _make_controller()

        await controller.process_frame(
            TaskActivityFrame(task_id="task-1", activity_type="progress"),
            FrameDirection.DOWNSTREAM,
        )

        voice_agent.reset_idle_report_cooldown.assert_called_once_with()
        assert idle_controller._user_idle_timeout == pytest.approx(8.0)
        idle_controller._start_idle_timer.assert_awaited_once()

    async def test_user_text_input_is_activity(self):
        controller, voice_agent, idle_controller = _make_controller()

        await controller.process_frame(UserTextInputFrame(text="hello"), FrameDirection.DOWNSTREAM)

        voice_agent.reset_idle_report_cooldown.assert_called_once_with()
        idle_controller._start_idle_timer.assert_awaited_once()

    async def test_event_message_is_activity_but_idle_check_is_not(self):
        controller, voice_agent, idle_controller = _make_controller()
        event_frame = LLMMessagesAppendFrame(
            messages=[{"role": "user", "content": '<event name="task.progress">working</event>'}]
        )
        idle_frame = LLMMessagesAppendFrame(
            messages=[{"role": "user", "content": "<idle_check>status</idle_check>"}]
        )

        await controller.process_frame(event_frame, FrameDirection.DOWNSTREAM)
        await controller.process_frame(idle_frame, FrameDirection.DOWNSTREAM)

        voice_agent.reset_idle_report_cooldown.assert_called_once_with()
        idle_controller._start_idle_timer.assert_awaited_once()

    async def test_normal_bot_speech_clears_cooldown(self):
        controller, voice_agent, _ = _make_controller()

        await controller.process_frame(BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        voice_agent.reset_idle_report_cooldown.assert_called_once_with()

    async def test_idle_report_speech_does_not_clear_its_own_cooldown(self):
        controller, voice_agent, idle_controller = _make_controller(idle_report_result=True)

        await controller.on_user_turn_idle()
        await controller.process_frame(BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await controller.process_frame(BotStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        voice_agent.reset_idle_report_cooldown.assert_not_called()
        assert idle_controller._start_idle_timer.await_count == 1

    async def test_activity_during_bot_speech_does_not_restart_idle_timer(self):
        controller, voice_agent, idle_controller = _make_controller()

        await controller.process_frame(BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        idle_controller._start_idle_timer.reset_mock()
        voice_agent.reset_idle_report_cooldown.reset_mock()

        await controller.process_frame(
            TaskActivityFrame(task_id="task-1", activity_type="event"),
            FrameDirection.DOWNSTREAM,
        )

        voice_agent.reset_idle_report_cooldown.assert_called_once_with()
        idle_controller._start_idle_timer.assert_not_awaited()
