import os
import asyncio
import logging
from typing import Dict, Callable, Any, Coroutine, Optional
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from src.state_manager import STATE_FILE, APPROVAL_FILE, read_json_file

logger = logging.getLogger("file_watcher")

class WorkspaceEventHandler(FileSystemEventHandler):
    """Watchdog event handler that forwards modified events to an async callback on the main loop."""
    
    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        state_file: str,
        approval_file: str,
        on_modified_callback: Callable[[str], Coroutine[Any, Any, None]]
    ):
        self.loop = loop
        self.state_file = os.path.abspath(state_file)
        self.approval_file = os.path.abspath(approval_file)
        self.on_modified_callback = on_modified_callback

    def on_modified(self, event):
        self._handle_event(event)

    def on_created(self, event):
        self._handle_event(event)

    def on_moved(self, event):
        self._handle_event(event)

    def _handle_event(self, event):
        if event.is_directory:
            return
        file_path = os.path.abspath(getattr(event, "dest_path", event.src_path))
        if file_path in (self.state_file, self.approval_file):
            asyncio.run_coroutine_threadsafe(
                self.on_modified_callback(file_path),
                self.loop
            )

class WorkspaceWatcher:
    """Monitors the active workspace directory and debounces file changes before broadcasting."""
    
    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        broadcast_callback: Callable[[str, Dict[str, Any]], Coroutine[Any, Any, None]],
        debounce_delay: float = 0.5
    ):
        self.loop = loop
        self.broadcast_callback = broadcast_callback
        self.debounce_delay = debounce_delay
        
        self.workspace_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "workspace")
        )
        self.state_file = STATE_FILE
        self.approval_file = APPROVAL_FILE
        
        self.observer: Optional[Observer] = None
        self.debounce_tasks: Dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()  # Lock to serialize debounce task manipulations

    async def start(self) -> None:
        """Starts the watchdog observer on the active workspace folder."""
        logger.info(f"Starting workspace observer on {self.workspace_dir}")
        
        # Ensure watched directory exists
        os.makedirs(self.workspace_dir, exist_ok=True)
        
        event_handler = WorkspaceEventHandler(
            loop=self.loop,
            state_file=self.state_file,
            approval_file=self.approval_file,
            on_modified_callback=self._handle_file_modified
        )
        
        self.observer = Observer()
        self.observer.schedule(event_handler, self.workspace_dir, recursive=False)
        # Running watchdog observer in its own background thread
        self.observer.start()

    async def update_workspace_dir(self, new_path: str) -> None:
        """Dynamically re-targets the watcher to point to a new project workspace."""
        logger.info(f"Re-targeting watcher workspace to: {new_path}")
        await self.stop()
        
        from src import state_manager
        
        target_root = os.path.abspath(new_path)
        if target_root == state_manager.DEFAULT_WORKSPACE_DIR:
            self.workspace_dir = target_root
            self.state_file = state_manager.STATE_FILE
            self.approval_file = state_manager.APPROVAL_FILE
        else:
            # Target the hidden .gravity_link directory under the new root
            self.workspace_dir = os.path.join(target_root, ".gravity_link")
            self.state_file = os.path.join(self.workspace_dir, "workspace_state.json")
            self.approval_file = os.path.join(self.workspace_dir, "pending_approval.json")
            
        await self.start()

    async def _handle_file_modified(self, file_path: str) -> None:
        """Schedules a debounced task to read and broadcast the changed file."""
        async with self._lock:
            # If a debounce task is already running/scheduled for this file, cancel it
            if file_path in self.debounce_tasks:
                self.debounce_tasks[file_path].cancel()
                
            # Create a new debounced task
            task = asyncio.create_task(self._execute_debounced(file_path))
            self.debounce_tasks[file_path] = task

    async def _execute_debounced(self, file_path: str) -> None:
        """Waits for the debounce delay, reads the file contents, and broadcasts."""
        try:
            await asyncio.sleep(self.debounce_delay)
            
            basename = os.path.basename(file_path)
            logger.info(f"Debounce complete for {basename}. Reading file contents.")
            
            # Read file safely using state_manager read_json_file which implements retries
            try:
                data = await read_json_file(file_path)
            except Exception as e:
                logger.error(f"Failed to read file {basename} after retries: {e}")
                return
            
            # Trigger the broadcast callback
            await self.broadcast_callback(basename, data)
            
        except asyncio.CancelledError:
            # Debounce cancelled due to a newer file update
            pass
        except Exception as e:
            logger.error(f"Unexpected error in debounce execution for {file_path}: {e}")
        finally:
            # Safely remove task from tracker
            async with self._lock:
                if self.debounce_tasks.get(file_path) == asyncio.current_task():
                    self.debounce_tasks.pop(file_path, None)

    async def stop(self) -> None:
        """Stops the watchdog observer and cancels pending debounce tasks."""
        if self.observer:
            logger.info("Stopping workspace observer...")
            self.observer.stop()
            # Wait for observer thread to finish
            await asyncio.to_thread(self.observer.join)
            self.observer = None
            
        # Cancel all pending debounce tasks
        async with self._lock:
            for task in self.debounce_tasks.values():
                task.cancel()
            self.debounce_tasks.clear()
            
        logger.info("Workspace observer stopped.")
