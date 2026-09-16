/**
 * RTwhat's up - Outside Client Helpdesk Controller
 * Connects outside clients directly with RegiusTax Calling Team & Admin
 */

class ClientPortal {
  constructor() {
    this.clientUser = null;
    this.channel = null;
    this.socket = null;
    this.messages = [];

    this.init();
  }

  async init() {
    this.setupEventListeners();

    // Check if client has existing session saved in localStorage
    const savedSession = localStorage.getItem('rtwhatsup_client_session');
    if (savedSession) {
      try {
        const parsed = JSON.parse(savedSession);
        if (parsed.name && parsed.phone) {
          await this.startSession(parsed.name, parsed.phone, parsed.email, null, false);
          return;
        }
      } catch (e) {
        localStorage.removeItem('rtwhatsup_client_session');
      }
    }

    // Auto-quick start if ?quick=1 in URL
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('quick') === '1' || urlParams.get('direct') === '1') {
      await this.startQuickSession();
    }
  }

  async startQuickSession() {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const guestName = `Taxpayer Guest #${randomSuffix}`;
    const guestPhone = `98${Math.floor(10000000 + Math.random() * 90000000)}`;
    await this.startSession(guestName, guestPhone, '', 'Hello, I have an inquiry about my taxes.', true);
  }

  setupEventListeners() {
    const quickStartBtn = document.getElementById('btn-client-quick-start');
    if (quickStartBtn) {
      quickStartBtn.addEventListener('click', async () => {
        await this.startQuickSession();
      });
    }

    const formInit = document.getElementById('form-client-init');
    formInit.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('client-input-name').value.trim();
      const phone = document.getElementById('client-input-phone').value.trim();
      const email = document.getElementById('client-input-email').value.trim();
      const initialMsg = document.getElementById('client-input-msg').value.trim();

      await this.startSession(name, phone, email, initialMsg, true);
    });

    // Send button
    document.getElementById('btn-client-send-msg').addEventListener('click', () => {
      this.sendClientMessage();
    });

    // Enter key in textarea
    const textarea = document.getElementById('client-text-input');
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendClientMessage();
      }
    });

    // File upload
    const fileBtn = document.getElementById('btn-client-file');
    const fileInput = document.getElementById('client-file-input');
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.uploadClientFile(file);
      fileInput.value = '';
    });

    // Reset session button
    document.getElementById('btn-client-reset').addEventListener('click', () => {
      if (confirm('Start a fresh client inquiry session?')) {
        localStorage.removeItem('rtwhatsup_client_session');
        window.location.reload();
      }
    });
  }

  async startSession(name, phone, email, initialMsg = null, isNew = false) {
    try {
      const res = await fetch('/api/client/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, email })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start session');

      this.clientUser = data.user;
      this.channel = data.channel;
      this.messages = data.messages || [];

      // Save session
      localStorage.setItem('rtwhatsup_client_session', JSON.stringify({ name, phone, email }));

      // Switch screens
      document.getElementById('screen-client-form').style.display = 'none';
      document.getElementById('screen-client-chat').style.display = 'flex';

      // Connect socket
      this.initSocket();

      // Render existing chat history
      this.renderMessages();

      // If there was an initial message typed on the form, send it now
      if (isNew && initialMsg) {
        this.sendDirectMessage(initialMsg);
      }
    } catch (err) {
      alert('Error starting client chat: ' + err.message);
    }
  }

  initSocket() {
    if (this.socket) return;
    this.socket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });

    this.socket.on('connect', async () => {
      console.log('[Client Socket] Connected to RegiusTax server');
      this.socket.emit('user:join', { userId: this.clientUser.id });
      this.socket.emit('channel:join', { channelId: this.channel.id });
      // Sync messages on connect/reconnect so client never misses replies from Calling Team
      await this.syncMessages();
    });

    // Auto-reconnect on online and focus
    window.addEventListener('online', () => {
      if (this.socket && !this.socket.connected) this.socket.connect();
    });
    window.addEventListener('focus', () => {
      if (this.socket && !this.socket.connected) this.socket.connect();
    });

    this.socket.on('message:received', (msg) => {
      if (msg.channel_id === this.channel.id) {
        if (!this.messages.some(m => m.id === msg.id)) {
          this.messages.push(msg);
          this.renderMessages();
        }
      }
    });

    this.socket.on('typing:status', (data) => {
      if (data.channelId === this.channel.id && data.userId !== this.clientUser.id) {
        const indicator = document.getElementById('client-typing-indicator');
        if (data.isTyping) {
          indicator.innerText = `${data.userName || 'RegiusTax Team'} is typing...`;
          indicator.style.display = 'block';
        } else {
          indicator.style.display = 'none';
        }
      }
    });
  }

  async syncMessages() {
    if (!this.channel) return;
    try {
      const res = await fetch(`/api/channels/${this.channel.id}/messages`);
      if (res.ok) {
        this.messages = await res.json();
        this.renderMessages();
      }
    } catch (e) {
      console.warn('Could not sync client messages:', e);
    }
  }

  renderMessages() {
    const container = document.getElementById('client-messages');
    if (!container) return;

    if (this.messages.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:30px 10px; color:#54656f; font-size:13px;">
          Welcome <strong>${this.escapeHtml(this.clientUser.full_name)}</strong>!<br>
          Our Calling & Tax Advisory Team is ready to assist you. Ask any tax question or share documents below.
        </div>
      `;
      return;
    }

    container.innerHTML = this.messages.map(m => {
      const isMe = m.sender_id === this.clientUser.id;
      const bubbleClass = isMe ? 'msg-client' : 'msg-staff';
      const senderTag = !isMe
        ? `<div class="msg-sender-tag"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:middle; margin-right:4px;"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>${this.escapeHtml(m.sender_name || 'RegiusTax Specialist')} (${this.escapeHtml(m.sender_department || 'Calling Team')})</div>`
        : '';

      let fileSnippet = '';
      if (m.file_url) {
        const isImage = (m.type === 'image' || /\.(jpg|jpeg|png|gif|webp)$/i.test(m.file_name || m.file_url));
        if (isImage) {
          fileSnippet = `<div style="margin-top:6px;"><img src="${m.file_url}" style="max-width:100%; border-radius:6px; max-height:220px;" alt="attachment"></div>`;
        } else {
          fileSnippet = `
            <div class="client-attachment-pill">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
              <a href="${m.file_url}" target="_blank" download>${this.escapeHtml(m.file_name || 'Document')}</a>
            </div>
          `;
        }
      }

      const timeStr = this.formatTime(m.created_at);

      return `
        <div class="${bubbleClass}">
          ${senderTag}
          <div>${this.escapeHtml(m.text || '')}</div>
          ${fileSnippet}
          <div class="msg-meta">
            <span>${timeStr}</span>
            ${isMe ? '<span style="color:#53bdeb; font-size:12px;">✓✓</span>' : ''}
          </div>
        </div>
      `;
    }).join('');

    container.scrollTop = container.scrollHeight;
  }

  async sendClientMessage() {
    const input = document.getElementById('client-text-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    try {
      await this.sendDirectMessage(text);
      input.focus();
    } catch (err) {
      console.error('[Client] Failed to send message:', err);
      input.value = text;
      alert('Could not deliver message. Please check your network connection.');
    }
  }

  async sendDirectMessage(text, fileUrl = null, fileName = null, fileSize = null, type = 'text') {
    if (!this.channel || !this.clientUser) return;

    const payload = {
      channelId: this.channel.id,
      senderId: this.clientUser.id,
      text: text,
      type: type,
      fileUrl: fileUrl,
      fileName: fileName,
      fileSize: fileSize
    };

    if (this.socket && this.socket.connected) {
      try {
        this.socket.emit('message:send', payload);
        return;
      } catch (err) {
        console.warn('[Client] Socket emit failed, using HTTP fallback', err);
      }
    }

    // HTTP Fallback
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');
      if (!this.messages.find(m => m.id === data.id)) {
        this.messages.push(data);
        this.renderMessages();
      }
    } catch (err) {
      console.error('[Client] Fallback send failed:', err);
      throw err;
    }
  }

  async uploadClientFile(file) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('channelId', this.channel.id);
      formData.append('userId', this.clientUser.id);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      let type = 'file';
      if (file.type.startsWith('image/')) type = 'image';
      else if (file.type.startsWith('audio/')) type = 'audio';
      else if (file.type.startsWith('video/')) type = 'video';

      this.sendDirectMessage(
        `Shared file: ${file.name}`,
        data.fileUrl,
        data.fileName,
        data.fileSize,
        type
      );
    } catch (err) {
      alert('Error uploading file: ' + err.message);
    }
  }

  formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

window.clientPortal = new ClientPortal();