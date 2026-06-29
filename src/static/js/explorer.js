// Workspace Select, File Explorer, Editor Overlay, Git, and Approvals
import { escapeHtml, escapeQuotes, formatBytes, showToast } from './api.js';
import { fitAddon } from './terminal.js';
import { loadConversationTranscript, loadConversationArtifacts, getActiveConversationId } from './chat.js';

export let activeWorkspacePath = '';
export let pendingWorkspacePath = '';
export let currentFileExplorerPath = '';
export let openFilePath = '';

// DOM Elements
const workspaceRecentSelect = document.getElementById('workspace-recent-select');
const workspaceRecentOptions = document.getElementById('workspace-recent-options');
const acceptChangesBtn = document.getElementById('accept-changes-btn');
const acceptChangesBanner = document.getElementById('accept-changes-banner');
const projectLinkPanel = document.getElementById('project-link-panel');
const approvalBadge = document.getElementById('approval-badge');
const pendingApprovalContainer = document.getElementById('pending-approval-container');
const stateJsonDisplay = document.getElementById('state-json-display');
const fileBreadcrumbs = document.getElementById('file-breadcrumbs');
const fileListDisplay = document.getElementById('file-list-display');
const refreshStateBtn = document.getElementById('refresh-state-btn');
const refreshFilesBtn = document.getElementById('refresh-files-btn');

const fileViewerOverlay = document.getElementById('file-viewer-overlay');
const overlayFilename = document.getElementById('overlay-filename');
const overlayEditor = document.getElementById('overlay-editor');
const editorCancelBtn = document.getElementById('editor-cancel-btn');
const editorSaveBtn = document.getElementById('editor-save-btn');

// Handle State Updates from WS
export function handleStateUpdate(payload) {
    const filename = payload.file;
    const data = payload.data;
    const activeConversationId = getActiveConversationId();
    
    if (filename === 'workspace_state.json') {
        if (stateJsonDisplay) {
            stateJsonDisplay.textContent = JSON.stringify(data, null, 2);
        }
    } else if (filename === 'pending_approval.json') {
        renderPendingApproval(data);
    } else if (filename === 'transcript.jsonl') {
        if (activeConversationId && (!data || !data.conversation_id || data.conversation_id === activeConversationId)) {
            loadConversationTranscript(activeConversationId, false);
        }
    } else if (filename === 'artifacts') {
        if (activeConversationId && (!data || !data.conversation_id || data.conversation_id === activeConversationId)) {
            loadConversationArtifacts(activeConversationId);
        }
    }
    checkGitChangesStatus();
}

// Render approvals layout
export function renderPendingApproval(data) {
    const status = data.status || 'idle';
    
    if (status === 'pending') {
        if (approvalBadge) {
            approvalBadge.classList.remove('hidden');
            approvalBadge.textContent = '1';
        }
        
        if (pendingApprovalContainer) {
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
                        <button class="btn btn-secondary" id="approval-reject-btn">Reject</button>
                        <button class="btn primary" id="approval-confirm-btn">Approve</button>
                    </div>
                </div>
            `;
            
            document.getElementById('approval-reject-btn').onclick = () => respondApproval(false);
            document.getElementById('approval-confirm-btn').onclick = () => respondApproval(true);
        }
    } else {
        if (approvalBadge) approvalBadge.classList.add('hidden');
        if (pendingApprovalContainer) {
            pendingApprovalContainer.innerHTML = `
                <div class="idle-state">
                    <p>Status: <strong>${status.toUpperCase()}</strong></p>
                    <p style="margin-top: 8px; font-size: 0.8rem;">No pending agent actions require approval at this time.</p>
                </div>
            `;
        }
    }
}

// Post response to approval
export async function respondApproval(approved) {
    const endpoint = approved ? '/approval/confirm' : '/approval/reject';
    if (pendingApprovalContainer) {
        pendingApprovalContainer.innerHTML = '<div class="idle-state">Submitting approval decision...</div>';
    }
    
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const resData = await response.json();
        console.log('Approval response:', resData);
    } catch (e) {
        console.error('Error submitting approval response:', e);
        showToast('Failed to submit approval response.', 'error');
    }
}

// Check Git status
export async function checkGitChangesStatus() {
    try {
        const res = await fetch('/api/workspace/git-status');
        const data = await res.json();
        if (data.status === 'success' && data.is_dirty) {
            if (acceptChangesBanner) {
                acceptChangesBanner.classList.remove('hidden');
            }
        } else {
            if (acceptChangesBanner) {
                acceptChangesBanner.classList.add('hidden');
            }
        }
    } catch (e) {
        console.error('Error checking git status:', e);
    }
}

// Load recent workspaces
export async function loadRecentWorkspaces() {
    if (!workspaceRecentOptions) return;
    try {
        const res = await fetch('/api/workspaces/recent');
        const data = await res.json();
        if (data.status === 'success' && data.workspaces) {
            let html = '';
            data.workspaces.forEach(path => {
                const folderName = path.split('/').pop() || path;
                html += `<option value="${escapeHtml(path)}" label="${escapeHtml(folderName)}"></option>`;
            });
            workspaceRecentOptions.innerHTML = html;
            if (activeWorkspacePath && workspaceRecentSelect) {
                workspaceRecentSelect.value = activeWorkspacePath;
            }
        }
    } catch (e) {
        console.error('Error loading recent workspaces:', e);
        workspaceRecentOptions.innerHTML = '';
    }
}

// Select workspace CWD path
export async function selectWorkspacePath(path) {
    const selectedPath = String(path || '').trim();
    if (!selectedPath) return;
    if (pendingWorkspacePath === selectedPath) return;

    pendingWorkspacePath = selectedPath;
    if (workspaceRecentSelect) workspaceRecentSelect.disabled = true;

    try {
        const res = await fetch('/workspace/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: selectedPath })
        });
        const data = await res.json();
        if (data.status === 'success') {
            activeWorkspacePath = data.active_workspace;
            currentFileExplorerPath = '';
            loadWorkspaceFiles('');
            await loadRecentWorkspaces();
            checkGitChangesStatus();
        } else {
            showToast(data.message || 'Failed to select workspace.', 'error');
            if (workspaceRecentSelect) workspaceRecentSelect.value = activeWorkspacePath;
        }
    } catch (e) {
        console.error(e);
        showToast('Failed to select workspace.', 'error');
        if (workspaceRecentSelect) workspaceRecentSelect.value = activeWorkspacePath;
    } finally {
        pendingWorkspacePath = '';
        if (workspaceRecentSelect) workspaceRecentSelect.disabled = false;
    }
}

function isRecentWorkspacePath(path) {
    if (!workspaceRecentOptions) return false;
    const selectedPath = String(path || '').trim();
    if (!selectedPath) return false;
    return Array.from(workspaceRecentOptions.options).some(option => option.value === selectedPath);
}

// Initialize workspace selector
export async function initWorkspaceSelector() {
    try {
        const wsRes = await fetch('/api/workspace');
        const wsData = await wsRes.json();
        if (wsData.active_workspace) {
            activeWorkspacePath = wsData.active_workspace;
            currentFileExplorerPath = '';
            loadWorkspaceFiles('');
        }
    } catch (e) {
        console.error('Error fetching active workspace path:', e);
    }

    await loadRecentWorkspaces();

    try {
        const stateRes = await fetch('/state');
        const stateData = await stateRes.json();
        if (stateJsonDisplay) {
            stateJsonDisplay.textContent = JSON.stringify(stateData, null, 2);
        }
        
        const appRes = await fetch('/approval/pending');
        const appData = await appRes.json();
        renderPendingApproval(appData);
    } catch (e) {
        console.error('Error loading initial details:', e);
    }

    if (workspaceRecentSelect) {
        workspaceRecentSelect.addEventListener('change', () => {
            const val = workspaceRecentSelect.value;
            if (val) {
                selectWorkspacePath(val);
            }
        });

        workspaceRecentSelect.addEventListener('input', () => {
            if (isRecentWorkspacePath(workspaceRecentSelect.value)) {
                selectWorkspacePath(workspaceRecentSelect.value);
            }
        });

        workspaceRecentSelect.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                selectWorkspacePath(workspaceRecentSelect.value);
            }
        });
    }

    if (acceptChangesBtn) {
        acceptChangesBtn.addEventListener('click', async () => {
            acceptChangesBtn.disabled = true;
            acceptChangesBtn.textContent = 'Accepting...';
            try {
                const res = await fetch('/api/workspace/accept-changes', { method: 'POST' });
                const data = await res.json();
                if (data.status === 'success') {
                    showToast(data.message, 'success');
                    if (acceptChangesBanner) {
                        acceptChangesBanner.classList.add('hidden');
                    }
                    loadWorkspaceFiles(currentFileExplorerPath || '');
                } else {
                    showToast(data.message || 'Failed to accept changes.', 'error');
                }
            } catch (e) {
                console.error('Error accepting changes:', e);
                showToast('Failed to accept changes.', 'error');
            } finally {
                acceptChangesBtn.disabled = false;
                acceptChangesBtn.textContent = 'Accept Changes';
            }
        });
    }

    checkGitChangesStatus();
    setInterval(checkGitChangesStatus, 2000);

    if (refreshStateBtn) {
        refreshStateBtn.addEventListener('click', async () => {
            try {
                const stateRes = await fetch('/state');
                const stateData = await stateRes.json();
                if (stateJsonDisplay) {
                    stateJsonDisplay.textContent = JSON.stringify(stateData, null, 2);
                }
            } catch (e) {
                console.error(e);
            }
        });
    }

    if (refreshFilesBtn) {
        refreshFilesBtn.addEventListener('click', () => {
            loadWorkspaceFiles(currentFileExplorerPath);
        });
    }
}

// Workspace File Explorer functions
export function initFileExplorer() {
    loadWorkspaceFiles('');
}

export async function loadWorkspaceFiles(path) {
    if (!fileListDisplay) return;
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
    if (!fileBreadcrumbs) return;
    if (!path) {
        fileBreadcrumbs.innerHTML = '<span class="breadcrumb-link" id="breadcrumb-root">workspace</span> /';
        document.getElementById('breadcrumb-root').onclick = () => loadWorkspaceFiles('');
        return;
    }
    
    const parts = path.split('/');
    let accumPath = '';
    let breadcrumbHtml = '<span class="breadcrumb-link" id="breadcrumb-root">workspace</span>';
    
    parts.forEach((part, idx) => {
        if (!part) return;
        accumPath += (accumPath ? '/' : '') + part;
        breadcrumbHtml += ` / <span class="breadcrumb-link" id="breadcrumb-part-${idx}">${escapeHtml(part)}</span>`;
    });
    
    fileBreadcrumbs.innerHTML = breadcrumbHtml;
    
    // Bind click actions after inserting HTML
    document.getElementById('breadcrumb-root').onclick = () => loadWorkspaceFiles('');
    let tempPath = '';
    parts.forEach((part, idx) => {
        if (!part) return;
        tempPath += (tempPath ? '/' : '') + part;
        const currentPathStr = tempPath;
        const el = document.getElementById(`breadcrumb-part-${idx}`);
        if (el) {
            el.onclick = () => loadWorkspaceFiles(currentPathStr);
        }
    });
}

function renderFileList(files) {
    if (!fileListDisplay) return;
    if (files.length === 0) {
        fileListDisplay.innerHTML = '<li class="idle-state">This directory is empty.</li>';
        return;
    }
    
    let html = '';
    
    if (currentFileExplorerPath) {
        const parts = currentFileExplorerPath.split('/');
        parts.pop();
        const parentPath = parts.join('/');
        html += `
            <li class="file-item" id="file-item-up">
                <div class="file-info">
                    <span class="file-icon dir">DIR</span>
                    <span class="file-name">.. (Go Up)</span>
                </div>
            </li>
        `;
    }
    
    files.forEach((file, idx) => {
        const sizeStr = file.is_dir ? '' : formatBytes(file.size);
        const iconType = file.is_dir ? 'dir' : 'file';
            
        html += `
            <li class="file-item" id="file-item-list-${idx}">
                <div class="file-info">
                    <span class="file-icon ${iconType}">${iconType.toUpperCase()}</span>
                    <span class="file-name">${escapeHtml(file.name)}</span>
                </div>
                ${sizeStr ? `<span class="file-size">${sizeStr}</span>` : ''}
            </li>
        `;
    });
    
    fileListDisplay.innerHTML = html;

    // Bind event listeners to DOM
    if (currentFileExplorerPath) {
        const parts = currentFileExplorerPath.split('/');
        parts.pop();
        const parentPath = parts.join('/');
        document.getElementById('file-item-up').onclick = () => loadWorkspaceFiles(parentPath);
    }

    files.forEach((file, idx) => {
        const el = document.getElementById(`file-item-list-${idx}`);
        if (el) {
            el.onclick = () => {
                if (file.is_dir) {
                    loadWorkspaceFiles(file.path);
                } else {
                    openFileEditor(file.path);
                }
            };
        }
    });
}

// File Viewer/Editor Modal functions
export function initEditor() {
    if (editorCancelBtn) {
        editorCancelBtn.addEventListener('click', () => {
            if (fileViewerOverlay) fileViewerOverlay.classList.remove('active');
            openFilePath = '';
            if (overlayEditor) overlayEditor.value = '';
        });
    }
    
    if (editorSaveBtn) {
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
                        content: overlayEditor ? overlayEditor.value : ''
                    })
                });
                const data = await res.json();
                if (data.status === 'success') {
                    showToast('File saved successfully!', 'success');
                } else {
                    showToast(data.message || 'Failed to save file.', 'error');
                }
            } catch (e) {
                console.error(e);
                showToast('Error occurred while saving file.', 'error');
            } finally {
                editorSaveBtn.textContent = 'Save';
                editorSaveBtn.disabled = false;
            }
        });
    }
}

export async function openFileEditor(filePath) {
    openFilePath = filePath;
    if (overlayFilename) overlayFilename.textContent = filePath.split('/').pop() || filePath;
    if (overlayEditor) {
        overlayEditor.value = 'Loading file content...';
        overlayEditor.disabled = true;
    }
    if (editorSaveBtn) editorSaveBtn.style.display = 'none';
    
    if (fileViewerOverlay) fileViewerOverlay.classList.add('active');
    
    try {
        const res = await fetch(`/api/file/content?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        
        if (data.status === 'success') {
            if (overlayEditor) {
                overlayEditor.value = data.content;
                overlayEditor.disabled = false;
            }
            if (editorSaveBtn) editorSaveBtn.style.display = 'block';
        } else {
            if (overlayEditor) {
                overlayEditor.value = `Error loading file: ${data.message}`;
                overlayEditor.disabled = true;
            }
        }
    } catch (e) {
        console.error(e);
        if (overlayEditor) {
            overlayEditor.value = 'Failed to fetch file content.';
            overlayEditor.disabled = true;
        }
    }
}
