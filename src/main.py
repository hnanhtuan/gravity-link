import os
import sys
import json
import asyncio
import logging
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()
import subprocess
from contextlib import asynccontextmanager

BRAIN_DIR = "/home/hoangt00/.gemini/antigravity-ide/brain"
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel

# Ensure the parent directory is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.pty_manager import PtyManager
from src.file_watcher import WorkspaceWatcher, BrainWatcher
from src.state_manager import get_state, get_pending_approval, set_approval_status, update_state, update_pending_approval
from src import state_manager
from src.sdk_wrapper import AntigravitySDKWrapper

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("main_server")

# Request Models
class WorkspaceSelectRequest(BaseModel):
    path: str

class ApprovalRequest(BaseModel):
    command: str
    reason: Optional[str] = None

class FileSaveRequest(BaseModel):
    path: str
    content: str

class ArtifactSaveRequest(BaseModel):
    content: str

class MessageSendRequest(BaseModel):
    content: str

class TaskSpawnRequest(BaseModel):
    prompt: str

class ReviewSubmitRequest(BaseModel):
    decision: str
    feedback: Optional[str] = None

# WebSocket Connection Manager
class ConnectionManager:
    """Manages active WebSocket connections for broadcasting and graceful cleanup."""
    
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        """Accepts a connection and registers it."""
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket connected. Total connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket) -> None:
        """Removes a connection from the registry."""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"WebSocket disconnected. Total connections: {len(self.active_connections)}")

    async def broadcast(self, message: str) -> None:
        """Broadcasts a string message to all registered connections, cleaning up stale ones."""
        if not self.active_connections:
            return
        
        stale_connections = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.warning(f"Failed to send message to connection: {e}")
                stale_connections.append(connection)
                
        for connection in stale_connections:
            self.disconnect(connection)


# Global instances to be initialized in lifespan
terminal_manager = ConnectionManager()
state_manager_ws = ConnectionManager()
agent_manager = ConnectionManager()

pty_manager: Optional[PtyManager] = None
file_watcher: Optional[WorkspaceWatcher] = None
brain_watcher: Optional[BrainWatcher] = None
sdk_wrapper = AntigravitySDKWrapper()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup logic
    global pty_manager, file_watcher, brain_watcher
    
    loop = asyncio.get_running_loop()
    logger.info("Initializing system components...")
    
    # 1. Initialize PTY Manager
    pty_manager = PtyManager()
    
    # Define broadcaster to stream raw shell output to terminal websocket clients
    async def terminal_broadcaster(data: str) -> None:
        await terminal_manager.broadcast(data)
        
    pty_manager.set_broadcaster(terminal_broadcaster)
    await pty_manager.start()
    
    # 2. Initialize File Watcher
    # Define broadcaster to stream changed file content to state websocket clients
    async def state_broadcaster(filename: str, data: Dict[str, Any]) -> None:
        payload = json.dumps({"file": filename, "data": data})
        await state_manager_ws.broadcast(payload)
        
    file_watcher = WorkspaceWatcher(loop=loop, broadcast_callback=state_broadcaster)
    await file_watcher.start()

    # 3. Register Listener for Agent broadcasts
    async def agent_broadcaster(message: str) -> None:
        await agent_manager.broadcast(message)

    sdk_wrapper.register_listener(agent_broadcaster)

    # 4. Initialize Brain Watcher to monitor conversation transcripts and artifacts
    async def brain_broadcaster(conv_id: str, event_type: str) -> None:
        payload = json.dumps({"file": event_type, "data": {"refresh": True, "conversation_id": conv_id}})
        await state_manager_ws.broadcast(payload)

    brain_watcher = BrainWatcher(loop=loop, brain_dir=BRAIN_DIR, broadcast_callback=brain_broadcaster)
    await brain_watcher.start()
    
    logger.info("System components initialized successfully. Ready for requests.")
    
    yield
    
    # Shutdown logic
    logger.info("Shutting down components...")
    sdk_wrapper.unregister_listener(agent_broadcaster)
    await sdk_wrapper.cancel_task()
    if file_watcher:
        await file_watcher.stop()
    if brain_watcher:
        await brain_watcher.stop()
    if pty_manager:
        await pty_manager.stop()
    logger.info("Shutdown completed.")


# Initialize FastAPI Application
app = FastAPI(
    title="Bridge Server",
    description="Middleware proxy for desktop terminal, filesystem sync, and HITL approvals",
    version="1.0.0",
    lifespan=lifespan
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# REST Endpoints
@app.get("/health")
async def health_check():
    """Returns server status and version for client discovery."""
    return {"status": "online", "version": "1.0.0"}

@app.get("/api/workspace")
async def api_get_workspace():
    """Returns the current active workspace path."""
    return {"active_workspace": state_manager.active_workspace_dir}

@app.get("/state")
async def api_get_state():
    """Returns the current state representation."""
    return await get_state()

@app.get("/approval/pending")
async def api_get_pending_approval():
    """Returns the current pending approvals status."""
    return await get_pending_approval()

@app.post("/approval/confirm")
async def api_post_approval_confirm():
    """Confirms pending approval by updating status to approved."""
    await set_approval_status("approved")
    payload = await get_pending_approval()
    await state_manager_ws.broadcast(json.dumps({"file": "pending_approval.json", "data": payload}))
    return {"status": "approved"}

@app.post("/approval/reject")
async def api_post_approval_reject():
    """Rejects pending approval by updating status to rejected."""
    await set_approval_status("rejected")
    payload = await get_pending_approval()
    await state_manager_ws.broadcast(json.dumps({"file": "pending_approval.json", "data": payload}))
    return {"status": "rejected"}

def add_recent_workspace(path: str) -> None:
    file_path = os.path.join(state_manager.DEFAULT_WORKSPACE_DIR, "recent_workspaces.json")
    workspaces = []
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                workspaces = json.load(f)
        except Exception:
            pass
            
    norm_path = os.path.abspath(path)
    if norm_path in workspaces:
        workspaces.remove(norm_path)
    workspaces.insert(0, norm_path)
    workspaces = workspaces[:10]
    
    try:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(workspaces, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save recent workspaces: {e}")

# Multi-Workspace REST APIs
@app.get("/api/workspaces/recent")
async def api_get_recent_workspaces():
    """Returns the list of recently selected workspaces."""
    file_path = os.path.join(state_manager.DEFAULT_WORKSPACE_DIR, "recent_workspaces.json")
    workspaces = []
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                workspaces = json.load(f)
        except Exception:
            pass
    if not workspaces:
        workspaces = [os.path.abspath(state_manager.active_workspace_dir)]
    return {"status": "success", "workspaces": workspaces}

@app.post("/workspace/select")
async def api_select_workspace(request: WorkspaceSelectRequest):
    """Dynamically changes the active workspace directory for terminals and observers."""
    path = os.path.abspath(request.path)
    if not os.path.exists(path):
        return {"status": "error", "message": f"Workspace directory '{path}' does not exist on disk."}
        
    logger.info(f"Switching active workspace to: {path}")
    
    # 1. Update State Manager paths
    state_manager.set_active_workspace(path)
    add_recent_workspace(path)
    
    # 2. Update File Watcher path
    if file_watcher:
        await file_watcher.update_workspace_dir(path)
        
    # 3. Restart PTY shell in the new workspace CWD
    if pty_manager:
        await pty_manager.start(cwd=path)
        
    # 4. Broadcast the workspace switch to any connected WebSockets
    current_state = await get_state()
    current_approval = await get_pending_approval()
    
    await state_manager_ws.broadcast(json.dumps({"file": "workspace_state.json", "data": current_state}))
    await state_manager_ws.broadcast(json.dumps({"file": "pending_approval.json", "data": current_approval}))
    return {
        "status": "success",
        "active_workspace": path,
        "state_file": state_manager.STATE_FILE,
        "approval_file": state_manager.APPROVAL_FILE
    }

@app.get("/api/workspace/git-status")
async def api_workspace_git_status():
    """Checks if there are uncommitted changes in the active workspace."""
    try:
        workspace_dir = state_manager.active_workspace_dir
        if not os.path.exists(workspace_dir):
            return {"status": "success", "is_dirty": False, "is_git": False}

        # Check if it is a git repository
        git_dir = os.path.join(workspace_dir, ".git")
        if not os.path.exists(git_dir):
            return {"status": "success", "is_dirty": False, "is_git": False}

        proc_status = await asyncio.create_subprocess_exec(
            "git", "status", "--porcelain",
            cwd=workspace_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout_status, _ = await proc_status.communicate()
        if proc_status.returncode != 0:
            return {"status": "success", "is_dirty": False, "is_git": True}

        changes = stdout_status.decode().strip()
        return {"status": "success", "is_dirty": bool(changes), "is_git": True}
    except Exception as e:
        logger.error(f"Error in api_workspace_git_status: {e}")
        return {"status": "error", "message": str(e)}

@app.post("/api/workspace/accept-changes")
async def api_workspace_accept_changes():
    """Runs git commands to accept (stage and commit) all changes in the active workspace."""
    try:
        workspace_dir = state_manager.active_workspace_dir
        if not os.path.exists(workspace_dir):
            return {"status": "error", "message": "Active workspace directory does not exist."}

        # 1. If there's a pending command approval in pending_approval.json, auto-confirm it
        current_approval = await get_pending_approval()
        if current_approval.get("status") == "pending":
            await set_approval_status("approved")
            payload = await get_pending_approval()
            await state_manager_ws.broadcast(json.dumps({"file": "pending_approval.json", "data": payload}))
            logger.info("Auto-approved pending command approval because changes were accepted.")

        # 2. If the agent is awaiting review, submit review as approved
        if sdk_wrapper.agent_state == "Awaiting Review":
            try:
                sdk_wrapper.submit_review("approved")
                logger.info("Auto-approved pending agent artifact review because changes were accepted.")
            except Exception as e:
                logger.error(f"Failed to auto-approve agent review: {e}")

        # Check if it is a git repository
        git_dir = os.path.join(workspace_dir, ".git")
        if not os.path.exists(git_dir):
            return {"status": "error", "message": "Active workspace is not a Git repository. Cannot accept changes."}

        # 3. Run git status --porcelain to see if there are any changes
        proc_status = await asyncio.create_subprocess_exec(
            "git", "status", "--porcelain",
            cwd=workspace_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout_status, stderr_status = await proc_status.communicate()
        if proc_status.returncode != 0:
            err_msg = stderr_status.decode().strip()
            return {"status": "error", "message": f"Git status failed: {err_msg}"}

        changes = stdout_status.decode().strip()
        if not changes:
            return {"status": "success", "message": "No changes to accept."}

        # 2. Stage all changes
        proc_add = await asyncio.create_subprocess_exec(
            "git", "add", "-A",
            cwd=workspace_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout_add, stderr_add = await proc_add.communicate()
        if proc_add.returncode != 0:
            err_msg = stderr_add.decode().strip()
            return {"status": "error", "message": f"Git add failed: {err_msg}"}

        # 3. Commit changes (overriding author info to ensure success)
        proc_commit = await asyncio.create_subprocess_exec(
            "git", "-c", "user.name=Gravity Link Agent", "-c", "user.email=agent@gravitylink.local",
            "commit", "-m", "Accept agent changes",
            cwd=workspace_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout_commit, stderr_commit = await proc_commit.communicate()
        if proc_commit.returncode != 0:
            err_msg = stderr_commit.decode().strip()
            return {"status": "error", "message": f"Git commit failed: {err_msg}"}

        return {"status": "success", "message": "Successfully accepted and committed all changes."}
    except Exception as e:
        logger.exception("Exception in api_workspace_accept_changes")
        return {"status": "error", "message": str(e)}

# Agent REST API Communication Channel

@app.post("/state")
async def api_post_state(state_data: Dict[str, Any]):
    """Enables agents running in external workspaces to update their state via REST API."""
    await update_state(state_data)
    await state_manager_ws.broadcast(json.dumps({"file": "workspace_state.json", "data": state_data}))
    return {"status": "success"}

@app.post("/approval/request")
async def api_post_approval_request(request: ApprovalRequest):
    """Enables agents running in external workspaces to request execution approval via REST API."""
    payload = {
        "status": "pending",
        "command": request.command,
        "reason": request.reason
    }
    await update_pending_approval(payload)
    await state_manager_ws.broadcast(json.dumps({"file": "pending_approval.json", "data": payload}))
    return {"status": "pending"}

@app.post("/approval/reset")
async def api_post_approval_reset():
    """Resets the pending approval status to idle."""
    payload = {"status": "idle"}
    await update_pending_approval(payload)
    await state_manager_ws.broadcast(json.dumps({"file": "pending_approval.json", "data": payload}))
    return {"status": "idle"}

@app.get("/approval/status")
async def api_get_approval_status():
    """Allows agents to query current approval status."""
    data = await get_pending_approval()
    return {"status": data.get("status", "idle"), "command": data.get("command", "")}


def safe_brain_join(conv_id: str) -> str:
    brain_dir = os.path.abspath(BRAIN_DIR)
    joined = os.path.abspath(os.path.join(brain_dir, conv_id))
    if os.path.commonpath([brain_dir, joined]) != brain_dir:
        raise ValueError("Access denied")
    return joined

def safe_artifact_path(conv_dir: str, name: str) -> str:
    conv_dir = os.path.abspath(conv_dir)
    artifact_path = os.path.abspath(os.path.join(conv_dir, name))
    if os.path.commonpath([conv_dir, artifact_path]) != conv_dir or not name.endswith(".md"):
        raise ValueError("Access denied")
    return artifact_path

# Conversation & Artifact APIs
@app.get("/api/conversations")
async def api_get_conversations():
    """Lists all conversations sorted by modification time."""
    try:
        brain_dir = os.path.abspath(BRAIN_DIR)
        if not os.path.exists(brain_dir):
            return {"status": "success", "conversations": []}
        
        conversations = []
        for entry in os.listdir(brain_dir):
            entry_path = os.path.join(brain_dir, entry)
            if not os.path.isdir(entry_path):
                continue
            transcript_path = os.path.join(entry_path, ".system_generated", "logs", "transcript.jsonl")
            if not os.path.exists(transcript_path):
                continue
            
            title = "Untitled Conversation"
            try:
                with open(transcript_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line_data = json.loads(line)
                        if line_data.get("type") == "USER_INPUT":
                            content = line_data.get("content", "")
                            clean_content = content.replace("<USER_REQUEST>", "").replace("</USER_REQUEST>", "").strip()
                            if "<ADDITIONAL_METADATA>" in clean_content:
                                clean_content = clean_content.split("<ADDITIONAL_METADATA>")[0].strip()
                            title = clean_content[:80] + "..." if len(clean_content) > 80 else clean_content
                            break
            except Exception:
                pass
            
            mtime = os.path.getmtime(transcript_path)
            conversations.append({
                "id": entry,
                "title": title,
                "mtime": mtime
            })
        
        conversations.sort(key=lambda x: x["mtime"], reverse=True)
        return {"status": "success", "conversations": conversations}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/conversation/current")
async def api_get_conversation_current():
    """Returns the current conversation ID (most recently active)."""
    try:
        res = await api_get_conversations()
        if res["status"] == "success" and res["conversations"]:
            return {"status": "success", "current_id": res["conversations"][0]["id"]}
        return {"status": "success", "current_id": None}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/conversation/new")
async def api_post_conversation_new():
    """Creates a new stateful conversation session by generating a new brain folder and transcript.jsonl."""
    try:
        import uuid
        new_id = str(uuid.uuid4())
        conv_dir = safe_brain_join(new_id)
        logs_dir = os.path.join(conv_dir, ".system_generated", "logs")
        os.makedirs(logs_dir, exist_ok=True)
        transcript_path = os.path.join(logs_dir, "transcript.jsonl")
        
        # Write an empty file to initialize the transcript
        with open(transcript_path, "w", encoding="utf-8") as f:
            f.write("")
            
        return {"status": "success", "conversation_id": new_id}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/conversation/{conv_id}/transcript")
async def api_get_conversation_transcript(conv_id: str):
    """Parses transcript.jsonl for a specific conversation."""
    try:
        conv_dir = safe_brain_join(conv_id)
        transcript_path = os.path.join(conv_dir, ".system_generated", "logs", "transcript.jsonl")
        if not os.path.exists(transcript_path):
            return {"status": "error", "message": "Transcript not found"}
        
        messages = []
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                line_data = json.loads(line)
                source = line_data.get("source")
                msg_type = line_data.get("type")
                content = line_data.get("content", "")
                
                if msg_type == "USER_INPUT" and source == "USER_EXPLICIT":
                    clean_content = content.replace("<USER_REQUEST>", "").replace("</USER_REQUEST>", "").strip()
                    if "<ADDITIONAL_METADATA>" in clean_content:
                        clean_content = clean_content.split("<ADDITIONAL_METADATA>")[0].strip()
                    messages.append({
                        "sender": "user",
                        "content": clean_content,
                        "timestamp": line_data.get("created_at")
                    })
                elif msg_type == "PLANNER_RESPONSE" and source == "MODEL":
                    messages.append({
                        "sender": "assistant",
                        "content": content,
                        "timestamp": line_data.get("created_at")
                    })
        return {"status": "success", "messages": messages}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/conversation/{conv_id}/artifacts")
async def api_get_conversation_artifacts(conv_id: str):
    """Lists all markdown artifacts in the conversation folder."""
    try:
        conv_dir = safe_brain_join(conv_id)
        if not os.path.exists(conv_dir):
            return {"status": "error", "message": "Conversation not found"}
        
        artifacts = []
        for root, dirs, files in os.walk(conv_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in sorted(files):
                if not name.endswith(".md"):
                    continue
                full_path = os.path.join(root, name)
                rel_path = os.path.relpath(full_path, conv_dir).replace(os.sep, "/")
                artifacts.append({
                    "name": rel_path,
                    "size": os.path.getsize(full_path),
                    "mtime": os.path.getmtime(full_path)
                })
        artifacts.sort(key=lambda item: item["name"])
        return {"status": "success", "artifacts": artifacts}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/conversation/{conv_id}/artifact/{name:path}")
async def api_get_conversation_artifact(conv_id: str, name: str):
    """Retrieves raw content of a conversation artifact."""
    try:
        conv_dir = safe_brain_join(conv_id)
        artifact_path = safe_artifact_path(conv_dir, name)
        
        if not os.path.exists(artifact_path):
            return {"status": "error", "message": "Artifact not found"}
        
        with open(artifact_path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"status": "success", "content": content}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/conversation/{conv_id}/artifact/{name:path}/save")
async def api_post_conversation_artifact_save(conv_id: str, name: str, request: ArtifactSaveRequest):
    """Saves updated content of a conversation artifact atomically."""
    try:
        conv_dir = safe_brain_join(conv_id)
        artifact_path = safe_artifact_path(conv_dir, name)
        
        temp_path = f"{artifact_path}.tmp"
        os.makedirs(os.path.dirname(artifact_path), exist_ok=True)
        with open(temp_path, "w", encoding="utf-8") as f:
            f.write(request.content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, artifact_path)
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

async def check_agentapi_has_trajectory(agentapi_path: str, conv_id: str) -> bool:
    """Checks with agentapi if the trajectory exists in the IDE's RPC backend."""
    try:
        proc = await asyncio.create_subprocess_exec(
            agentapi_path, "get-conversation-metadata", conv_id,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0:
            data = json.loads(stdout.decode())
            if "response" in data and "conversationMetadata" in data["response"]:
                return True
        return False
    except Exception as e:
        logger.error(f"Error checking agentapi trajectory for {conv_id}: {e}")
        return False


@app.post("/api/conversation/{conv_id}/message")
async def api_post_conversation_message(conv_id: str, request: MessageSendRequest):
    """Appends a new user message to the conversation's transcript.jsonl and triggers the agent task."""
    try:
        conv_dir = safe_brain_join(conv_id)
        transcript_path = os.path.join(conv_dir, ".system_generated", "logs", "transcript.jsonl")
        if not os.path.exists(transcript_path):
            return {"status": "error", "message": "Transcript file not found"}
            
        # Determine next step index by reading existing transcript
        next_step_index = 0
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        try:
                            line_data = json.loads(line)
                            step_idx = line_data.get("step_index", 0)
                            next_step_index = max(next_step_index, step_idx + 1)
                        except Exception:
                            pass
        except Exception:
            pass
            
        # Append user message to transcript immediately
        import datetime
        timestamp = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        content_str = f"<USER_REQUEST>\n{request.content}\n</USER_REQUEST>"
        
        log_entry = {
            "step_index": next_step_index,
            "source": "USER_EXPLICIT",
            "type": "USER_INPUT",
            "status": "DONE",
            "created_at": timestamp,
            "content": content_str
        }
        
        with open(transcript_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry) + "\n")
            
        # Broadcast refresh notification immediately so the user message updates instantly in the UI
        try:
            await state_manager_ws.broadcast(
                json.dumps({"file": "transcript.jsonl", "data": {"refresh": True, "conversation_id": conv_id}})
            )
        except Exception:
            pass
            
        # Check if the IDE's agentapi CLI tool is available on the workstation
        agentapi_path = "/home/hoangt00/.gemini/antigravity-ide/bin/agentapi"
        is_testing = "PYTEST_CURRENT_TEST" in os.environ
        
        has_agentapi = os.path.exists(agentapi_path) and not is_testing
        has_trajectory = False
        if has_agentapi:
            has_trajectory = await check_agentapi_has_trajectory(agentapi_path, conv_id)
            
        if has_agentapi and has_trajectory:
            # Route message through the IDE's agentapi tool using your Google AI Pro subscription
            cmd = [agentapi_path, "send-message", conv_id, request.content]
            
            async def run_agentapi_subprocess():
                try:
                    proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE
                    )
                    stdout, stderr = await proc.communicate()
                    logging.info(f"agentapi exited with code {proc.returncode}")
                    if stdout:
                        logging.info(f"agentapi stdout: {stdout.decode().strip()}")
                    if stderr:
                        logging.error(f"agentapi stderr: {stderr.decode().strip()}")
                except Exception as sub_err:
                    logging.error(f"Failed to run agentapi subprocess: {sub_err}")
                    
            asyncio.create_task(run_agentapi_subprocess())
            return {"status": "success"}
        elif os.environ.get("GEMINI_API_KEY"):
            # Active agent session mode: let the SDK handle message execution and appending
            if sdk_wrapper.agent_state != "Idle":
                return {"status": "error", "message": "Agent is currently busy"}
            sdk_wrapper.spawn_task(request.content, conversation_id=conv_id)
            return {"status": "success"}
        else:
            # Fallback offline mode (message is already appended to the transcript locally)
            return {"status": "success", "step_index": next_step_index}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/background-commands")
async def api_get_background_commands():
    """Retrieves active background commands under PTY and general user processes."""
    commands = []
    
    # 1. PTY terminal children
    if pty_manager and pty_manager.process and pty_manager.process.isalive():
        pty_pid = pty_manager.process.pid
        try:
            res = subprocess.run(
                ["ps", "--ppid", str(pty_pid), "-o", "pid,stat,command", "--no-headers"],
                capture_output=True,
                text=True
            )
            if res.returncode == 0:
                for line in res.stdout.strip().split("\n"):
                    parts = line.strip().split(None, 2)
                    if len(parts) >= 3:
                        commands.append({
                            "source": "PTY Terminal",
                            "pid": int(parts[0]),
                            "status": parts[1],
                            "command": parts[2]
                        })
        except Exception:
            pass
            
    # 2. General active workstation processes of user 'hoangt00'
    try:
        res = subprocess.run(
            ["ps", "-u", "hoangt00", "-o", "pid,stat,command", "--no-headers"],
            capture_output=True,
            text=True
        )
        if res.returncode == 0:
            interest_keywords = {"python", "uv", "pytest", "npm", "node", "git", "make", "docker"}
            for line in res.stdout.strip().split("\n"):
                parts = line.strip().split(None, 2)
                if len(parts) >= 3:
                    pid = int(parts[0])
                    stat = parts[1]
                    cmd = parts[2]
                    if pid == os.getpid() or "ps -u" in cmd or cmd in ("-bash", "bash", "sh", "/bin/bash"):
                        continue
                    if any(kw in cmd for kw in interest_keywords):
                        commands.append({
                            "source": "Workstation Process",
                            "pid": pid,
                            "status": stat,
                            "command": cmd
                        })
    except Exception as e:
        logger.error(f"Error querying workstation processes: {e}")
        
    return {"status": "success", "commands": commands}


# Workspace File Explorer APIs
@app.get("/api/files")
async def api_get_files(path: str = ""):
    """Lists files and directories in the active workspace.
    Path is relative to the active workspace.
    """
    try:
        # Prevent traversal
        workspace_abs = os.path.abspath(state_manager.active_workspace_dir)
        target_dir = os.path.abspath(os.path.join(workspace_abs, path.lstrip("/")))
        if not target_dir.startswith(workspace_abs):
            return {"status": "error", "message": "Access denied"}
        
        if not os.path.exists(target_dir):
            return {"status": "error", "message": "Directory does not exist"}
        
        if not os.path.isdir(target_dir):
            return {"status": "error", "message": "Not a directory"}
        
        items = []
        ignored_names = {".git", ".venv", "__pycache__", ".pytest_cache", ".gravity_link", ".DS_Store"}
        for name in sorted(os.listdir(target_dir)):
            if name in ignored_names:
                continue
            full_path = os.path.join(target_dir, name)
            rel_path = os.path.relpath(full_path, workspace_abs)
            is_dir = os.path.isdir(full_path)
            size = os.path.getsize(full_path) if not is_dir else 0
            items.append({
                "name": name,
                "path": rel_path,
                "is_dir": is_dir,
                "size": size
            })
        return {"status": "success", "files": items, "current_path": path}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/file/content")
async def api_get_file_content(path: str):
    """Retrieves the text content of a workspace file."""
    try:
        workspace_abs = os.path.abspath(state_manager.active_workspace_dir)
        target_file = os.path.abspath(os.path.join(workspace_abs, path.lstrip("/")))
        if not target_file.startswith(workspace_abs):
            return {"status": "error", "message": "Access denied"}
        
        if not os.path.exists(target_file):
            return {"status": "error", "message": "File does not exist"}
        
        if os.path.isdir(target_file):
            return {"status": "error", "message": "Path is a directory"}
        
        try:
            with open(target_file, "r", encoding="utf-8") as f:
                content = f.read()
            return {"status": "success", "content": content}
        except UnicodeDecodeError:
            return {"status": "error", "message": "Binary files are not supported"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/file/save")
async def api_post_file_save(request: FileSaveRequest):
    """Saves text content to a workspace file."""
    try:
        workspace_abs = os.path.abspath(state_manager.active_workspace_dir)
        target_file = os.path.abspath(os.path.join(workspace_abs, request.path.lstrip("/")))
        if not target_file.startswith(workspace_abs):
            return {"status": "error", "message": "Access denied"}
        
        temp_file = f"{target_file}.tmp"
        os.makedirs(os.path.dirname(target_file), exist_ok=True)
        with open(temp_file, "w", encoding="utf-8") as f:
            f.write(request.content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_file, target_file)
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# Antigravity SDK Routes
@app.post("/api/task/spawn")
async def api_spawn_task(request: TaskSpawnRequest):
    """Spawn a new Antigravity agent task session."""
    try:
        sdk_wrapper.spawn_task(request.prompt)
        return {"status": "success", "message": "Task spawned successfully"}
    except ValueError as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/agent/state")
async def api_get_agent_state():
    """Query the current state and active artifact being reviewed."""
    return {
        "status": "success",
        "state": sdk_wrapper.agent_state,
        "artifact": sdk_wrapper.current_artifact
    }

@app.post("/api/agent/review")
async def api_submit_review(request: ReviewSubmitRequest):
    """Approve or reject/give feedback for the pending artifact."""
    try:
        sdk_wrapper.submit_review(request.decision, request.feedback)
        await state_manager_ws.broadcast(
            json.dumps({"file": "agent_review.json", "data": {"decision": request.decision}})
        )
        return {"status": "success", "message": f"Review decision '{request.decision}' submitted"}
    except ValueError as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/agent/cancel")
async def api_cancel_task():
    """Cancel the current running task session."""
    await sdk_wrapper.cancel_task()
    return {"status": "success", "message": "Task cancelled successfully"}

@app.websocket("/ws/agent")
async def websocket_agent(websocket: WebSocket):
    """WebSocket endpoint for streaming agent events (thoughts, text, tool calls, and state)."""
    await agent_manager.connect(websocket)
    try:
        # Pushes current state information immediately upon connection
        await websocket.send_json({
            "type": "state_change",
            "state": sdk_wrapper.agent_state,
            "artifact": sdk_wrapper.current_artifact
        })
        while True:
            # Maintain connection, clients are consumers
            await websocket.receive_text()
    except WebSocketDisconnect:
        logger.info("Agent WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"Error in Agent WebSocket connection: {e}")
    finally:
        agent_manager.disconnect(websocket)


# Serve Static UI Frontend
@app.get("/", response_class=HTMLResponse)
async def read_index():
    static_file = os.path.join(os.path.dirname(__file__), "static", "index.html")
    if os.path.exists(static_file):
        return FileResponse(static_file)
    return HTMLResponse("<h1>Static files not found</h1>")

# Mount Static Files
static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")


# WebSocket Endpoints
@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    """WebSocket endpoint for bi-directional raw terminal streaming."""
    await terminal_manager.connect(websocket)
    try:
        while True:
            # Client sends keystrokes or terminal input
            data = await websocket.receive_text()
            if pty_manager:
                await pty_manager.write(data)
    except WebSocketDisconnect:
        logger.info("Terminal WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"Error in Terminal WebSocket: {e}")
    finally:
        terminal_manager.disconnect(websocket)

@app.websocket("/ws/state")
async def websocket_state(websocket: WebSocket):
    """WebSocket endpoint for workspace state and approvals streaming."""
    await state_manager_ws.connect(websocket)
    try:
        # Send current state & approvals immediately on connection
        current_state = await get_state()
        current_approval = await get_pending_approval()
        
        await websocket.send_json({"file": "workspace_state.json", "data": current_state})
        await websocket.send_json({"file": "pending_approval.json", "data": current_approval})
        
        while True:
            # Keep connection open; clients are consumers but might send occasional keepalives
            await websocket.receive_text()
    except WebSocketDisconnect:
        logger.info("State WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"Error in State WebSocket: {e}")
    finally:
        state_manager_ws.disconnect(websocket)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, log_level="info")
