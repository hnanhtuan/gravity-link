import os
import json
import datetime
import logging
import asyncio
import subprocess
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from src import state_manager
from src import dependencies

logger = logging.getLogger("router_conversation")
router = APIRouter()

# Request Models
class ArtifactSaveRequest(BaseModel):
    content: str

class MessageSendRequest(BaseModel):
    content: str

# Helpers
def safe_brain_join(conv_id: str) -> str:
    brain_dir = os.path.abspath(dependencies.BRAIN_DIR)
    joined = os.path.abspath(os.path.join(brain_dir, conv_id))
    if os.path.commonpath([brain_dir, joined]) != brain_dir:
        raise ValueError("Access denied")
    return joined

def create_empty_conversation_db(conv_id: str):
    """Creates a pre-initialized SQLite database file for the conversation to satisfy the local agent backend check."""
    db_path = os.path.join(dependencies.BRAIN_DIR, f"{conv_id}.db")
    if os.path.exists(db_path):
        return
    import sqlite3
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("CREATE TABLE IF NOT EXISTS `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))")
        cur.execute("INSERT OR IGNORE INTO trajectory_meta VALUES (?, ?, 4, 1)", (conv_id, conv_id))
        cur.execute("CREATE TABLE IF NOT EXISTS `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))")
        cur.execute("CREATE TABLE IF NOT EXISTS `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))")
        cur.execute("CREATE TABLE IF NOT EXISTS `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))")
        cur.execute("CREATE TABLE IF NOT EXISTS `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))")
        cur.execute("CREATE TABLE IF NOT EXISTS `trajectory_metadata_blob` (`id` text DEFAULT 'main',`data` blob,PRIMARY KEY (`id`))")
        cur.execute("CREATE TABLE IF NOT EXISTS `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))")
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Error pre-creating conversation DB for {conv_id}: {e}")

def safe_artifact_path(conv_dir: str, name: str) -> str:
    conv_dir = os.path.abspath(conv_dir)
    artifact_path = os.path.abspath(os.path.join(conv_dir, name))
    if os.path.commonpath([conv_dir, artifact_path]) != conv_dir or not name.endswith(".md"):
        raise ValueError("Access denied")
    return artifact_path

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

# Routes
@router.get("/api/conversations")
async def api_get_conversations():
    """Lists all conversations sorted by modification time."""
    try:
        brain_dir = os.path.abspath(dependencies.BRAIN_DIR)
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

@router.get("/api/conversation/current")
async def api_get_conversation_current():
    """Returns the current conversation ID (most recently active)."""
    try:
        res = await api_get_conversations()
        if res["status"] == "success" and res["conversations"]:
            return {"status": "success", "current_id": res["conversations"][0]["id"]}
        return {"status": "success", "current_id": None}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@router.post("/api/conversation/new")
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
            
        create_empty_conversation_db(new_id)
            
        return {"status": "success", "conversation_id": new_id}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@router.get("/api/conversation/{conv_id}/transcript")
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

@router.get("/api/conversation/{conv_id}/artifacts")
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

@router.get("/api/conversation/{conv_id}/artifact/{name:path}")
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

@router.post("/api/conversation/{conv_id}/artifact/{name:path}/save")
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

@router.post("/api/conversation/{conv_id}/message")
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
            await dependencies.state_manager_ws.broadcast(
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
            if dependencies.sdk_wrapper.agent_state != "Idle":
                return {"status": "error", "message": "Agent is currently busy"}
            create_empty_conversation_db(conv_id)
            dependencies.sdk_wrapper.spawn_task(request.content, conversation_id=conv_id)
            return {"status": "success"}
        else:
            # Fallback offline mode
            return {"status": "success", "step_index": next_step_index}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@router.get("/api/background-commands")
async def api_get_background_commands():
    """Retrieves active background commands under PTY and general user processes."""
    commands = []
    
    # 1. PTY terminal children
    if dependencies.pty_manager and dependencies.pty_manager.process and dependencies.pty_manager.process.isalive():
        pty_pid = dependencies.pty_manager.process.pid
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
