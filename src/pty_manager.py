import os
import asyncio
import logging
from typing import Callable, Optional, List
import ptyprocess

from src import state_manager

logger = logging.getLogger("pty_manager")

class PtyManager:
    """Manages the lifecycle, input, and output of a background PTY process."""
    
    def __init__(self, command: Optional[List[str]] = None):
        if command is None:
            # Prefer bash in interactive mode, fall back to sh
            if os.path.exists("/bin/bash"):
                self.command = ["/bin/bash", "-i"]
            else:
                self.command = ["/bin/sh"]
        else:
            self.command = command
            
        self.process: Optional[ptyprocess.PtyProcessUnicode] = None
        self.read_task: Optional[asyncio.Task] = None
        self.broadcaster: Optional[Callable[[str], asyncio.Future]] = None
        self._running = False
        self._log_lock = asyncio.Lock()

    def set_broadcaster(self, broadcaster: Callable[[str], asyncio.Future]) -> None:
        """Sets the callback to broadcast PTY output to connected clients.
        
        The callback must be an async function accepting a string.
        """
        self.broadcaster = broadcaster

    async def start(self, cwd: Optional[str] = None) -> None:
        """Spawns the PTY process in the specified working directory and starts the read loop."""
        if self._running:
            # If already running, stop the current one first to re-initialize
            await self.stop()
        
        # Default CWD to the current active workspace directory
        target_cwd = cwd or state_manager.active_workspace_dir
        logger.info(f"Spawning PTY process with command: {self.command} in directory: {target_cwd}")
        
        # Spawn PTY process
        self.process = ptyprocess.PtyProcessUnicode.spawn(self.command, cwd=target_cwd)
        self._running = True
        
        # Start reading PTY stdout in background
        self.read_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        """Background loop reading from PTY and broadcasting/logging output."""
        buffer_size = 1024
        
        while self._running and self.process and self.process.isalive():
            try:
                # Read from PTY using asyncio.to_thread to prevent blocking the event loop
                data = await asyncio.to_thread(self.process.read, buffer_size)
                if not data:
                    # EOF or empty read
                    await asyncio.sleep(0.02)
                    continue
                
                # Write to local terminal stream log
                await self._write_to_log(data)
                
                # Broadcast raw ANSI sequences to WebSockets
                if self.broadcaster:
                    try:
                        await self.broadcaster(data)
                    except Exception as e:
                        logger.error(f"Error calling broadcaster: {e}")
                        
            except EOFError:
                logger.info("PTY process reached EOF.")
                break
            except Exception as e:
                logger.error(f"Error in PTY read loop: {e}")
                break
        
        logger.info("PTY read loop exited.")
        self._running = False

    async def _write_to_log(self, data: str) -> None:
        """Appends output to the dynamic log file in an async-safe manner."""
        async with self._log_lock:
            try:
                # Resolve the log file path dynamically based on active workspace
                if state_manager.active_workspace_dir == state_manager.DEFAULT_WORKSPACE_DIR:
                    log_file = os.path.join(state_manager.active_workspace_dir, "terminal_stream.log")
                else:
                    log_file = os.path.join(state_manager.active_workspace_dir, ".gravity_link", "terminal_stream.log")
                
                os.makedirs(os.path.dirname(log_file), exist_ok=True)
                with open(log_file, "a", encoding="utf-8") as f:
                    f.write(data)
                    f.flush()
            except Exception as e:
                logger.error(f"Failed to write PTY output to log: {e}")

    async def write(self, data: str) -> None:
        """Writes input data to PTY's stdin.
        
        Args:
            data: Raw string input from client.
        """
        if not self.process or not self.process.isalive():
            logger.warning("Attempted to write to inactive PTY process.")
            return
        
        try:
            # Write asynchronously to avoid blocking the loop
            await asyncio.to_thread(self.process.write, data)
            # Flush PTY output buffer
            await asyncio.to_thread(self.process.flush)
        except Exception as e:
            logger.error(f"Error writing to PTY process: {e}")

    async def stop(self) -> None:
        """Stops the read loop and terminates the PTY process."""
        self._running = False
        
        if self.read_task:
            self.read_task.cancel()
            try:
                await self.read_task
            except asyncio.CancelledError:
                pass
            self.read_task = None
            
        if self.process:
            logger.info("Terminating PTY process...")
            try:
                if self.process.isalive():
                    self.process.terminate(force=True)
            except Exception as e:
                logger.error(f"Error terminating PTY process: {e}")
            finally:
                self.process.close()
                self.process = None
                
        logger.info("PTY process stopped.")
