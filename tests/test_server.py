import os
import json
import asyncio
import pytest
from httpx import AsyncClient, ASGITransport

from src.main import app
from src.state_manager import STATE_FILE, APPROVAL_FILE, get_state, update_state, get_pending_approval, set_active_workspace, DEFAULT_WORKSPACE_DIR

@pytest.fixture(autouse=True)
def setup_test_files():
    """Fixture to backup current state files and reset them for clean test runs."""
    # Temporarily remove GEMINI_API_KEY so tests run in offline fallback mode
    old_api_key = os.environ.pop("GEMINI_API_KEY", None)

    # Ensure active workspace is default before test
    set_active_workspace(DEFAULT_WORKSPACE_DIR)
    
    # Backup
    state_backup = None
    approval_backup = None
    
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            state_backup = f.read()
            
    if os.path.exists(APPROVAL_FILE):
        with open(APPROVAL_FILE, "r") as f:
            approval_backup = f.read()
            
    # Reset to default state
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump({"test": "initial"}, f)
    with open(APPROVAL_FILE, "w") as f:
        json.dump({"status": "idle"}, f)
        
    yield
    
    # Reset active workspace to default after test
    set_active_workspace(DEFAULT_WORKSPACE_DIR)
    
    # Restore backups
    if state_backup is not None:
        with open(STATE_FILE, "w") as f:
            f.write(state_backup)
    else:
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
            
    if approval_backup is not None:
        with open(APPROVAL_FILE, "w") as f:
            f.write(approval_backup)
    else:
        if os.path.exists(APPROVAL_FILE):
            os.remove(APPROVAL_FILE)

    # Restore API Key
    if old_api_key is not None:
        os.environ["GEMINI_API_KEY"] = old_api_key


@pytest.mark.asyncio
async def test_health_endpoint():
    """Verify that the health check endpoint returns 200 and correct JSON payload."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "online", "version": "1.0.0"}


@pytest.mark.asyncio
async def test_state_endpoints():
    """Verify that the state endpoints load files correctly."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/state")
    assert response.status_code == 200
    assert response.json() == {"test": "initial"}


@pytest.mark.asyncio
async def test_approval_flow():
    """Verify pending approval fetch and confirmation workflow."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # Check initial pending approval
        response = await ac.get("/approval/pending")
        assert response.status_code == 200
        assert response.json() == {"status": "idle"}
        
        # Confirm approval
        response = await ac.post("/approval/confirm")
        assert response.status_code == 200
        assert response.json() == {"status": "approved"}
        
        # Verify approval updated on disk
        response = await ac.get("/approval/pending")
        assert response.json() == {"status": "approved"}


@pytest.mark.asyncio
async def test_state_manager_concurrency():
    """Verify state manager reads and writes safely with locks."""
    # Write new state
    await update_state({"counter": 42})
    state = await get_state()
    assert state == {"counter": 42}
    
    # Test reading concurrent triggers
    tasks = [get_state() for _ in range(10)]
    results = await asyncio.gather(*tasks)
    for res in results:
        assert res == {"counter": 42}


@pytest.mark.asyncio
async def test_pty_manager_lifecycle():
    """Verify that PtyManager spawns, can write, and stops properly."""
    from src.pty_manager import PtyManager
    
    # We will spawn a simple command like echo hello
    pty = PtyManager(command=["/bin/echo", "hello-world-test"])
    
    outputs = []
    async def mock_broadcaster(data: str):
        outputs.append(data)
        
    pty.set_broadcaster(mock_broadcaster)
    await pty.start()
    
    # Wait for process to exit and read loop to complete
    await asyncio.sleep(0.5)
    await pty.stop()
    
    # Verify we got output
    full_output = "".join(outputs)
    assert "hello-world-test" in full_output


@pytest.mark.asyncio
async def test_file_watcher_debounce():
    """Verify that WorkspaceWatcher debounces rapid file modifications."""
    from src.file_watcher import WorkspaceWatcher
    from src.state_manager import update_state
    
    loop = asyncio.get_running_loop()
    broadcasts = []
    
    async def mock_broadcast(filename: str, data: dict):
        broadcasts.append((filename, data))
        
    watcher = WorkspaceWatcher(loop=loop, broadcast_callback=mock_broadcast, debounce_delay=0.2)
    await watcher.start()
    
    try:
        # Trigger modifications in quick succession
        await update_state({"update": 1})
        await asyncio.sleep(0.05)
        await update_state({"update": 2})
        await asyncio.sleep(0.05)
        await update_state({"update": 3})
        
        # Wait longer than debounce delay (0.2s)
        await asyncio.sleep(0.4)
        
        # We should only have 1 broadcast event containing update: 3
        assert len(broadcasts) == 1
        filename, data = broadcasts[0]
        assert filename == "workspace_state.json"
        assert data == {"update": 3}
        
    finally:
        await watcher.stop()


@pytest.mark.asyncio
async def test_workspace_select_and_agent_apis(tmp_path):
    """Verify selecting a new workspace dynamically, and posting state & approvals via REST."""
    workspace_path = str(tmp_path)
    
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # 1. Switch to the new workspace directory
        response = await ac.post("/workspace/select", json={"path": workspace_path})
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"
        assert data["active_workspace"] == workspace_path
        
        # Verify the workspace status query endpoint
        response = await ac.get("/api/workspace")
        assert response.status_code == 200
        assert response.json() == {"active_workspace": workspace_path}
        
        # Verify the state files are initialized in the target folder
        expected_state_file = os.path.join(workspace_path, ".gravity_link", "workspace_state.json")
        expected_approval_file = os.path.join(workspace_path, ".gravity_link", "pending_approval.json")
        assert os.path.exists(expected_state_file)
        assert os.path.exists(expected_approval_file)
        
        # 2. Update agent state via POST /state
        state_payload = {"agent_status": "working", "task": "testing-select"}
        response = await ac.post("/state", json=state_payload)
        assert response.status_code == 200
        assert response.json() == {"status": "success"}
        
        # Verify state is updated on GET /state
        response = await ac.get("/state")
        assert response.json() == state_payload
        
        # 3. Submit approval request via POST /approval/request
        approval_payload = {"command": "echo test-cmd", "reason": "pytest run"}
        response = await ac.post("/approval/request", json=approval_payload)
        assert response.status_code == 200
        assert response.json() == {"status": "pending"}
        
        # Verify status is pending
        response = await ac.get("/approval/status")
        assert response.json() == {"status": "pending", "command": "echo test-cmd"}
        
        # 4. Confirm approval via POST /approval/confirm
        response = await ac.post("/approval/confirm")
        assert response.status_code == 200
        assert response.json() == {"status": "approved"}
        
        # Verify updated status
        response = await ac.get("/approval/status")
        assert response.json() == {"status": "approved", "command": "echo test-cmd"}


@pytest.mark.asyncio
async def test_approval_reject():
    """Verify that POST /approval/reject works correctly."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/approval/reject")
        assert response.status_code == 200
        assert response.json() == {"status": "rejected"}
        
        response = await ac.get("/approval/pending")
        assert response.json()["status"] == "rejected"


@pytest.mark.asyncio
async def test_workspace_file_apis(tmp_path):
    """Verify listing, reading, and writing files in the workspace, with traversal checks."""
    workspace_path = str(tmp_path)
    
    # Switch to the tmp workspace
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/workspace/select", json={"path": workspace_path})
        assert response.status_code == 200
        
        # 1. Create files/dirs on disk
        sub_dir = os.path.join(workspace_path, "src")
        os.makedirs(sub_dir, exist_ok=True)
        file1_path = os.path.join(workspace_path, "file1.txt")
        file2_path = os.path.join(sub_dir, "file2.py")
        
        with open(file1_path, "w") as f:
            f.write("hello from file1")
        with open(file2_path, "w") as f:
            f.write("print('hello')")
            
        # 2. List files in root
        response = await ac.get("/api/files")
        assert response.status_code == 200
        files_data = response.json()
        assert files_data["status"] == "success"
        filenames = [f["name"] for f in files_data["files"]]
        assert "file1.txt" in filenames
        assert "src" in filenames
        
        # 3. List files in sub_dir
        response = await ac.get("/api/files?path=src")
        assert response.status_code == 200
        sub_files_data = response.json()
        assert sub_files_data["status"] == "success"
        sub_filenames = [f["name"] for f in sub_files_data["files"]]
        assert "file2.py" in sub_filenames
        
        # 4. Get file content
        response = await ac.get("/api/file/content?path=file1.txt")
        assert response.status_code == 200
        assert response.json() == {"status": "success", "content": "hello from file1"}
        
        # 5. Save file content
        response = await ac.post("/api/file/save", json={"path": "src/file2.py", "content": "print('hello updated')"})
        assert response.status_code == 200
        assert response.json() == {"status": "success"}
        
        # Verify content updated on disk
        with open(file2_path, "r") as f:
            assert f.read() == "print('hello updated')"
            
        # 6. Safety check - directory traversal denial
        response = await ac.get("/api/files?path=../")
        assert response.json()["status"] == "error"
        assert "Access denied" in response.json()["message"]
        
        response = await ac.get("/api/file/content?path=../../etc/passwd")
        assert response.json()["status"] == "error"
        assert "Access denied" in response.json()["message"]
        
        response = await ac.post("/api/file/save", json={"path": "../outside.txt", "content": "unauthorized"})
        assert response.json()["status"] == "error"
        assert "Access denied" in response.json()["message"]


@pytest.mark.asyncio
async def test_conversation_and_artifact_apis():
    """Verify conversations, transcript parsing, artifact listing, viewing, and saving."""
    from src import main
    import tempfile
    
    # We will override BRAIN_DIR to a temporary directory for clean testing
    with tempfile.TemporaryDirectory() as temp_brain:
        main.BRAIN_DIR = temp_brain
        
        # 1. Create a mock conversation directory
        conv_id = "test-conv-1234"
        conv_dir = os.path.join(temp_brain, conv_id)
        os.makedirs(conv_dir, exist_ok=True)
        
        # Create transcript file
        logs_dir = os.path.join(conv_dir, ".system_generated", "logs")
        os.makedirs(logs_dir, exist_ok=True)
        transcript_path = os.path.join(logs_dir, "transcript.jsonl")
        
        with open(transcript_path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "created_at": "2026-06-28T12:00:00Z", "content": "<USER_REQUEST>Test Prompt Question</USER_REQUEST>"}) + "\n")
            f.write(json.dumps({"step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "created_at": "2026-06-28T12:01:00Z", "content": "Assistant Response Text"}) + "\n")
            
        # Create a mock artifact file
        artifact_path = os.path.join(conv_dir, "task.md")
        with open(artifact_path, "w", encoding="utf-8") as f:
            f.write("- [ ] Task 1\n- [x] Task 2\n")
            
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            # 2. Get conversations
            response = await ac.get("/api/conversations")
            assert response.status_code == 200
            data = response.json()
            assert data["status"] == "success"
            assert len(data["conversations"]) == 1
            assert data["conversations"][0]["id"] == conv_id
            assert "Test Prompt Question" in data["conversations"][0]["title"]
            
            # 3. Get current conversation
            response = await ac.get("/api/conversation/current")
            assert response.json()["current_id"] == conv_id
            
            # 4. Get transcript
            response = await ac.get(f"/api/conversation/{conv_id}/transcript")
            assert response.status_code == 200
            transcript_data = response.json()
            assert transcript_data["status"] == "success"
            assert len(transcript_data["messages"]) == 2
            assert transcript_data["messages"][0]["sender"] == "user"
            assert transcript_data["messages"][0]["content"] == "Test Prompt Question"
            assert transcript_data["messages"][1]["sender"] == "assistant"
            assert transcript_data["messages"][1]["content"] == "Assistant Response Text"
            
            # 5. Get artifacts
            response = await ac.get(f"/api/conversation/{conv_id}/artifacts")
            assert response.status_code == 200
            artifacts_data = response.json()
            assert len(artifacts_data["artifacts"]) == 1
            assert artifacts_data["artifacts"][0]["name"] == "task.md"
            
            # 6. Get artifact content
            response = await ac.get(f"/api/conversation/{conv_id}/artifact/task.md")
            assert response.status_code == 200
            assert response.json()["content"] == "- [ ] Task 1\n- [x] Task 2\n"
            
            # 7. Save artifact content
            response = await ac.post(f"/api/conversation/{conv_id}/artifact/task.md/save", json={"content": "- [x] Task 1\n- [x] Task 2\n"})
            assert response.status_code == 200
            assert response.json()["status"] == "success"
            
            # Verify saved content on disk
            with open(artifact_path, "r", encoding="utf-8") as f:
                assert f.read() == "- [x] Task 1\n- [x] Task 2\n"

            # 7.5 Send user message
            response = await ac.post(f"/api/conversation/{conv_id}/message", json={"content": "New User Question"})
            assert response.status_code == 200
            assert response.json()["status"] == "success"
            
            # Verify message gets successfully loaded in transcript
            response = await ac.get(f"/api/conversation/{conv_id}/transcript")
            messages = response.json()["messages"]
            assert len(messages) == 3
            assert messages[2]["sender"] == "user"
            assert messages[2]["content"] == "New User Question"

            # 8. Path traversal check on artifacts (fails to route, returns 404)
            response = await ac.get(f"/api/conversation/{conv_id}/artifact/../../etc/passwd")
            assert response.status_code == 404


@pytest.mark.asyncio
async def test_background_commands_endpoint():
    """Verify that the background commands endpoint runs without error."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/background-commands")
        assert response.status_code == 200
        assert response.json()["status"] == "success"
        assert isinstance(response.json()["commands"], list)


@pytest.mark.asyncio
async def test_recent_workspaces_flow():
    """Verify that workspaces are tracked as recently selected and returned by the API."""
    import tempfile
    from src import main, state_manager
    
    orig_default = state_manager.DEFAULT_WORKSPACE_DIR
    with tempfile.TemporaryDirectory() as temp_dir:
        state_manager.DEFAULT_WORKSPACE_DIR = temp_dir
        
        # Create a mock directory to select
        new_ws = os.path.join(temp_dir, "my_new_workspace")
        os.makedirs(new_ws, exist_ok=True)
        
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            # 1. Initially lists default active workspace
            response = await ac.get("/api/workspaces/recent")
            assert response.status_code == 200
            assert response.json()["status"] == "success"
            assert isinstance(response.json()["workspaces"], list)
            
            # 2. Select a new workspace path
            response = await ac.post("/workspace/select", json={"path": new_ws})
            assert response.status_code == 200
            assert response.json()["status"] == "success"
            
            # 3. Retrieve recent list again (should contain the new workspace path at the front)
            response = await ac.get("/api/workspaces/recent")
            recent_paths = response.json()["workspaces"]
            assert new_ws in recent_paths
            assert recent_paths[0] == new_ws
            
    state_manager.DEFAULT_WORKSPACE_DIR = orig_default


@pytest.mark.asyncio
async def test_approval_reset_api():
    """Verify that the approval reset endpoint sets status to idle."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # Request approval
        await ac.post("/approval/request", json={"command": "ls", "reason": "test"})
        
        # Verify it is pending
        res = await ac.get("/approval/pending")
        assert res.json()["status"] == "pending"
        
        # Reset approval
        res = await ac.post("/approval/reset")
        assert res.status_code == 200
        assert res.json()["status"] == "idle"
        
        # Verify it is idle
        res = await ac.get("/approval/pending")
        assert res.json()["status"] == "idle"
