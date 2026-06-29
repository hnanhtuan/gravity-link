import json
import logging
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel
from src import dependencies

logger = logging.getLogger("router_agent")
router = APIRouter()

# Request Models
class TaskSpawnRequest(BaseModel):
    prompt: str

class ReviewSubmitRequest(BaseModel):
    decision: str
    feedback: Optional[str] = None

@router.post("/api/task/spawn")
async def api_spawn_task(request: TaskSpawnRequest):
    """Spawn a new Antigravity agent task session."""
    try:
        dependencies.sdk_wrapper.spawn_task(request.prompt)
        return {"status": "success", "message": "Task spawned successfully"}
    except ValueError as e:
        return {"status": "error", "message": str(e)}

@router.get("/api/agent/state")
async def api_get_agent_state():
    """Query the current state and active artifact being reviewed."""
    return {
        "status": "success",
        "state": dependencies.sdk_wrapper.agent_state,
        "artifact": dependencies.sdk_wrapper.current_artifact
    }

@router.post("/api/agent/review")
async def api_submit_review(request: ReviewSubmitRequest):
    """Approve or reject/give feedback for the pending artifact."""
    try:
        dependencies.sdk_wrapper.submit_review(request.decision, request.feedback)
        await dependencies.state_manager_ws.broadcast(
            json.dumps({"file": "agent_review.json", "data": {"decision": request.decision}})
        )
        return {"status": "success", "message": f"Review decision '{request.decision}' submitted"}
    except ValueError as e:
        return {"status": "error", "message": str(e)}

@router.post("/api/agent/cancel")
async def api_cancel_task():
    """Cancel the current running task session."""
    await dependencies.sdk_wrapper.cancel_task()
    return {"status": "success", "message": "Task cancelled successfully"}
