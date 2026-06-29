import json
import logging
from typing import Dict, Any, Optional
from fastapi import APIRouter
from pydantic import BaseModel
from src import state_manager
from src import dependencies

logger = logging.getLogger("router_approval")
router = APIRouter()

class ApprovalRequest(BaseModel):
    command: str
    reason: Optional[str] = None

@router.get("/state")
async def api_get_state():
    """Returns the current state representation."""
    return await state_manager.get_state()

@router.post("/state")
async def api_post_state(state_data: Dict[str, Any]):
    """Enables agents running in external workspaces to update their state via REST API."""
    await state_manager.update_state(state_data)
    await dependencies.state_manager_ws.broadcast(
        json.dumps({"file": "workspace_state.json", "data": state_data})
    )
    return {"status": "success"}

@router.get("/approval/pending")
async def api_get_pending_approval():
    """Returns the current pending approvals status."""
    return await state_manager.get_pending_approval()

@router.post("/approval/confirm")
async def api_post_approval_confirm():
    """Confirms pending approval by updating status to approved."""
    await state_manager.set_approval_status("approved")
    payload = await state_manager.get_pending_approval()
    await dependencies.state_manager_ws.broadcast(
        json.dumps({"file": "pending_approval.json", "data": payload})
    )
    return {"status": "approved"}

@router.post("/approval/reject")
async def api_post_approval_reject():
    """Rejects pending approval by updating status to rejected."""
    await state_manager.set_approval_status("rejected")
    payload = await state_manager.get_pending_approval()
    await dependencies.state_manager_ws.broadcast(
        json.dumps({"file": "pending_approval.json", "data": payload})
    )
    return {"status": "rejected"}

@router.post("/approval/request")
async def api_post_approval_request(request: ApprovalRequest):
    """Enables agents running in external workspaces to request execution approval via REST API."""
    payload = {
        "status": "pending",
        "command": request.command,
        "reason": request.reason
    }
    await state_manager.update_pending_approval(payload)
    await dependencies.state_manager_ws.broadcast(
        json.dumps({"file": "pending_approval.json", "data": payload})
    )
    return {"status": "pending"}

@router.post("/approval/reset")
async def api_post_approval_reset():
    """Resets the pending approval status to idle."""
    payload = {"status": "idle"}
    await state_manager.update_pending_approval(payload)
    await dependencies.state_manager_ws.broadcast(
        json.dumps({"file": "pending_approval.json", "data": payload})
    )
    return {"status": "idle"}

@router.get("/approval/status")
async def api_get_approval_status():
    """Allows agents to query current approval status."""
    data = await state_manager.get_pending_approval()
    return {"status": data.get("status", "idle"), "command": data.get("command", "")}
