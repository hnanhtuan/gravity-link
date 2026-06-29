import os
import json
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import AsyncClient, ASGITransport

import pytest_asyncio

from src.main import app, sdk_wrapper
from src.sdk_wrapper import AntigravitySDKWrapper, ArtifactApprovalHook
from google.antigravity import types


@pytest_asyncio.fixture(autouse=True)
async def cleanup_sdk_wrapper():
    """Ensure the wrapper is reset between test cases."""
    await sdk_wrapper.cancel_task()
    sdk_wrapper.agent_state = "Idle"
    sdk_wrapper.current_artifact = None
    sdk_wrapper.review_decision = None
    sdk_wrapper.review_feedback = None
    sdk_wrapper.listeners.clear()
    yield
    await sdk_wrapper.cancel_task()


@pytest.mark.asyncio
async def test_hook_pauses_on_implementation_plan():
    """Verify that ArtifactApprovalHook blocks and resumes appropriately on implementation_plan.md."""
    hook = ArtifactApprovalHook(sdk_wrapper)

    # Mock tool call for creating implementation_plan.md
    tool_call = types.ToolCall(
        name="create_file",
        args={
            "path": "/workspace/implementation_plan.md",
            "contents": "# Proposed Changes\n- Add feature X"
        },
        id="step-1"
    )

    # Verify initial state is Idle
    assert sdk_wrapper.agent_state == "Idle"

    # Start the hook call in a background task since it will block
    hook_task = asyncio.create_task(hook.run(None, tool_call))

    # Wait briefly for wrapper to process and enter pause state
    await asyncio.sleep(0.05)

    # Assert state has transitioned to Awaiting Review
    assert sdk_wrapper.agent_state == "Awaiting Review"
    assert sdk_wrapper.current_artifact is not None
    assert sdk_wrapper.current_artifact["name"] == "implementation_plan.md"
    assert sdk_wrapper.current_artifact["content"] == "# Proposed Changes\n- Add feature X"

    # Approve the artifact
    sdk_wrapper.submit_review(decision="approved")

    # Await the hook task and verify it allowed the call
    res = await hook_task
    assert isinstance(res, types.HookResult)
    assert res.allow is True
    assert sdk_wrapper.agent_state == "Working"


@pytest.mark.asyncio
async def test_hook_pauses_and_rejects():
    """Verify that ArtifactApprovalHook blocks and denies with feedback on rejection."""
    hook = ArtifactApprovalHook(sdk_wrapper)

    tool_call = types.ToolCall(
        name="edit_file",
        args={
            "file_path": "/workspace/walkthrough.md",
            "diff_block": "- Old code\n+ New code"
        },
        id="step-2"
    )

    # Start the hook call in a background task
    hook_task = asyncio.create_task(hook.run(None, tool_call))
    await asyncio.sleep(0.05)

    assert sdk_wrapper.agent_state == "Awaiting Review"
    assert sdk_wrapper.current_artifact["name"] == "walkthrough.md"

    # Reject the artifact with feedback
    sdk_wrapper.submit_review(decision="rejected", feedback="Please refine changes")

    # Await the hook task and verify it blocked the call with feedback message
    res = await hook_task
    assert isinstance(res, types.HookResult)
    assert res.allow is False
    assert res.message == "Please refine changes"


@pytest.mark.asyncio
async def test_hook_bypasses_other_files():
    """Verify that other files are passed through without block or review."""
    hook = ArtifactApprovalHook(sdk_wrapper)

    tool_call = types.ToolCall(
        name="create_file",
        args={
            "path": "/workspace/other_file.py",
            "contents": "print('hello')"
        },
        id="step-3"
    )

    res = await hook.run(None, tool_call)
    assert res.allow is True
    assert sdk_wrapper.agent_state == "Idle"


@pytest.mark.asyncio
async def test_agent_endpoints():
    """Verify endpoint routing for spawning task, querying state, and submitting reviews."""
    # Mock wrapper spawn_task and submit_review to isolate API tests
    with patch.object(sdk_wrapper, "spawn_task") as mock_spawn, \
         patch.object(sdk_wrapper, "submit_review") as mock_submit:
        
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            # Test 1: Spawn task API
            res = await ac.post("/api/task/spawn", json={"prompt": "Do coding"})
            assert res.status_code == 200
            assert res.json() == {"status": "success", "message": "Task spawned successfully"}
            mock_spawn.assert_called_once_with("Do coding")

            # Test 2: State query API
            sdk_wrapper.agent_state = "Awaiting Review"
            sdk_wrapper.current_artifact = {"name": "test.md"}
            res = await ac.get("/api/agent/state")
            assert res.status_code == 200
            assert res.json()["state"] == "Awaiting Review"
            assert res.json()["artifact"] == {"name": "test.md"}

            # Test 3: Submit review API
            res = await ac.post("/api/agent/review", json={"decision": "approved", "feedback": "good"})
            assert res.status_code == 200
            assert res.json()["status"] == "success"
            mock_submit.assert_called_once_with("approved", "good")

            # Test 4: Cancel API
            with patch.object(sdk_wrapper, "cancel_task") as mock_cancel:
                res = await ac.post("/api/agent/cancel")
                assert res.status_code == 200
                assert res.json() == {"status": "success", "message": "Task cancelled successfully"}
                mock_cancel.assert_called_once()
