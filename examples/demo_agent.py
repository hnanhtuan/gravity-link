import os
import json
import time
import urllib.request
from urllib.error import URLError
from typing import Dict, Any

# Resolve file paths relative to this script for fallback local mode
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WORKSPACE_DIR = os.path.join(BASE_DIR, "workspace")
STATE_FILE = os.path.join(WORKSPACE_DIR, "workspace_state.json")
APPROVAL_FILE = os.path.join(WORKSPACE_DIR, "pending_approval.json")

SERVER_URL = "http://localhost:8000"

def update_state_api(state_data: Dict[str, Any]) -> bool:
    """Try to send state update via server REST API. Returns True if successful."""
    try:
        req = urllib.request.Request(
            f"{SERVER_URL}/state",
            data=json.dumps(state_data).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=1.0) as response:
            return json.loads(response.read().decode("utf-8")).get("status") == "success"
    except Exception:
        return False

def request_approval_api(command: str, reason: str) -> bool:
    """Try to request approval via server REST API. Returns True if successful."""
    try:
        payload = {"command": command, "reason": reason}
        req = urllib.request.Request(
            f"{SERVER_URL}/approval/request",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=1.0) as response:
            return True
    except Exception:
        return False

def check_approval_status_api() -> str:
    """Check approval status via server REST API. Returns status string or None."""
    try:
        with urllib.request.urlopen(f"{SERVER_URL}/approval/status", timeout=1.0) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data.get("status")
    except Exception:
        return None

def reset_approval_api() -> bool:
    """Reset approval status via server REST API. Returns True if successful."""
    try:
        req = urllib.request.Request(
            f"{SERVER_URL}/approval/reset",
            data=b"{}",
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=1.0) as response:
            return True
    except Exception:
        return False

# Fallback functions for direct local file writes if server is offline
def update_file(file_path: str, data: Dict[str, Any]) -> None:
    temp_file = f"{file_path}.tmp"
    try:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_file, file_path)
    except Exception as e:
        if os.path.exists(temp_file):
            os.remove(temp_file)
        raise e

def read_file(file_path: str) -> Dict[str, Any]:
    if not os.path.exists(file_path):
        return {}
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            return json.loads(content) if content else {}
    except (json.JSONDecodeError, PermissionError):
        time.sleep(0.1)
        return read_file(file_path)

def main():
    print("🤖 Agent Starting up...")
    
    state_payload = {
        "agent_status": "running",
        "current_task": "Demonstrating HITL Approval Loop",
        "timestamp": time.time()
    }
    
    # Try updating via REST API first
    use_api = update_state_api(state_payload)
    if use_api:
        print("📝 Sent state update via Server REST API.")
    else:
        print("📝 Server offline. Writing state locally to workspace_state.json...")
        update_file(STATE_FILE, state_payload)
        
    proposed_command = "uv add numpy"
    reason = "Agent requires numpy for mathematical operations"
    print(f"⚠️ Agent wants to run critical command: '{proposed_command}'")
    
    if use_api:
        print("✍️ Sent approval request via Server REST API...")
        request_approval_api(proposed_command, reason)
    else:
        approval_request = {
            "status": "pending",
            "command": proposed_command,
            "reason": reason
        }
        print("✍️ Server offline. Writing request locally to pending_approval.json...")
        update_file(APPROVAL_FILE, approval_request)
        
    print("⏳ Entering blocking loop, waiting for user approval...")
    
    approved = False
    while not approved:
        time.sleep(2)
        if use_api:
            current_status = check_approval_status_api()
        else:
            approval_data = read_file(APPROVAL_FILE)
            current_status = approval_data.get("status")
            
        print(f"   [Checking...] Status: '{current_status}'")
        
        if current_status == "approved":
            approved = True
            print("✅ Consent granted! User approved the command.")
        elif current_status == "rejected":
            print("❌ Consent denied! User rejected the command.")
            break
            
    if approved:
        print(f"🚀 Running: {proposed_command}...")
        time.sleep(1)
        print("🎉 Command executed successfully!")
        
        if use_api:
            state_payload["agent_status"] = "idle"
            state_payload["current_task"] = "Task completed"
            update_state_api(state_payload)
            reset_approval_api()
        else:
            state_payload["agent_status"] = "idle"
            state_payload["current_task"] = "Task completed"
            update_file(STATE_FILE, state_payload)
            update_file(APPROVAL_FILE, {"status": "idle"})
            
        print("🧼 Demo finished.")

if __name__ == "__main__":
    main()
