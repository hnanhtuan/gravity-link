// Conversation history, agent messaging, and artifact checklist viewer
import { escapeHtml, escapeQuotes, formatBytes, showToast } from './api.js';

export let activeConversationId = '';
export let currentArtifactName = '';
export let currentArtifactLines = [];
export let lastCopiedCodeBlockText = '';

// DOM Elements
const conversationSelect = document.getElementById('conversation-select');
const transcriptChatDisplay = document.getElementById('transcript-chat-display');
const refreshTranscriptBtn = document.getElementById('refresh-transcript-btn');
const chatMessageInput = document.getElementById('chat-message-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const newChatBtn = document.getElementById('new-chat-btn');

const conversationArtifactsSection = document.getElementById('conversation-artifacts-section');
const artifactsListPanel = document.getElementById('artifacts-list-panel');
const toggleArtifactsBtn = document.getElementById('toggle-artifacts-btn');
const artifactsListDisplay = document.getElementById('artifacts-list-display');
const refreshArtifactsBtn = document.getElementById('refresh-artifacts-btn');

const artifactViewerOverlay = document.getElementById('artifact-viewer-overlay');
const artifactFilename = document.getElementById('artifact-filename');
const artifactRenderedContent = document.getElementById('artifact-rendered-content');
const artifactCloseBtn = document.getElementById('artifact-close-btn');

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

export function getActiveConversationId() {
    return activeConversationId;
}

export function getLastCopiedText() {
    return lastCopiedCodeBlockText;
}

// Configure Marked & Highlight.js Markdown rendering
export function configureMarkdownRenderer() {
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
                                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2-2v8a2 2 0 0 0 2 2h2"></path>
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

export function renderMarkdownText(markdownText) {
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

// Code Copy Operations
export function initMarkdownCodeCopy() {
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

    document.addEventListener('copy', () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const anchor = selection.anchorNode && selection.anchorNode.nodeType === Node.TEXT_NODE
            ? selection.anchorNode.parentElement
            : selection.anchorNode;
        const codeBlock = anchor instanceof Element ? anchor.closest('.code-block-wrapper') : null;
        if (!codeBlock) return;

        lastCopiedCodeBlockText = selection.toString() || codeBlock.querySelector('pre code')?.textContent || '';
    });
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
        lastCopiedCodeBlockText = text;
        showCopyButtonStatus(button, 'Copied');
    } catch (e) {
        console.error('Unable to copy code block:', e);
        showCopyButtonStatus(button, 'Failed');
    }
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

// Conversation Messaging control
export async function sendChatMessage() {
    if (!chatMessageInput) return;
    const message = chatMessageInput.value.trim();
    if (!message || !activeConversationId) return;
    
    chatMessageInput.value = '';
    chatMessageInput.disabled = true;
    if (chatSendBtn) {
        chatSendBtn.disabled = true;
        chatSendBtn.textContent = '...';
    }
    
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
            showToast(data.message || 'Failed to send message.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Error sending message.', 'error');
    } finally {
        chatMessageInput.disabled = false;
        if (chatSendBtn) {
            chatSendBtn.disabled = false;
            chatSendBtn.textContent = 'Send';
        }
        chatMessageInput.focus();
    }
}

export async function initConversationTab() {
    await loadConversations();
    
    if (conversationSelect) {
        conversationSelect.addEventListener('change', () => {
            const id = conversationSelect.value;
            if (id) {
                activeConversationId = id;
                loadConversationTranscript(id, true);
                loadConversationArtifacts(id);
            }
        });
    }
    
    if (refreshTranscriptBtn) {
        refreshTranscriptBtn.addEventListener('click', () => {
            if (activeConversationId) loadConversationTranscript(activeConversationId, false);
        });
    }

    if (refreshArtifactsBtn) {
        refreshArtifactsBtn.addEventListener('click', () => {
            if (activeConversationId) loadConversationArtifacts(activeConversationId);
        });
    }
    
    if (chatSendBtn) chatSendBtn.addEventListener('click', sendChatMessage);
    if (chatMessageInput) {
        chatMessageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    // Action chips helper strings
    document.querySelectorAll('.action-chip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-action');
            if (action && chatMessageInput) {
                chatMessageInput.value = action;
                chatMessageInput.focus();
                const len = chatMessageInput.value.length;
                chatMessageInput.setSelectionRange(len, len);
            }
        });
    });

    if (newChatBtn) {
        newChatBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/conversation/new', { method: 'POST' });
                const data = await res.json();
                if (data.status === 'success' && data.conversation_id) {
                    await loadConversations();
                    
                    if (conversationSelect) {
                        conversationSelect.value = data.conversation_id;
                    }
                    activeConversationId = data.conversation_id;
                    
                    await loadConversationTranscript(data.conversation_id, true);
                    await loadConversationArtifacts(data.conversation_id);
                } else {
                    showToast(data.message || 'Failed to start a new chat.', 'error');
                }
            } catch (e) {
                console.error(e);
                showToast('Error starting a new chat.', 'error');
            }
        });
    }
}

export async function loadConversations() {
    if (!conversationSelect) return;
    try {
        const res = await fetch('/api/conversations');
        const data = await res.json();
        if (data.status === 'success' && data.conversations) {
            let html = '';
            data.conversations.forEach((c) => {
                html += `<option value="${c.id}">${escapeHtml(c.title)} (${c.id.slice(0, 8)})</option>`;
            });
            conversationSelect.innerHTML = html || '<option value="">No active conversations</option>';
            
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

export async function loadConversationTranscript(id, forceScroll = false) {
    if (!transcriptChatDisplay) return;
    const isFirstLoad = forceScroll || (transcriptChatDisplay.innerHTML.includes('No messages') || transcriptChatDisplay.innerHTML.includes('Loading chat history'));
    
    if (isFirstLoad) {
        transcriptChatDisplay.innerHTML = '<div class="idle-state">Loading chat history...</div>';
    }
    
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

export async function loadConversationArtifacts(id) {
    if (!artifactsListDisplay) return;
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
            data.artifacts.forEach((art, idx) => {
                html += `
                    <li class="file-item" id="artifact-item-list-${idx}">
                        <div class="file-info">
                            <span class="file-icon file">DOC</span>
                            <span class="file-name">${escapeHtml(art.name)}</span>
                        </div>
                        <span class="file-size">${formatBytes(art.size)}</span>
                    </li>
                `;
            });
            artifactsListDisplay.innerHTML = html;

            // Bind artifact click actions
            data.artifacts.forEach((art, idx) => {
                const el = document.getElementById(`artifact-item-list-${idx}`);
                if (el) {
                    el.onclick = () => openArtifactViewer(art.name);
                }
            });
        } else {
            artifactsListDisplay.innerHTML = `<li class="idle-state" style="color: #ff3b30;">Error: ${data.message}</li>`;
        }
    } catch (e) {
        console.error(e);
        artifactsListDisplay.innerHTML = '<li class="idle-state" style="color: #ff3b30;">Failed to load artifacts.</li>';
    }
}

export function initArtifactViewer() {
    if (toggleArtifactsBtn && artifactsListPanel && conversationArtifactsSection) {
        setArtifactsCollapsed(true);
        toggleArtifactsBtn.onclick = () => {
            setArtifactsCollapsed(!conversationArtifactsSection.classList.contains('collapsed'));
        };
    }

    if (artifactCloseBtn) {
        artifactCloseBtn.onclick = () => {
            if (artifactViewerOverlay) artifactViewerOverlay.classList.remove('active');
            currentArtifactName = '';
            currentArtifactLines = [];
        };
    }
}

export function setArtifactsCollapsed(collapsed) {
    if (!conversationArtifactsSection || !artifactsListPanel || !toggleArtifactsBtn) return;
    conversationArtifactsSection.classList.toggle('collapsed', collapsed);
    artifactsListPanel.hidden = collapsed;
    toggleArtifactsBtn.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Show artifacts' : 'Hide artifacts';
    toggleArtifactsBtn.innerHTML = collapsed ? artifactToggleIcons.show : artifactToggleIcons.hide;
    toggleArtifactsBtn.setAttribute('aria-label', label);
    toggleArtifactsBtn.setAttribute('title', label);
}

export async function openArtifactViewer(name) {
    currentArtifactName = name;
    if (artifactFilename) artifactFilename.textContent = name;
    if (artifactRenderedContent) artifactRenderedContent.innerHTML = '<div class="idle-state">Loading document...</div>';
    if (artifactViewerOverlay) artifactViewerOverlay.classList.add('active');
    
    try {
        const res = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/artifact/${encodeURIComponent(name)}`);
        const data = await res.json();
        if (data.status === 'success') {
            currentArtifactLines = data.content.split('\n');
            renderArtifactHtml();
        } else {
            if (artifactRenderedContent) artifactRenderedContent.innerHTML = `<div class="idle-state" style="color: #ff3b30;">Error: ${data.message}</div>`;
        }
    } catch (e) {
        console.error(e);
        if (artifactRenderedContent) artifactRenderedContent.innerHTML = '<div class="idle-state" style="color: #ff3b30;">Failed to load document content.</div>';
    }
}

function renderArtifactHtml() {
    if (!artifactRenderedContent) return;
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

export async function toggleTaskCheckbox(checkbox) {
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
            showToast(data.message || 'Failed to save task update.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Error saving task checklist update.', 'error');
    }
}
