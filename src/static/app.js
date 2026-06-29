// Gravity Link Mobile Application JavaScript

// State variables
let term;
let fitAddon;
let termWs;
let stateWs;
let activeWorkspacePath = '';
let pendingWorkspacePath = '';
let currentFileExplorerPath = '';
let ctrlActive = false;
let openFilePath = '';
let lastCopiedCodeBlockText = '';

// Conversation & Artifacts state
let activeConversationId = '';
let currentArtifactName = '';
let currentArtifactLines = [];

// Configure Marked and Highlight.js
configureMarkdownRenderer();

function configureMarkdownRenderer() {
    if (!window.marked || typeof marked.use !== 'function') {
        return;
    }

    marked.use({
        renderer: {
            code(codeOrToken, infostring) {
                const token = typeof codeOrToken === 'object' && codeOrToken !== null ? codeOrToken : null;
                const code = String(token ? (token.text ?? token.raw ?? '') : (codeOrToken ?? ''));
                const langInfo = token ? (token.lang ?? token.langString ?? '') : (infostring ?? '');
                const lang = String(langInfo || '').match(/\S*/)[0];
                const canHighlight = window.hljs && typeof hljs.getLanguage === 'function' && typeof hljs.highlight === 'function';
                const validLang = canHighlight && lang && hljs.getLanguage(lang) ? lang : 'plaintext';
                let highlighted = escapeHtml(code);

                if (canHighlight) {
                    try {
                        highlighted = hljs.highlight(code, { language: validLang }).value;
                    } catch (e) {
                        console.warn('Syntax highlight failed:', e);
                    }
                }

                return `
                    <div class="code-block-wrapper" tabindex="0">
                        <button class="btn-secondary icon-btn code-copy-btn" type="button" aria-label="Copy code block" title="Copy code">
                            <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <rect x="8" y="8" width="12" height="12" rx="2"></rect>
                                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
                            </svg>
                        </button>
                        <pre><code class="hljs language-${escapeHtml(validLang)}">${highlighted}</code></pre>
                    </div>
                `;
            },
            blockquote(quoteOrToken) {
                const quote = normalizeBlockquoteHtml(quoteOrToken);
                const rawText = normalizeBlockquoteText(quoteOrToken);
                const htmlAlertMatch = quote.match(/^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*/i);
                const textAlertMatch = rawText.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:\r?\n)?\s*/i);
                const alertMatch = htmlAlertMatch || textAlertMatch;

                if (alertMatch) {
                    const type = alertMatch[1].toLowerCase();
                    const alertIcons = {
                        note: 'ℹ️',
                        tip: '💡',
                        important: '📢',
                        warning: '⚠️',
                        caution: '🛑'
                    };
                    const icon = alertIcons[type] || 'ℹ️';
                    const content = htmlAlertMatch
                        ? quote.replace(/^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*/i, '<p>')
                        : renderMarkdownText(rawText.replace(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:\r?\n)?\s*/i, ''));

                    return `
                        <div class="alert-box alert-${type}">
                            <div class="alert-title">
                                <span class="alert-icon">${icon}</span>
                                <span>${type.toUpperCase()}</span>
                            </div>
                            <div class="alert-content">${content}</div>
                        </div>
                    `;
                }
                return `<blockquote>${quote}</blockquote>`;
            }
        }
    });
}

function normalizeBlockquoteHtml(quoteOrToken) {
    if (typeof quoteOrToken === 'string') {
        return quoteOrToken;
    }
    if (quoteOrToken && Array.isArray(quoteOrToken.tokens) && window.marked && typeof marked.parser === 'function') {
        try {
            return marked.parser(quoteOrToken.tokens);
        } catch (e) {
            console.warn('Blockquote token render failed:', e);
        }
    }
    return renderBasicMarkdown(quoteOrToken && quoteOrToken.text ? quoteOrToken.text : '');
}

function normalizeBlockquoteText(quoteOrToken) {
    if (typeof quoteOrToken === 'string') {
        return quoteOrToken.replace(/<[^>]+>/g, '').trim();
    }
    return String(quoteOrToken && quoteOrToken.text ? quoteOrToken.text : '').trim();
}

function renderMarkdownText(markdownText) {
    const text = String(markdownText ?? '');
    if (window.marked && typeof marked.parse === 'function') {
        try {
            return marked.parse(text);
        } catch (e) {
            console.error('Markdown render failed:', e);
        }
    }
    return renderBasicMarkdown(text);
}

function renderBasicMarkdown(markdownText) {
    return `<pre class="plain-markdown">${escapeHtml(String(markdownText ?? ''))}</pre>`;
}


// DOM Elements
const wsStatusDot = document.getElementById('ws-status-dot');
const wsStatusText = document.getElementById('ws-status-text');
const terminalContainer = document.getElementById('terminal-container');
const workspaceRecentSelect = document.getElementById('workspace-recent-select');
const workspaceRecentOptions = document.getElementById('workspace-recent-options');
const appChromeToggle = document.getElementById('app-chrome-toggle');
const topBanner = document.getElementById('top-banner');
const projectLinkPanel = document.getElementById('project-link-panel');
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
const transcriptChatDisplay = document.getElementById('transcript-chat-display');
const refreshTranscriptBtn = document.getElementById('refresh-transcript-btn');
const chatMessageInput = document.getElementById('chat-message-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const newChatBtn = document.getElementById('new-chat-btn');

// Artifacts Elements
const conversationArtifactsSection = document.getElementById('conversation-artifacts-section');
const artifactsListPanel = document.getElementById('artifacts-list-panel');
const toggleArtifactsBtn = document.getElementById('toggle-artifacts-btn');
const artifactsListDisplay = document.getElementById('artifacts-list-display');
const refreshArtifactsBtn = document.getElementById('refresh-artifacts-btn');
const artifactViewerOverlay = document.getElementById('artifact-viewer-overlay');
const artifactFilename = document.getElementById('artifact-filename');
const artifactRenderedContent = document.getElementById('artifact-rendered-content');
const artifactCloseBtn = document.getElementById('artifact-close-btn');

// Keypad toggle helpers
const ctrlBtn = document.querySelector('[data-key="Ctrl"]');

const artifactToggleIcons = {
    show: `
        <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path>
            <circle cx="12" cy="12" r="3"></circle>
        </svg>
    `,
    hide: `
        <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10.7 5.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17.5 17.5 0 0 1-3.2 4.3"></path>
            <path d="M6.6 6.6C3.5 8.7 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.9-1.3"></path>
            <path d="m2 2 20 20"></path>
            <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path>
            <path d="M14.1 9.9A3 3 0 0 0 12 9"></path>
        </svg>
    `
};

// Initialize Web UI
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initChromeCollapse();
    initTabs();
    initTerminal();
    connectWebSockets();
    initWorkspaceSelector();
    initFileExplorer();
    initKeypad();
    initEditor();
    initConversationTab();
    initArtifactViewer();
    initMarkdownCodeCopy();
});

function initMarkdownCodeCopy() {
    document.addEventListener('click', async (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;

        const copyBtn = target.closest('.code-copy-btn');
        const codeBlock = target.closest('.code-block-wrapper');

        if (!codeBlock) {
            clearSelectedCodeBlocks();
            return;
        }

        selectCodeBlock(codeBlock);

        if (copyBtn) {
            e.preventDefault();
            e.stopPropagation();
            await copyCodeBlockText(codeBlock, copyBtn);
        }
    });

    document.addEventListener('copy', rememberCopiedCodeBlockSelection);
}

function rememberCopiedCodeBlockSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const anchor = selection.anchorNode && selection.anchorNode.nodeType === Node.TEXT_NODE
        ? selection.anchorNode.parentElement
        : selection.anchorNode;
    const codeBlock = anchor instanceof Element ? anchor.closest('.code-block-wrapper') : null;
    if (!codeBlock) return;

    lastCopiedCodeBlockText = selection.toString() || codeBlock.querySelector('pre code')?.textContent || '';
}

function clearSelectedCodeBlocks() {
    document.querySelectorAll('.code-block-wrapper.selected').forEach((block) => {
        block.classList.remove('selected');
    });
}

function selectCodeBlock(codeBlock) {
    document.querySelectorAll('.code-block-wrapper.selected').forEach((block) => {
        if (block !== codeBlock) {
            block.classList.remove('selected');
        }
    });
    codeBlock.classList.add('selected');
}

async function copyCodeBlockText(codeBlock, button) {
    const code = codeBlock.querySelector('pre code');
    if (!code) return;

    const text = code.textContent || '';
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            fallbackCopyText(text);
        }
        lastCopiedCodeBlockText = text;
        showCopyButtonStatus(button, 'Copied');
    } catch (e) {
        console.error('Unable to copy code block:', e);
        showCopyButtonStatus(button, 'Failed');
    }
}

function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
}

function showCopyButtonStatus(button, label) {
    const originalLabel = button.dataset.defaultLabel || button.getAttribute('aria-label') || 'Copy code block';
    const originalTitle = button.dataset.defaultTitle || button.getAttribute('title') || 'Copy code';

    button.dataset.defaultLabel = originalLabel;
    button.dataset.defaultTitle = originalTitle;

    button.classList.add('copied');
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);

    window.setTimeout(() => {
        button.classList.remove('copied');
        button.setAttribute('aria-label', originalLabel);
        button.setAttribute('title', originalTitle);
    }, 1200);
}

// 1. Tab Navigation
function initTabs() {
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            

            
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
            
            if (target === 'conversation-tab') {
                // Force a scroll to the bottom now that the container is visible
                setTimeout(() => {
                    transcriptChatDisplay.scrollTop = transcriptChatDisplay.scrollHeight;
                }, 50);
            }
        });
    });
}

function initChromeCollapse() {
    if (!appChromeToggle || !topBanner || !projectLinkPanel) return;

    const savedState = getStoredCollapseState('topControls');
    const phoneFirstDefault = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    const shouldCollapse = savedState ? savedState === 'collapsed' : phoneFirstDefault;

    setChromeCollapsed(shouldCollapse, false);

    appChromeToggle.addEventListener('click', () => {
        setChromeCollapsed(!document.body.classList.contains('chrome-collapsed'), true);
    });
}

function setChromeCollapsed(collapsed, persist) {
    document.body.classList.toggle('chrome-collapsed', collapsed);
    topBanner.hidden = collapsed;
    projectLinkPanel.hidden = collapsed;
    appChromeToggle.textContent = collapsed ? '▼' : '▲';
    appChromeToggle.setAttribute('aria-expanded', String(!collapsed));
    appChromeToggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} top controls`);

    if (persist) {
        try {
            localStorage.setItem('collapse:topControls', collapsed ? 'collapsed' : 'expanded');
        } catch (e) {
            console.warn('Unable to save chrome collapse preference:', e);
        }
    }

    scheduleTerminalFit();
}

function getStoredCollapseState(key) {
    try {
        return localStorage.getItem(`collapse:${key}`);
    } catch (e) {
        console.warn('Unable to read chrome collapse preference:', e);
        return null;
    }
}

function scheduleTerminalFit() {
    if (!fitAddon || !document.getElementById('terminal-tab').classList.contains('active')) return;

    setTimeout(() => {
        fitAddon.fit();
    }, 50);
}

const lightTerminalTheme = {
    background: '#ffffff',
    foreground: '#000000',
    cursor: '#000000',
    black: '#000000',
    red: '#ff3b30',
    green: '#34c759',
    yellow: '#ffcc00',
    blue: '#007aff',
    magenta: '#af52de',
    cyan: '#55bef0',
    white: '#ffffff'
};

const darkTerminalTheme = {
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
};

// 2. Terminal Initialization
function initTerminal() {
    const isLightTheme = document.body.classList.contains('light-theme');
    term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'SFMono-Regular, Consolas, Courier, monospace',
        theme: isLightTheme ? lightTerminalTheme : darkTerminalTheme,
        convertEol: true
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(terminalContainer);
    fitAddon.fit();
    terminalContainer.addEventListener('paste', handleTerminalPaste, true);

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

function handleTerminalPaste(e) {
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text) return;

    e.preventDefault();
    e.stopPropagation();
    pasteTextToTerminal(text);
}

async function pasteClipboardToTerminal() {
    try {
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
            pasteTextToTerminal(lastCopiedCodeBlockText);
            return;
        }

        const text = await navigator.clipboard.readText();
        pasteTextToTerminal(text || lastCopiedCodeBlockText);
    } catch (e) {
        console.error('Unable to read clipboard for terminal paste:', e);
        pasteTextToTerminal(lastCopiedCodeBlockText);
    }
}

function pasteTextToTerminal(text) {
    if (!text) return;
    term.focus();
    sendTerminalData(text);
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
            } else if (action === 'Paste') {
                pasteClipboardToTerminal();
            } else if (action === 'Clear') {
                term.clear();
            }
            if (action !== 'Paste') {
                term.focus();
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
                html += `<option value="${escapeHtml(path)}" label="${escapeHtml(folderName)}"></option>`;
            });
            workspaceRecentOptions.innerHTML = html;
            if (activeWorkspacePath) {
                workspaceRecentSelect.value = activeWorkspacePath;
            }
        }
    } catch (e) {
        console.error('Error loading recent workspaces:', e);
        workspaceRecentOptions.innerHTML = '';
    }
}

async function selectWorkspacePath(path) {
    const selectedPath = String(path || '').trim();
    if (!selectedPath) return;
    if (pendingWorkspacePath === selectedPath) return;

    pendingWorkspacePath = selectedPath;
    workspaceRecentSelect.disabled = true;

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
        } else {
            alert(data.message || 'Failed to select workspace.');
            workspaceRecentSelect.value = activeWorkspacePath;
        }
    } catch (e) {
        console.error(e);
        alert('Failed to select workspace.');
        workspaceRecentSelect.value = activeWorkspacePath;
    } finally {
        pendingWorkspacePath = '';
        workspaceRecentSelect.disabled = false;
    }
}

function isRecentWorkspacePath(path) {
    const selectedPath = String(path || '').trim();
    if (!selectedPath) return false;
    return Array.from(workspaceRecentOptions.options).some(option => option.value === selectedPath);
}

async function initWorkspaceSelector() {
    // Load current active workspace on page load
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

    // Load recent workspaces list
    await loadRecentWorkspaces();

    // Load initial state
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

    // Handle refresh buttons
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

    // 5. New Chat listener
    newChatBtn.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/conversation/new', { method: 'POST' });
            const data = await res.json();
            if (data.status === 'success' && data.conversation_id) {
                // Reload conversations list
                await loadConversations();
                
                // Select the new conversation
                conversationSelect.value = data.conversation_id;
                activeConversationId = data.conversation_id;
                
                // Load its empty transcript and artifacts
                await loadConversationTranscript(data.conversation_id, true);
                await loadConversationArtifacts(data.conversation_id);
            } else {
                alert(data.message || 'Failed to start a new chat.');
            }
        } catch (e) {
            console.error(e);
            alert('Error starting a new chat.');
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
                const renderedContent = renderMarkdownText(m.content);
                html += `
                    <div class="chat-bubble ${isUser ? 'user' : 'assistant'}">
                        <div class="chat-meta">${isUser ? 'USER' : 'ANTIGRAVITY'} - ${timeStr}</div>
                        <div class="markdown-body">${renderedContent}</div>
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


async function loadConversationArtifacts(id) {
    artifactsListDisplay.innerHTML = '<li class="idle-state">Loading artifacts...</li>';
    try {
        const res = await fetch(`/api/conversation/${encodeURIComponent(id)}/artifacts`);
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
    if (toggleArtifactsBtn && artifactsListPanel && conversationArtifactsSection) {
        setArtifactsCollapsed(true);
        toggleArtifactsBtn.addEventListener('click', () => {
            setArtifactsCollapsed(!conversationArtifactsSection.classList.contains('collapsed'));
        });
    }

    artifactCloseBtn.addEventListener('click', () => {
        artifactViewerOverlay.classList.remove('active');
        currentArtifactName = '';
        currentArtifactLines = [];
    });
}

function setArtifactsCollapsed(collapsed) {
    conversationArtifactsSection.classList.toggle('collapsed', collapsed);
    artifactsListPanel.hidden = collapsed;
    toggleArtifactsBtn.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Show artifacts' : 'Hide artifacts';
    toggleArtifactsBtn.innerHTML = collapsed ? artifactToggleIcons.show : artifactToggleIcons.hide;
    toggleArtifactsBtn.setAttribute('aria-label', label);
    toggleArtifactsBtn.setAttribute('title', label);
}

async function openArtifactViewer(name) {
    currentArtifactName = name;
    artifactFilename.textContent = name;
    artifactRenderedContent.innerHTML = '<div class="idle-state">Loading document...</div>';
    artifactViewerOverlay.classList.add('active');
    
    try {
        const res = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/artifact/${encodeURIComponent(name)}`);
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
    const taskLines = [];
    const processedLines = currentArtifactLines.map((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]') || trimmed.startsWith('- [/]')) {
            taskLines.push({
                lineIndex: index,
                isInProgress: trimmed.startsWith('- [/]')
            });
            if (trimmed.startsWith('- [/]')) {
                return line.replace('- [/]', '- [ ]');
            }
        }
        return line;
    });

    const markdownText = processedLines.join('\n');
    const renderedHtml = renderMarkdownText(markdownText);
    
    artifactRenderedContent.innerHTML = `<div class="markdown-body">${renderedHtml}</div>`;
    
    const checkboxes = artifactRenderedContent.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((checkbox, idx) => {
        if (idx < taskLines.length) {
            const { lineIndex, isInProgress } = taskLines[idx];
            
            checkbox.removeAttribute('disabled');
            checkbox.classList.add('task-list-item-checkbox');
            checkbox.setAttribute('data-line-index', lineIndex);
            
            checkbox.addEventListener('change', function() {
                toggleTaskCheckbox(this);
            });
            
            const li = checkbox.parentElement;
            if (li) {
                li.classList.add('task-list-item');
                if (isInProgress) {
                    li.classList.add('in-progress');
                    const badge = document.createElement('span');
                    badge.className = 'task-progress-badge';
                    badge.innerHTML = '[/] In Progress';
                    li.appendChild(badge);
                }
            }
        }
    });
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
        const res = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/artifact/${encodeURIComponent(currentArtifactName)}/save`, {
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

// Theme management
function initTheme() {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (!themeToggleBtn) return;
    
    // Check saved theme or system preference
    const savedTheme = localStorage.getItem('theme');
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    
    const isLight = savedTheme === 'light' || (!savedTheme && prefersLight);
    
    if (isLight) {
        document.body.classList.add('light-theme');
        themeToggleBtn.textContent = 'Dark Mode';
        updateHljsTheme(true);
    } else {
        document.body.classList.remove('light-theme');
        themeToggleBtn.textContent = 'Light Mode';
        updateHljsTheme(false);
    }
    
    themeToggleBtn.addEventListener('click', () => {
        const currentlyLight = document.body.classList.toggle('light-theme');
        localStorage.setItem('theme', currentlyLight ? 'light' : 'dark');
        themeToggleBtn.textContent = currentlyLight ? 'Dark Mode' : 'Light Mode';
        
        // Update highlight.js theme stylesheet
        updateHljsTheme(currentlyLight);
        
        // Update xterm terminal options theme
        if (term) {
            term.options.theme = currentlyLight ? lightTerminalTheme : darkTerminalTheme;
        }
    });
}

function updateHljsTheme(isLight) {
    const hljsThemeLink = document.getElementById('hljs-theme-stylesheet');
    if (hljsThemeLink) {
        if (isLight) {
            hljsThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
        } else {
            hljsThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
        }
    }
}
