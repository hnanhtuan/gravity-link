// Gravity Link Mobile Application JavaScript

// State variables
let term;
let fitAddon;
let termWs;
let stateWs;
let activeWorkspacePath = '';
let currentFileExplorerPath = '';
let ctrlActive = false;
let openFilePath = '';

// Conversation & Artifacts state
let activeConversationId = '';
let currentArtifactName = '';
let currentArtifactLines = [];
let commandsPollingInterval = null;

// DOM Elements
const wsStatusDot = document.getElementById('ws-status-dot');
const wsStatusText = document.getElementById('ws-status-text');
const workspacePathInput = document.getElementById('workspace-path-input');
const workspaceSelectBtn = document.getElementById('workspace-select-btn');
const workspaceRecentSelect = document.getElementById('workspace-recent-select');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabViews = document.querySelectorAll('.tab-view');
const approvalBadge = document.getElementById('approval-badge');
const pendingApprovalContainer = document.getElementById('pending-approval-container');
const stateJsonDisplay = document.getElementById('state-json-display');
const fileBreadcrumbs = document.getElementById('file-breadcrumbs');
const fileListDisplay = document.getElementById('file-list-display');
const refreshStateBtn = document.getElementById('refresh-state-btn');
const refreshFilesBtn = document.getElementById('refresh-files-btn');

// Overlay/Editor Elements
const fileViewerOverlay = document.getElementById('file-viewer-overlay');
const overlayFilename = document.getElementById('overlay-filename');
const overlayEditor = document.getElementById('overlay-editor');
const editorCancelBtn = document.getElementById('editor-cancel-btn');
const editorSaveBtn = document.getElementById('editor-save-btn');

// Conversation Tab Elements
const conversationSelect = document.getElementById('conversation-select');
const commandsListDisplay = document.getElementById('commands-list-display');
const transcriptChatDisplay = document.getElementById('transcript-chat-display');
const refreshCommandsBtn = document.getElementById('refresh-commands-btn');
const refreshTranscriptBtn = document.getElementById('refresh-transcript-btn');
const chatMessageInput = document.getElementById('chat-message-input');
const chatSendBtn = document.getElementById('chat-send-btn');

// Artifacts Elements
const artifactsListDisplay = document.getElementById('artifacts-list-display');
const refreshArtifactsBtn = document.getElementById('refresh-artifacts-btn');
const artifactViewerOverlay = document.getElementById('artifact-viewer-overlay');
const artifactFilename = document.getElementById('artifact-filename');
const artifactRenderedContent = document.getElementById('artifact-rendered-content');
const artifactCloseBtn = document.getElementById('artifact-close-btn');

// Keypad toggle helpers
const ctrlBtn = document.querySelector('[data-key="Ctrl"]');

// Initialize Web UI
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initTerminal();
    connectWebSockets();
    initWorkspaceSelector();
    initFileExplorer();
    initKeypad();
    initEditor();
    initConversationTab();
    initArtifactViewer();
});

// 1. Tab Navigation
function initTabs() {
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            
            // Clear polling interval if switching away from conversation-tab
            if (commandsPollingInterval) {
                clearInterval(commandsPollingInterval);
                commandsPollingInterval = null;
            }
            
            // Toggle buttons
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Toggle views
            tabViews.forEach(v => v.classList.remove('active'));
            const activeView = document.getElementById(target);
            activeView.classList.add('active');
            
            // Special action for terminal view: must resize xterm when visible
            if (target === 'terminal-tab' && fitAddon) {
                setTimeout(() => {
                    fitAddon.fit();
                }, 50);
            }
            
            // Start background commands polling when conversation tab is selected
            if (target === 'conversation-tab') {
                loadBackgroundCommands();
                commandsPollingInterval = setInterval(loadBackgroundCommands, 5000);
                
                // Force a scroll to the bottom now that the container is visible
                setTimeout(() => {
                    transcriptChatDisplay.scrollTop = transcriptChatDisplay.scrollHeight;
                }, 50);
            }
        });
    });
}

// 2. Terminal Initialization
function initTerminal() {
    term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'SFMono-Regular, Consolas, Courier, monospace',
        theme: {
            background: '#000000',
            foreground: '#ffffff',
            cursor: '#ffffff',
            black: '#000000',
            red: '#ff453a',
            green: '#30d158',
            yellow: '#ffd60a',
            blue: '#0a84ff',
            magenta: '#bf5af2',
            cyan: '#5ac8fa',
            white: '#ffffff'
        },
        convertEol: true
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    
    const container = document.getElementById('terminal-container');
    term.open(container);
    fitAddon.fit();

    // Monitor resize
    window.addEventListener('resize', () => {
        if (document.getElementById('terminal-tab').classList.contains('active')) {
            fitAddon.fit();
        }
    });

    // Handle terminal input
    term.onData(data => {
        if (ctrlActive) {
            // Convert character to control character
            const charCode = data.charCodeAt(0);
            let ctrlCode = data;
            if (charCode >= 97 && charCode <= 122) { // a-z
                ctrlCode = String.fromCharCode(charCode - 96);
            } else if (charCode >= 65 && charCode <= 90) { // A-Z
                ctrlCode = String.fromCharCode(charCode - 64);
            }
            sendTerminalData(ctrlCode);
            toggleCtrl(false);
        } else {
            sendTerminalData(data);
        }
    });
}

function sendTerminalData(data) {
    if (termWs && termWs.readyState === WebSocket.OPEN) {
        termWs.send(data);
    }
}

// 3. WebSockets Manager
function connectWebSockets() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    
    // Terminal WebSocket
    termWs = new WebSocket(`${protocol}//${host}/ws/terminal`);
    
    termWs.onopen = () => {
        updateConnectionStatus(true);
        term.write('\r\n*** CONNECTED TO WORKSPACE SHELL ***\r\n');
        fitAddon.fit();
    };
    
    termWs.onmessage = (event) => {
        term.write(event.data);
    };
    
    termWs.onclose = () => {
        updateConnectionStatus(false);
        term.write('\r\n*** SHELL DISCONNECTED ***\r\n');
        // Reconnect after 3 seconds
        setTimeout(connectWebSockets, 3000);
    };
    
    termWs.onerror = () => {
        termWs.close();
    };

    // State WebSocket
    stateWs = new WebSocket(`${protocol}//${host}/ws/state`);
    
    stateWs.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            handleStateUpdate(payload);
        } catch (e) {
            console.error('Failed to parse state WS message:', e);
        }
    };
}

function updateConnectionStatus(connected) {
    if (connected) {
        wsStatusDot.className = 'status-dot connected';
        wsStatusText.textContent = 'Connected';
    } else {
        wsStatusDot.className = 'status-dot';
        wsStatusText.textContent = 'Disconnected';
    }
}

// 4. Handle State Updates
function handleStateUpdate(payload) {
    const filename = payload.file;
    const data = payload.data;
    
    if (filename === 'workspace_state.json') {
        stateJsonDisplay.textContent = JSON.stringify(data, null, 2);
    } else if (filename === 'pending_approval.json') {
        renderPendingApproval(data);
    }
}

// Render approvals layout
function renderPendingApproval(data) {
    const status = data.status || 'idle';
    
    if (status === 'pending') {
        approvalBadge.classList.remove('hidden');
        approvalBadge.textContent = '1';
        
        pendingApprovalContainer.innerHTML = `
            <div class="approval-card">
                <h2>Pending Approval</h2>
                <div class="approval-meta">
                    <div class="meta-row">
                        <span class="meta-label">Command to execute</span>
                        <div class="meta-value">${escapeHtml(data.command)}</div>
                    </div>
                    ${data.reason ? `
                    <div class="meta-row">
                        <span class="meta-label">Reason / Context</span>
                        <div class="meta-value">${escapeHtml(data.reason)}</div>
                    </div>` : ''}
                </div>
                <div class="approval-actions">
                    <button class="btn btn-secondary" onclick="respondApproval(false)">Reject</button>
                    <button class="btn primary" onclick="respondApproval(true)">Approve</button>
                </div>
            </div>
        `;
    } else {
        approvalBadge.classList.add('hidden');
        pendingApprovalContainer.innerHTML = `
            <div class="idle-state">
                <p>Status: <strong>${status.toUpperCase()}</strong></p>
                <p style="margin-top: 8px; font-size: 0.8rem;">No pending agent actions require approval at this time.</p>
            </div>
        `;
    }
}

// Post response to approval
async function respondApproval(approved) {
    const endpoint = approved ? '/approval/confirm' : '/approval/reject';
    pendingApprovalContainer.innerHTML = '<div class="idle-state">Submitting approval decision...</div>';
    
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const resData = await response.json();
        console.log('Approval response:', resData);
    } catch (e) {
        console.error('Error submitting approval response:', e);
        alert('Failed to submit approval response.');
    }
}

// Make respondApproval globally available
window.respondApproval = respondApproval;

// 5. Keypad Action Handlers
function initKeypad() {
    const keys = document.querySelectorAll('.keypad-btn');
    keys.forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-key');
            
            if (action === 'Ctrl') {
                toggleCtrl(!ctrlActive);
            } else if (action === 'Esc') {
                sendTerminalData('\x1b');
            } else if (action === 'Tab') {
                sendTerminalData('\t');
            } else if (action === 'ArrowUp') {
                sendTerminalData('\x1b[A');
            } else if (action === 'ArrowDown') {
                sendTerminalData('\x1b[B');
            } else if (action === 'ArrowLeft') {
                sendTerminalData('\x1b[D');
            } else if (action === 'ArrowRight') {
                sendTerminalData('\x1b[C');
            } else if (action === 'Clear') {
                term.clear();
            }
        });
    });
}

function toggleCtrl(active) {
    ctrlActive = active;
    if (ctrlActive) {
        ctrlBtn.style.backgroundColor = '#ffffff';
        ctrlBtn.style.color = '#000000';
    } else {
        ctrlBtn.style.backgroundColor = '';
        ctrlBtn.style.color = '';
    }
}

// 6. Workspace Selector & Initial Fetch
async function loadRecentWorkspaces() {
    try {
        const res = await fetch('/api/workspaces/recent');
        const data = await res.json();
        if (data.status === 'success' && data.workspaces) {
            let html = '';
            data.workspaces.forEach(path => {
                const folderName = path.split('/').pop() || path;
                html += `<option value="${path}">${escapeHtml(folderName)} (${escapeHtml(path)})</option>`;
            });
            workspaceRecentSelect.innerHTML = html || '<option value="">No recent folders</option>';
            if (activeWorkspacePath) {
                workspaceRecentSelect.value = activeWorkspacePath;
            }
        }
    } catch (e) {
        console.error('Error loading recent workspaces:', e);
        workspaceRecentSelect.innerHTML = '<option value="">Failed to load recents</option>';
    }
}

async function initWorkspaceSelector() {
    // Load current active workspace on page load
    try {
        const wsRes = await fetch('/api/workspace');
        const wsData = await wsRes.json();
        if (wsData.active_workspace) {
            activeWorkspacePath = wsData.active_workspace;
            workspacePathInput.value = activeWorkspacePath;
            currentFileExplorerPath = '';
            loadWorkspaceFiles('');
        }
    } catch (e) {
        console.error('Error fetching active workspace path:', e);
    }

    // Load recent workspaces list
    await loadRecentWorkspaces();

    // Load initial state
    try {
        const stateRes = await fetch('/state');
        const stateData = await stateRes.json();
        stateJsonDisplay.textContent = JSON.stringify(stateData, null, 2);
        
        const appRes = await fetch('/approval/pending');
        const appData = await appRes.json();
        renderPendingApproval(appData);
    } catch (e) {
        console.error('Error loading initial details:', e);
    }

    workspaceRecentSelect.addEventListener('change', () => {
        const val = workspaceRecentSelect.value;
        if (val) {
            workspacePathInput.value = val;
            workspaceSelectBtn.click();
        }
    });

    workspaceSelectBtn.addEventListener('click', async () => {
        const path = workspacePathInput.value.trim();
        if (!path) return;
        
        workspaceSelectBtn.disabled = true;
        workspaceSelectBtn.textContent = '...';
        
        try {
            const res = await fetch('/workspace/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: path })
            });
            const data = await res.json();
            if (data.status === 'success') {
                activeWorkspacePath = data.active_workspace;
                workspacePathInput.value = activeWorkspacePath;
                currentFileExplorerPath = '';
                loadWorkspaceFiles('');
                await loadRecentWorkspaces();
            } else {
                alert(data.message || 'Failed to select workspace.');
            }
        } catch (e) {
            console.error(e);
            alert('Failed to select workspace.');
        } finally {
            workspaceSelectBtn.disabled = false;
            workspaceSelectBtn.textContent = 'Set';
        }
    });

    // Handle refresh buttons
    refreshStateBtn.addEventListener('click', async () => {
        try {
            const stateRes = await fetch('/state');
            const stateData = await stateRes.json();
            stateJsonDisplay.textContent = JSON.stringify(stateData, null, 2);
        } catch (e) {
            console.error(e);
        }
    });

    refreshFilesBtn.addEventListener('click', () => {
        loadWorkspaceFiles(currentFileExplorerPath);
    });
}

// 7. Workspace File Explorer
function initFileExplorer() {
    loadWorkspaceFiles('');
}

async function loadWorkspaceFiles(path) {
    fileListDisplay.innerHTML = '<li class="idle-state">Loading files...</li>';
    currentFileExplorerPath = path;
    updateBreadcrumbs(path);
    
    try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        
        if (data.status === 'success') {
            renderFileList(data.files || []);
        } else {
            fileListDisplay.innerHTML = `<li class="idle-state" style="color: #ff3b30;">Error: ${data.message}</li>`;
        }
    } catch (e) {
        console.error(e);
        fileListDisplay.innerHTML = '<li class="idle-state" style="color: #ff3b30;">Failed to fetch workspace files.</li>';
    }
}

function updateBreadcrumbs(path) {
    if (!path) {
        fileBreadcrumbs.innerHTML = '<span class="breadcrumb-link" onclick="loadWorkspaceFiles(\'\')">workspace</span> /';
        return;
    }
    
    const parts = path.split('/');
    let accumPath = '';
    let breadcrumbHtml = '<span class="breadcrumb-link" onclick="loadWorkspaceFiles(\'\')">workspace</span>';
    
    parts.forEach((part) => {
        if (!part) return;
        accumPath += (accumPath ? '/' : '') + part;
        breadcrumbHtml += ` / <span class="breadcrumb-link" onclick="loadWorkspaceFiles('${escapeQuotes(accumPath)}')">${escapeHtml(part)}</span>`;
    });
    
    fileBreadcrumbs.innerHTML = breadcrumbHtml;
}

function renderFileList(files) {
    if (files.length === 0) {
        fileListDisplay.innerHTML = '<li class="idle-state">This directory is empty.</li>';
        return;
    }
    
    let html = '';
    
    // If not in root directory, add a "go back" option
    if (currentFileExplorerPath) {
        const parts = currentFileExplorerPath.split('/');
        parts.pop();
        const parentPath = parts.join('/');
        html += `
            <li class="file-item" onclick="loadWorkspaceFiles('${escapeQuotes(parentPath)}')">
                <div class="file-info">
                    <span class="file-icon dir">DIR</span>
                    <span class="file-name">.. (Go Up)</span>
                </div>
            </li>
        `;
    }
    
    files.forEach(file => {
        const sizeStr = file.is_dir ? '' : formatBytes(file.size);
        const iconType = file.is_dir ? 'dir' : 'file';
        const clickAction = file.is_dir 
            ? `loadWorkspaceFiles('${escapeQuotes(file.path)}')`
            : `openFileEditor('${escapeQuotes(file.path)}')`;
            
        html += `
            <li class="file-item" onclick="${clickAction}">
                <div class="file-info">
                    <span class="file-icon ${iconType}">${iconType.toUpperCase()}</span>
                    <span class="file-name">${escapeHtml(file.name)}</span>
                </div>
                ${sizeStr ? `<span class="file-size">${sizeStr}</span>` : ''}
            </li>
        `;
    });
    
    fileListDisplay.innerHTML = html;
}

// 8. File Viewer & Editor Modal
function initEditor() {
    editorCancelBtn.addEventListener('click', () => {
        fileViewerOverlay.classList.remove('active');
        openFilePath = '';
        overlayEditor.value = '';
    });
    
    editorSaveBtn.addEventListener('click', async () => {
        if (!openFilePath) return;
        
        editorSaveBtn.textContent = 'Saving...';
        editorSaveBtn.disabled = true;
        
        try {
            const res = await fetch('/api/file/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: openFilePath,
                    content: overlayEditor.value
                })
            });
            const data = await res.json();
            if (data.status === 'success') {
                alert('File saved successfully!');
            } else {
                alert(data.message || 'Failed to save file.');
            }
        } catch (e) {
            console.error(e);
            alert('Error occurred while saving file.');
        } finally {
            editorSaveBtn.textContent = 'Save';
            editorSaveBtn.disabled = false;
        }
    });
}

async function openFileEditor(filePath) {
    openFilePath = filePath;
    overlayFilename.textContent = filePath.split('/').pop() || filePath;
    overlayEditor.value = 'Loading file content...';
    overlayEditor.disabled = true;
    editorSaveBtn.style.display = 'none'; // Hide save until file is loaded
    
    fileViewerOverlay.classList.add('active');
    
    try {
        const res = await fetch(`/api/file/content?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        
        if (data.status === 'success') {
            overlayEditor.value = data.content;
            overlayEditor.disabled = false;
            editorSaveBtn.style.display = 'block'; // Show save button
        } else {
            overlayEditor.value = `Error loading file: ${data.message}`;
            overlayEditor.disabled = true;
        }
    } catch (e) {
        console.error(e);
        overlayEditor.value = 'Failed to fetch file content.';
        overlayEditor.disabled = true;
    }
}

// Conversation & Process & Artifact functions

async function sendChatMessage() {
    const message = chatMessageInput.value.trim();
    if (!message || !activeConversationId) return;
    
    chatMessageInput.value = '';
    chatMessageInput.disabled = true;
    chatSendBtn.disabled = true;
    chatSendBtn.textContent = '...';
    
    try {
        const res = await fetch(`/api/conversation/${activeConversationId}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message })
        });
        const data = await res.json();
        if (data.status === 'success') {
            await loadConversationTranscript(activeConversationId, true);
        } else {
            alert(data.message || 'Failed to send message.');
        }
    } catch (e) {
        console.error(e);
        alert('Error sending message.');
    } finally {
        chatMessageInput.disabled = false;
        chatSendBtn.disabled = false;
        chatSendBtn.textContent = 'Send';
        chatMessageInput.focus();
    }
}

async function initConversationTab() {
    // 1. Fetch conversations
    await loadConversations();
    
    // 2. Select listener
    conversationSelect.addEventListener('change', () => {
        const id = conversationSelect.value;
        if (id) {
            activeConversationId = id;
            loadConversationTranscript(id, true);
            loadConversationArtifacts(id);
        }
    });
    
    // 3. Refresh listeners
    refreshTranscriptBtn.addEventListener('click', () => {
        if (activeConversationId) loadConversationTranscript(activeConversationId, false);
    });
    refreshCommandsBtn.addEventListener('click', () => {
        loadBackgroundCommands();
    });
    refreshArtifactsBtn.addEventListener('click', () => {
        if (activeConversationId) loadConversationArtifacts(activeConversationId);
    });
    
    // 4. Send message listeners
    chatSendBtn.addEventListener('click', sendChatMessage);
    chatMessageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendChatMessage();
        }
    });
}

async function loadConversations() {
    try {
        const res = await fetch('/api/conversations');
        const data = await res.json();
        if (data.status === 'success' && data.conversations) {
            let html = '';
            data.conversations.forEach((c) => {
                html += `<option value="${c.id}">${escapeHtml(c.title)} (${c.id.slice(0, 8)})</option>`;
            });
            conversationSelect.innerHTML = html || '<option value="">No active conversations</option>';
            
            // Get current active conversation ID
            const curRes = await fetch('/api/conversation/current');
            const curData = await curRes.json();
            if (curData.status === 'success' && curData.current_id) {
                activeConversationId = curData.current_id;
                conversationSelect.value = activeConversationId;
                loadConversationTranscript(activeConversationId, true);
                loadConversationArtifacts(activeConversationId);
            } else if (data.conversations.length > 0) {
                activeConversationId = data.conversations[0].id;
                conversationSelect.value = activeConversationId;
                loadConversationTranscript(activeConversationId, true);
                loadConversationArtifacts(activeConversationId);
            }
        }
    } catch (e) {
        console.error('Error fetching conversations:', e);
        conversationSelect.innerHTML = '<option value="">Failed to load</option>';
    }
}

async function loadConversationTranscript(id, forceScroll = false) {
    const isFirstLoad = forceScroll || (transcriptChatDisplay.innerHTML.includes('No chat messages found') || transcriptChatDisplay.innerHTML.includes('Loading chat history'));
    
    if (isFirstLoad) {
        transcriptChatDisplay.innerHTML = '<div class="idle-state">Loading chat history...</div>';
    }
    
    // Calculate if user is currently scrolled to the bottom (within a 50px threshold)
    const isAtBottom = (transcriptChatDisplay.scrollHeight - transcriptChatDisplay.clientHeight) - transcriptChatDisplay.scrollTop < 50;
    
    try {
        const res = await fetch(`/api/conversation/${id}/transcript`);
        const data = await res.json();
        if (data.status === 'success' && data.messages) {
            if (data.messages.length === 0) {
                transcriptChatDisplay.innerHTML = '<div class="idle-state">No messages in this chat.</div>';
                return;
            }
            
            let html = '';
            data.messages.forEach((m) => {
                const isUser = m.sender === 'user';
                const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
                html += `
                    <div class="chat-bubble ${isUser ? 'user' : 'assistant'}">
                        <div class="chat-meta">${isUser ? 'USER' : 'ANTIGRAVITY'} - ${timeStr}</div>
                        <div>${escapeHtml(m.content).replace(/\n/g, '<br/>')}</div>
                    </div>
                `;
            });
            transcriptChatDisplay.innerHTML = html;
            
            // Auto scroll down if it is first load, or if they were already scrolled to the bottom
            if (isFirstLoad || isAtBottom) {
                setTimeout(() => {
                    transcriptChatDisplay.scrollTop = transcriptChatDisplay.scrollHeight;
                }, 50);
            }
        } else {
            transcriptChatDisplay.innerHTML = `<div class="idle-state" style="color: #ff3b30;">Error: ${data.message}</div>`;
        }
    } catch (e) {
        console.error(e);
        transcriptChatDisplay.innerHTML = '<div class="idle-state" style="color: #ff3b30;">Failed to load chat history.</div>';
    }
}

async function loadBackgroundCommands() {
    try {
        const res = await fetch('/api/background-commands');
        const data = await res.json();
        if (data.status === 'success' && data.commands) {
            if (data.commands.length === 0) {
                commandsListDisplay.innerHTML = '<li class="idle-state" style="padding: 12px 8px; font-size: 0.8rem;">No active background processes.</li>';
                return;
            }
            
            let html = '';
            data.commands.forEach((c) => {
                const isPTY = c.source === 'PTY Terminal';
                const isRunning = c.status.startsWith('R') || c.status.startsWith('S') || c.status.startsWith('I');
                const statusClass = isRunning ? 'running' : 'other';
                html += `
                    <li class="command-item">
                        <div class="command-row-top">
                            <span class="command-source">${escapeHtml(c.source)}</span>
                            <span class="command-pid">PID: ${c.pid}</span>
                            <span class="command-status ${statusClass}">${escapeHtml(c.status)}</span>
                        </div>
                        <div class="command-text">${escapeHtml(c.command)}</div>
                    </li>
                `;
            });
            commandsListDisplay.innerHTML = html;
        }
    } catch (e) {
        console.error('Error fetching background commands:', e);
    }
}

async function loadConversationArtifacts(id) {
    artifactsListDisplay.innerHTML = '<li class="idle-state">Loading artifacts...</li>';
    try {
        const res = await fetch(`/api/conversation/${id}/artifacts`);
        const data = await res.json();
        if (data.status === 'success' && data.artifacts) {
            if (data.artifacts.length === 0) {
                artifactsListDisplay.innerHTML = '<li class="idle-state" style="padding: 12px 8px; font-size: 0.8rem;">No artifacts in this conversation.</li>';
                return;
            }
            
            let html = '';
            data.artifacts.forEach((art) => {
                html += `
                    <li class="file-item" onclick="openArtifactViewer('${escapeQuotes(art.name)}')">
                        <div class="file-info">
                            <span class="file-icon file">DOC</span>
                            <span class="file-name">${escapeHtml(art.name)}</span>
                        </div>
                        <span class="file-size">${formatBytes(art.size)}</span>
                    </li>
                `;
            });
            artifactsListDisplay.innerHTML = html;
        } else {
            artifactsListDisplay.innerHTML = `<li class="idle-state" style="color: #ff3b30;">Error: ${data.message}</li>`;
        }
    } catch (e) {
        console.error(e);
        artifactsListDisplay.innerHTML = '<li class="idle-state" style="color: #ff3b30;">Failed to load artifacts.</li>';
    }
}

function initArtifactViewer() {
    artifactCloseBtn.addEventListener('click', () => {
        artifactViewerOverlay.classList.remove('active');
        currentArtifactName = '';
        currentArtifactLines = [];
    });
}

async function openArtifactViewer(name) {
    currentArtifactName = name;
    artifactFilename.textContent = name;
    artifactRenderedContent.innerHTML = '<div class="idle-state">Loading document...</div>';
    artifactViewerOverlay.classList.add('active');
    
    try {
        const res = await fetch(`/api/conversation/${activeConversationId}/artifact/${name}`);
        const data = await res.json();
        if (data.status === 'success') {
            currentArtifactLines = data.content.split('\n');
            renderArtifactHtml();
        } else {
            artifactRenderedContent.innerHTML = `<div class="idle-state" style="color: #ff3b30;">Error: ${data.message}</div>`;
        }
    } catch (e) {
        console.error(e);
        artifactRenderedContent.innerHTML = '<div class="idle-state" style="color: #ff3b30;">Failed to load document content.</div>';
    }
}

function renderArtifactHtml() {
    let inCodeBlock = false;
    let html = '<div class="markdown-body">';
    
    for (let i = 0; i < currentArtifactLines.length; i++) {
        const line = currentArtifactLines[i];
        
        if (line.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            html += inCodeBlock ? '<pre><code>' : '</code></pre>';
            continue;
        }
        
        if (inCodeBlock) {
            html += escapeHtml(line) + '\n';
            continue;
        }
        
        if (line.startsWith('# ')) {
            html += `<h1>${escapeHtml(line.slice(2))}</h1>`;
        } else if (line.startsWith('## ')) {
            html += `<h2>${escapeHtml(line.slice(3))}</h2>`;
        } else if (line.startsWith('### ')) {
            html += `<h3>${escapeHtml(line.slice(4))}</h3>`;
        } else if (line.trim().startsWith('- [ ]') || line.trim().startsWith('- [x]') || line.trim().startsWith('- [/]')) {
            const checked = line.includes('[x]');
            const inProgress = line.includes('[/]');
            const text = line.replace(/^-\s+\[[ x/]\]/, '').trim();
            const progressBadge = inProgress ? ' <span style="color: #ffd60a; font-family: monospace;">[/]</span>' : '';
            html += `
                <li class="task-list-item">
                    <input type="checkbox" class="task-list-item-checkbox" data-line-index="${i}" ${checked ? 'checked' : ''} onchange="toggleTaskCheckbox(this)" />
                    <span>${escapeHtml(text)}${progressBadge}</span>
                </li>
            `;
        } else if (line.trim().startsWith('- ')) {
            html += `<li>${escapeHtml(line.trim().slice(2))}</li>`;
        } else if (line.trim() === '') {
            // empty space
        } else {
            html += `<p>${escapeHtml(line)}</p>`;
        }
    }
    html += '</div>';
    artifactRenderedContent.innerHTML = html;
}

async function toggleTaskCheckbox(checkbox) {
    const lineIndex = parseInt(checkbox.getAttribute('data-line-index'));
    const isChecked = checkbox.checked;
    
    let line = currentArtifactLines[lineIndex];
    if (isChecked) {
        currentArtifactLines[lineIndex] = line.replace(/\[[ /]\]/, '[x]');
    } else {
        currentArtifactLines[lineIndex] = line.replace(/\[[x/]\]/, '[ ]');
    }
    
    const updatedContent = currentArtifactLines.join('\n');
    try {
        const res = await fetch(`/api/conversation/${activeConversationId}/artifact/${currentArtifactName}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: updatedContent })
        });
        const data = await res.json();
        if (data.status === 'success') {
            renderArtifactHtml();
        } else {
            alert(data.message || 'Failed to save task update.');
        }
    } catch (e) {
        console.error(e);
        alert('Error saving task checklist update.');
    }
}

// Make functions globally available
window.toggleTaskCheckbox = toggleTaskCheckbox;
window.loadWorkspaceFiles = loadWorkspaceFiles;
window.openArtifactViewer = openArtifactViewer;

// Utilities
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeQuotes(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'");
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
