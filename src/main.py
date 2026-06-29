import os
import sys
import json
import asyncio
import logging
from dotenv import load_dotenv

# Load environment variables from .env explicitly
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(project_root, ".env"))

from contextlib import asynccontextmanager
from typing import Dict, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse

# Ensure the parent directory is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.pty_manager import PtyManager
from src.file_watcher import WorkspaceWatcher, BrainWatcher
from src.state_manager import get_state, get_pending_approval
from src import dependencies
from src.dependencies import sdk_wrapper, BRAIN_DIR  # exposed for tests/internal files

# Import routers
from src.routers import workspace, approval, conversation, agent

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("main_server")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup logic
    import src.dependencies as deps
    
    loop = asyncio.get_running_loop()
    logger.info("Initializing system components...")
    
    # 1. Initialize PTY Manager
    deps.pty_manager = PtyManager()
    
    # Define broadcaster to stream raw shell output to terminal websocket clients
    async def terminal_broadcaster(data: str) -> None:
        await deps.terminal_manager.broadcast(data)
        
    deps.pty_manager.set_broadcaster(terminal_broadcaster)
    await deps.pty_manager.start()
    
    # 2. Initialize File Watcher
    # Define broadcaster to stream changed file content to state websocket clients
    async def state_broadcaster(filename: str, data: Dict[str, Any]) -> None:
        payload = json.dumps({"file": filename, "data": data})
        await deps.state_manager_ws.broadcast(payload)
        
    deps.file_watcher = WorkspaceWatcher(loop=loop, broadcast_callback=state_broadcaster)
    await deps.file_watcher.start()

    # 3. Register Listener for Agent broadcasts
    async def agent_broadcaster(message: str) -> None:
        await deps.agent_manager.broadcast(message)

    deps.sdk_wrapper.register_listener(agent_broadcaster)

    # 4. Initialize Brain Watcher to monitor conversation transcripts and artifacts
    async def brain_broadcaster(conv_id: str, event_type: str) -> None:
        payload = json.dumps({"file": event_type, "data": {"refresh": True, "conversation_id": conv_id}})
        await deps.state_manager_ws.broadcast(payload)

    deps.brain_watcher = BrainWatcher(loop=loop, brain_dir=deps.BRAIN_DIR, broadcast_callback=brain_broadcaster)
    await deps.brain_watcher.start()
    
    logger.info("System components initialized successfully. Ready for requests.")
    
    yield
    
    # Shutdown logic
    logger.info("Shutting down components...")
    deps.sdk_wrapper.unregister_listener(agent_broadcaster)
    await deps.sdk_wrapper.cancel_task()
    if deps.file_watcher:
        await deps.file_watcher.stop()
    if deps.brain_watcher:
        await deps.brain_watcher.stop()
    if deps.pty_manager:
        await deps.pty_manager.stop()
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

# Mount APIRouters
app.include_router(workspace.router)
app.include_router(approval.router)
app.include_router(conversation.router)
app.include_router(agent.router)

# REST Endpoints in Main (for health and debugging)
@app.get("/health")
async def health_check():
    """Returns server status and version for client discovery."""
    return {"status": "online", "version": "1.0.0"}

@app.get("/api/debug/apikey")
async def api_debug_apikey():
    return {
        "key_exists": "GEMINI_API_KEY" in os.environ,
        "key_length": len(os.environ.get("GEMINI_API_KEY", "")),
        "key_preview": os.environ.get("GEMINI_API_KEY", "")[:8]
    }

# WebSockets
@app.websocket("/ws/agent")
async def websocket_agent(websocket: WebSocket):
    """WebSocket endpoint for streaming agent events (thoughts, text, tool calls, and state)."""
    await dependencies.agent_manager.connect(websocket)
    try:
        # Pushes current state information immediately upon connection
        await websocket.send_json({
            "type": "state_change",
            "state": dependencies.sdk_wrapper.agent_state,
            "artifact": dependencies.sdk_wrapper.current_artifact
        })
        while True:
            # Maintain connection, clients are consumers
            await websocket.receive_text()
    except WebSocketDisconnect:
        logger.info("Agent WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"Error in Agent WebSocket connection: {e}")
    finally:
        dependencies.agent_manager.disconnect(websocket)

@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    """WebSocket endpoint for bi-directional raw terminal streaming."""
    await dependencies.terminal_manager.connect(websocket)
    try:
        while True:
            # Client sends keystrokes or terminal input
            data = await websocket.receive_text()
            if dependencies.pty_manager:
                await dependencies.pty_manager.write(data)
    except WebSocketDisconnect:
        logger.info("Terminal WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"Error in Terminal WebSocket: {e}")
    finally:
        dependencies.terminal_manager.disconnect(websocket)

@app.websocket("/ws/state")
async def websocket_state(websocket: WebSocket):
    """WebSocket endpoint for workspace state and approvals streaming."""
    await dependencies.state_manager_ws.connect(websocket)
    try:
        # Send current state & approvals immediately on connection
        current_state = await get_state()
        current_approval = await get_pending_approval()
        
        await websocket.send_json({"file": "workspace_state.json", "data": current_state})
        await websocket.send_json({"file": "pending_approval.json", "data": current_approval})
        
        while True:
            # Keep connection open
            await websocket.receive_text()
    except WebSocketDisconnect:
        logger.info("State WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"Error in State WebSocket: {e}")
    finally:
        dependencies.state_manager_ws.disconnect(websocket)

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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, log_level="info")

from types import ModuleType
class CustomModule(ModuleType):
    def __setattr__(self, name: str, value: Any) -> None:
        if name == "BRAIN_DIR":
            dependencies.BRAIN_DIR = value
        super().__setattr__(name, value)

import sys
sys.modules[__name__].__class__ = CustomModule

