from typing import List, Optional
from fastapi import WebSocket
import logging
from src.sdk_wrapper import AntigravitySDKWrapper

logger = logging.getLogger("dependencies")

BRAIN_DIR = "/home/hoangt00/.gemini/antigravity-ide/brain"

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

# Global connection managers
terminal_manager = ConnectionManager()
state_manager_ws = ConnectionManager()
agent_manager = ConnectionManager()

# SDK wrapper instance
sdk_wrapper = AntigravitySDKWrapper()

# Background manager references (to be set in main.py lifespan)
pty_manager = None
file_watcher = None
brain_watcher = None
