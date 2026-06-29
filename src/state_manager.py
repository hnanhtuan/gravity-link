import json
import os
import asyncio
from typing import Dict, Any

DEFAULT_WORKSPACE_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "workspace")
)

class WorkspaceConfig:
    """Manages active workspace directory and paths for state/approval files dynamically."""
    
    def __init__(self):
        self._active_workspace_dir = DEFAULT_WORKSPACE_DIR

    @property
    def active_workspace_dir(self) -> str:
        return self._active_workspace_dir

    @property
    def state_file(self) -> str:
        if self._active_workspace_dir == DEFAULT_WORKSPACE_DIR:
            return os.path.join(self._active_workspace_dir, "workspace_state.json")
        return os.path.join(self._active_workspace_dir, ".gravity_link", "workspace_state.json")

    @property
    def approval_file(self) -> str:
        if self._active_workspace_dir == DEFAULT_WORKSPACE_DIR:
            return os.path.join(self._active_workspace_dir, "pending_approval.json")
        return os.path.join(self._active_workspace_dir, ".gravity_link", "pending_approval.json")

    def set_active_workspace(self, path: str) -> None:
        if path == DEFAULT_WORKSPACE_DIR:
            self._active_workspace_dir = path
        else:
            self._active_workspace_dir = os.path.abspath(path)
            # Ensure target folder exists
            target_dir = os.path.join(self._active_workspace_dir, ".gravity_link")
            os.makedirs(target_dir, exist_ok=True)
            
            # Populate initial files if they do not exist
            state_f = self.state_file
            appr_f = self.approval_file
            if not os.path.exists(state_f):
                with open(state_f, "w", encoding="utf-8") as f:
                    f.write("{}")
            if not os.path.exists(appr_f):
                with open(appr_f, "w", encoding="utf-8") as f:
                    f.write('{"status": "idle"}')

_config = WorkspaceConfig()

# Async locks to serialize writes to state and approval files
_state_lock = asyncio.Lock()
_approval_lock = asyncio.Lock()

def set_active_workspace(path: str) -> None:
    """Sets the active workspace path and updates file references dynamically."""
    _config.set_active_workspace(path)

def __getattr__(name: str) -> Any:
    """Dynamically resolve deprecated/legacy global variables for backwards compatibility."""
    if name == "active_workspace_dir":
        return _config.active_workspace_dir
    if name == "STATE_FILE":
        return _config.state_file
    if name == "APPROVAL_FILE":
        return _config.approval_file
    raise AttributeError(f"module {__name__} has no attribute {name}")

async def read_json_file(file_path: str, max_retries: int = 5, retry_delay: float = 0.1) -> Dict[str, Any]:
    """Reads a JSON file with retries to handle concurrency/locking issues."""
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
    """Writes a JSON file atomically using a lock and a temporary file."""
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
    """Retrieves the current workspace state."""
    return await read_json_file(_config.state_file)

async def update_state(data: Dict[str, Any]) -> None:
    """Updates the workspace state."""
    await write_json_file(_config.state_file, data, _state_lock)

async def get_pending_approval() -> Dict[str, Any]:
    """Retrieves the pending approval state."""
    return await read_json_file(_config.approval_file)

async def update_pending_approval(data: Dict[str, Any]) -> None:
    """Updates the pending approval state."""
    await write_json_file(_config.approval_file, data, _approval_lock)

async def set_approval_status(status: str) -> None:
    """Sets the approval status in pending_approval.json."""
    data = await get_pending_approval()
    data["status"] = status
    await update_pending_approval(data)

