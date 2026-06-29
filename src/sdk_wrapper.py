import os
import json
import asyncio
import logging
from typing import Dict, Any, Callable, Awaitable, Optional, Set

from google.antigravity import Agent, LocalAgentConfig, types
from google.antigravity.hooks import hooks

logger = logging.getLogger("sdk_wrapper")


class ArtifactApprovalHook(hooks.PreToolCallDecideHook):
    """Intercepts tool calls to create/edit files and blocks on critical artifacts.

    If the target file matches implementation_plan.md or walkthrough.md,
    the hook enters a review flow, pausing execution until the user submits a decision.
    """

    def __init__(self, wrapper: "AntigravitySDKWrapper"):
        self.wrapper = wrapper

    def __deepcopy__(self, memo):
        cls = self.__class__
        result = cls.__new__(cls)
        memo[id(self)] = result
        result.wrapper = self.wrapper  # Shallow copy the wrapper reference
        return result

    async def run(
        self, context: hooks.HookContext, data: types.ToolCall
    ) -> types.HookResult:
        logger.info(f"Intercepted tool call: {data.name} with args: {data.args}")

        # Check if the tool is create_file or edit_file
        if data.name in ("create_file", "edit_file"):
            # Target path could be in various keys depending on normalization or parameters
            target_path = (
                data.args.get("path")
                or data.args.get("file_path")
                or data.args.get("TargetFile")
                or data.args.get("AbsolutePath")
            )

            if target_path and isinstance(target_path, str):
                basename = os.path.basename(target_path)
                if basename in ("implementation_plan.md", "walkthrough.md"):
                    # Extract proposed content or diff
                    proposed_content = (
                        data.args.get("contents")
                        or data.args.get("content")
                        or data.args.get("diff_block")
                        or ""
                    )

                    # Hand off control to wrapper to trigger pause state
                    return await self.wrapper.handle_artifact(
                        basename, target_path, proposed_content
                    )

        # Allow all other tool calls to proceed
        return types.HookResult(allow=True)


class AntigravitySDKWrapper:
    """Singleton service to bridge Antigravity SDK operations with API controllers."""

    _instance = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self.agent_state: str = "Idle"  # Idle, Working, Awaiting Review
        self.active_task: Optional[asyncio.Task] = None
        self.current_artifact: Optional[Dict[str, Any]] = None
        self.review_event = asyncio.Event()
        self.review_decision: Optional[str] = None
        self.review_feedback: Optional[str] = None
        self.agent: Optional[Agent] = None
        self.listeners: Set[Callable[[str], Awaitable[None]]] = set()
        self._initialized = True

    def register_listener(self, callback: Callable[[str], Awaitable[None]]) -> None:
        """Register a callback for real-time agent output streaming."""
        self.listeners.add(callback)
        logger.info(f"Registered listener. Total: {len(self.listeners)}")

    def unregister_listener(self, callback: Callable[[str], Awaitable[None]]) -> None:
        """Unregister a callback when a client disconnects."""
        self.listeners.discard(callback)
        logger.info(f"Unregistered listener. Total: {len(self.listeners)}")

    async def broadcast_event(self, event_data: Dict[str, Any]) -> None:
        """Broadcast an event payload to all registered listeners."""
        if not self.listeners:
            return
        payload = json.dumps(event_data)
        await asyncio.gather(
            *(cb(payload) for cb in self.listeners),
            return_exceptions=True
        )

    def spawn_task(self, prompt: str, conversation_id: Optional[str] = None) -> None:
        """Initialize a new agent session/task with a user prompt."""
        if self.agent_state != "Idle":
            raise ValueError(f"Cannot spawn task: Agent is currently busy (state: {self.agent_state})")

        self.agent_state = "Working"
        self.current_artifact = None
        self.review_decision = None
        self.review_feedback = None
        self.review_event = asyncio.Event()

        # Execute the agent loop in a separate asyncio Task
        self.active_task = asyncio.create_task(self._run_agent_loop(prompt, conversation_id))
        logger.info(f"Spawned background task for agent execution (conv: {conversation_id}).")

    async def _run_agent_loop(self, prompt: str, conversation_id: Optional[str] = None) -> None:
        """Asynchronous execution loop for the Antigravity Agent."""
        try:
            api_key = os.environ.get("GEMINI_API_KEY")
            from src.dependencies import BRAIN_DIR
            app_data_dir = os.path.dirname(os.path.abspath(BRAIN_DIR))
            config = LocalAgentConfig(
                api_key=api_key,
                hooks=[ArtifactApprovalHook(self)],
                app_data_dir=app_data_dir,
                save_dir=BRAIN_DIR,
                conversation_id=conversation_id
            )

            await self.broadcast_event({"type": "state_change", "state": self.agent_state})

            async with Agent(config) as agent:
                self.agent = agent
                response = await agent.chat(prompt)

                # Stream response chunks dynamically to WebSocket clients
                async for chunk in response.chunks:
                    payload = None
                    if isinstance(chunk, types.Text):
                        payload = {"type": "text", "content": chunk.text}
                    elif isinstance(chunk, types.Thought):
                        payload = {"type": "thought", "content": chunk.text}
                    elif isinstance(chunk, types.ToolCall):
                        payload = {
                            "type": "tool_call",
                            "name": chunk.name,
                            "args": chunk.args,
                            "id": chunk.id
                        }
                    elif isinstance(chunk, types.ToolResult):
                        payload = {
                            "type": "tool_result",
                            "name": chunk.name,
                            "id": chunk.id,
                            "result": str(chunk.result) if chunk.result is not None else None,
                            "error": str(chunk.error) if chunk.error is not None else None
                        }

                    if payload:
                        await self.broadcast_event(payload)
                        # Trigger a transcript update on the state WebSocket
                        try:
                            from src.dependencies import state_manager_ws
                            await state_manager_ws.broadcast(
                                json.dumps({"file": "transcript.jsonl", "data": {"refresh": True}})
                            )
                        except Exception as ws_err:
                            logger.debug(f"Failed to broadcast transcript refresh: {ws_err}")

                final_text = await response.text()
                logger.info(f"Agent turn completed. Final output: {final_text}")
                await self.broadcast_event({"type": "finished", "content": final_text})
                # Final broadcast for finishing
                try:
                    from src.dependencies import state_manager_ws
                    await state_manager_ws.broadcast(
                        json.dumps({"file": "transcript.jsonl", "data": {"refresh": True}})
                    )
                except Exception:
                    pass

        except asyncio.CancelledError:
            logger.info("Agent run task cancelled.")
            await self.broadcast_event({"type": "cancelled"})
        except Exception as e:
            logger.exception("Exception in agent execution loop")
            await self.broadcast_event({"type": "error", "message": str(e)})
        finally:
            self.agent_state = "Idle"
            self.agent = None
            self.active_task = None
            await self.broadcast_event({"type": "state_change", "state": self.agent_state})

    async def handle_artifact(self, name: str, path: str, content: str) -> types.HookResult:
        """Pauses the execution loop, stores artifact state, and broadcasts Awaiting Review."""
        self.agent_state = "Awaiting Review"
        self.current_artifact = {
            "name": name,
            "path": path,
            "content": content
        }
        self.review_event = asyncio.Event()

        # Send state transition and review request to client
        await self.broadcast_event({
            "type": "state_change",
            "state": self.agent_state,
            "artifact": self.current_artifact
        })
        await self.broadcast_event({
            "type": "awaiting_review",
            "artifact": self.current_artifact
        })

        logger.info(f"Agent execution paused for artifact review: {name} ({path})")

        # Block until review submission sets the event
        await self.review_event.wait()

        decision = self.review_decision
        feedback = self.review_feedback

        # Reset states
        self.current_artifact = None
        self.review_decision = None
        self.review_feedback = None
        self.review_event.clear()

        self.agent_state = "Working"
        await self.broadcast_event({"type": "state_change", "state": self.agent_state})

        if decision == "approved":
            logger.info(f"Artifact {name} approved. Resuming execution.")
            return types.HookResult(allow=True)
        else:
            logger.info(f"Artifact {name} rejected with feedback: {feedback}. Resuming execution.")
            return types.HookResult(allow=False, message=feedback or "Rejected by user")

    def submit_review(self, decision: str, feedback: Optional[str] = None) -> None:
        """Route user actions (Approve, Reject, or text feedback) back into the SDK wrapper."""
        if self.agent_state != "Awaiting Review":
            raise ValueError(f"Cannot submit review: Agent is in state '{self.agent_state}'")
        if decision not in ("approved", "rejected"):
            raise ValueError("Decision must be either 'approved' or 'rejected'")

        self.review_decision = decision
        self.review_feedback = feedback
        self.review_event.set()
        logger.info(f"Submitted review decision: '{decision}' with feedback: '{feedback}'")

    async def cancel_task(self) -> None:
        """Cancel the currently running task if active."""
        if self.active_task and not self.active_task.done():
            logger.info("Requesting cancellation of active agent task.")
            self.active_task.cancel()
            try:
                await self.active_task
            except asyncio.CancelledError:
                pass
