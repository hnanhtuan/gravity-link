import json
import os
import asyncio
from typing import Dict, Any

DEFAULT_WORKSPACE_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "workspace")
)

active_workspace_dir = DEFAULT_WORKSPACE_DIR
STATE_FILE = os.path.join(active_workspace_dir, "workspace_state.json")
APPROVAL_FILE = os.path.join(active_workspace_dir, "pending_approval.json")

# Async locks to serialize writes to state and approval files
_state_lock = asyncio.Lock()
_approval_lock = asyncio.Lock()

def set_active_workspace(path: str) -> None:
    """Sets the active workspace path and updates file references dynamically.
    
    If the path points to the default workspace, we read/write directly in workspace/.
    Otherwise, we store state files in project_root/.gravity_link/ to avoid polluting the workspace root.
    """
    global active_workspace_dir, STATE_FILE, APPROVAL_FILE
    
    if path == DEFAULT_WORKSPACE_DIR:
        active_workspace_dir = path
        STATE_FILE = os.path.join(active_workspace_dir, "workspace_state.json")
        APPROVAL_FILE = os.path.join(active_workspace_dir, "pending_approval.json")
    else:
        active_workspace_dir = os.path.abspath(path)
        target_dir = os.path.join(active_workspace_dir, ".gravity_link")
        
        # Ensure target folder exists
        os.makedirs(target_dir, exist_ok=True)
        
        STATE_FILE = os.path.join(target_dir, "workspace_state.json")
        APPROVAL_FILE = os.path.join(target_dir, "pending_approval.json")
        
        # Populate initial files if they do not exist
        if not os.path.exists(STATE_FILE):
            with open(STATE_FILE, "w", encoding="utf-8") as f:
                f.write("{}")
        if not os.path.exists(APPROVAL_FILE):
            with open(APPROVAL_FILE, "w", encoding="utf-8") as f:
                f.write('{"status": "idle"}')

async def read_json_file(file_path: str, max_retries: int = 5, retry_delay: float = 0.1) -> Dict[str, Any]:
    """Reads a JSON file with retries to handle concurrency/locking issues.
    
    Args:
        file_path: Path to the JSON file to read.
        max_retries: Maximum number of retries upon read permission or decoding failure.
        retry_delay: Delay in seconds between retries.
        
    Returns:
        The decoded JSON dictionary.
    """
    for attempt in range(max_retries):
        try:
            if not os.path.exists(file_path):
                return {}
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if not content:
                    return {}
                return json.loads(content)
        except (PermissionError, json.JSONDecodeError) as e:
            if attempt == max_retries - 1:
                raise e
            await asyncio.sleep(retry_delay)
    return {}

async def write_json_file(file_path: str, data: Dict[str, Any], lock: asyncio.Lock) -> None:
    """Writes a JSON file atomically using a lock and a temporary file.
    
    Args:
        file_path: Path to the JSON file to write.
        data: The dictionary data to write.
        lock: The asyncio.Lock to acquire.
    """
    async with lock:
        temp_file = f"{file_path}.tmp"
        try:
            # Ensure the directory exists
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_file, file_path)
        except Exception as e:
            if os.path.exists(temp_file):
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
            raise e

async def get_state() -> Dict[str, Any]:
    """Retrieves the current workspace state.
    
    Returns:
        Workspace state dictionary.
    """
    return await read_json_file(STATE_FILE)

async def update_state(data: Dict[str, Any]) -> None:
    """Updates the workspace state.
    
    Args:
        data: The workspace state data dictionary.
    """
    await write_json_file(STATE_FILE, data, _state_lock)

async def get_pending_approval() -> Dict[str, Any]:
    """Retrieves the pending approval state.
    
    Returns:
        Pending approval state dictionary.
    """
    return await read_json_file(APPROVAL_FILE)

async def update_pending_approval(data: Dict[str, Any]) -> None:
    """Updates the pending approval state.
    
    Args:
        data: The pending approval data dictionary.
    """
    await write_json_file(APPROVAL_FILE, data, _approval_lock)

async def set_approval_status(status: str) -> None:
    """Sets the approval status in pending_approval.json.
    
    Args:
        status: The new status string (e.g. "approved", "pending", "idle").
    """
    data = await get_pending_approval()
    data["status"] = status
    await update_pending_approval(data)
