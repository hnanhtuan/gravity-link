import os
import json
import asyncio
import logging
import subprocess
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from src import state_manager
from src import dependencies

logger = logging.getLogger("router_workspace")
router = APIRouter()

# Request Models
class WorkspaceSelectRequest(BaseModel):
    path: str

class FileSaveRequest(BaseModel):
    path: str
    content: str

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

@router.get("/api/workspace")
async def api_get_workspace():
    """Returns the current active workspace path."""
    return {"active_workspace": state_manager.active_workspace_dir}

@router.get("/api/workspaces/recent")
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

@router.post("/workspace/select")
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
    if dependencies.file_watcher:
        await dependencies.file_watcher.update_workspace_dir(path)
        
    # 3. Restart PTY shell in the new workspace CWD
    if dependencies.pty_manager:
        await dependencies.pty_manager.start(cwd=path)
        
    # 4. Broadcast the workspace switch to any connected WebSockets
    current_state = await state_manager.get_state()
    current_approval = await state_manager.get_pending_approval()
    
    await dependencies.state_manager_ws.broadcast(
        json.dumps({"file": "workspace_state.json", "data": current_state})
    )
    await dependencies.state_manager_ws.broadcast(
        json.dumps({"file": "pending_approval.json", "data": current_approval})
    )
    return {
        "status": "success",
        "active_workspace": path,
        "state_file": state_manager.STATE_FILE,
        "approval_file": state_manager.APPROVAL_FILE
    }

@router.get("/api/workspace/git-status")
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

@router.post("/api/workspace/accept-changes")
async def api_workspace_accept_changes():
    """Runs git commands to accept (stage and commit) all changes in the active workspace."""
    try:
        workspace_dir = state_manager.active_workspace_dir
        if not os.path.exists(workspace_dir):
            return {"status": "error", "message": "Active workspace directory does not exist."}

        # 1. If there's a pending command approval in pending_approval.json, auto-confirm it
        current_approval = await state_manager.get_pending_approval()
        if current_approval.get("status") == "pending":
            await state_manager.set_approval_status("approved")
            payload = await state_manager.get_pending_approval()
            await dependencies.state_manager_ws.broadcast(
                json.dumps({"file": "pending_approval.json", "data": payload})
            )
            logger.info("Auto-approved pending command approval because changes were accepted.")

        # 2. If the agent is awaiting review, submit review as approved
        if dependencies.sdk_wrapper.agent_state == "Awaiting Review":
            try:
                dependencies.sdk_wrapper.submit_review("approved")
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

@router.get("/api/files")
async def api_get_files(path: str = ""):
    """Lists files and directories in the active workspace.
    Path is relative to the active workspace.
    """
    try:
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

@router.get("/api/file/content")
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

@router.post("/api/file/save")
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
