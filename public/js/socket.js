/**
 * RTwhat's up - Socket.IO Client Real-Time Service
 */

class SocketService {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.currentChannelId = null;
    this.typingTimeout = null;
  }

  init(userId) {
    if (this.socket) {
      this.socket.disconnect();
    }

    this.socket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });

    this.socket.on('connect', () => {
      console.log('[Socket] Connected to RTwhat\'s up server, ID:', this.socket.id);
      this.connected = true;
      if (window.appController && window.appController.updateConnectionStatus) {
        window.appController.updateConnectionStatus(true);
      }
      this.socket.emit('user:join', { userId });

      if (this.currentChannelId) {
        this.socket.emit('channel:join', { channelId: this.currentChannelId });
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected from server, reason:', reason);
      this.connected = false;
      if (window.appController && window.appController.updateConnectionStatus) {
        window.appController.updateConnectionStatus(false);
      }
    });

    // Auto-reconnect when device comes online or tab gains focus
    if (!this._windowListenersAttached) {
      this._windowListenersAttached = true;
      window.addEventListener('online', () => {
        if (this.socket && !this.connected) {
          console.log('[Socket] Device back online, forcing reconnect...');
          this.socket.connect();
        }
      });
      window.addEventListener('focus', () => {
        if (this.socket && !this.connected) {
          this.socket.connect();
        }
      });
    }

    // Real-time message in current active channel
    this.socket.on('message:received', (message) => {
      if (window.appController) {
        window.appController.handleIncomingMessage(message);
      }
    });

    // Notification of message in any channel for sidebar badge updates
    this.socket.on('channel:message_notice', (data) => {
      if (window.appController) {
        window.appController.handleChannelNotice(data);
      }
    });

    // User presence updates (online/offline)
    this.socket.on('user:presence', (data) => {
      if (window.appController) {
        window.appController.handlePresenceUpdate(data);
      }
    });

    // User status text update
    this.socket.on('user:status_updated', (data) => {
      if (window.appController) {
        window.appController.handleStatusUpdate(data);
      }
    });

    // Typing notification
    this.socket.on('typing:status', (data) => {
      if (window.appController) {
        window.appController.handleTypingStatus(data);
      }
    });

    // Read receipt updates
    this.socket.on('messages:read', (data) => {
      if (window.appController) {
        window.appController.handleMessagesRead(data);
      }
    });

    // New channel created
    this.socket.on('channel:created', (channel) => {
      if (window.appController) {
        window.appController.loadChannels();
      }
    });

    // Employee added by Admin
    this.socket.on('employee:added', (newEmp) => {
      if (window.appController) {
        window.appController.handleEmployeeAdded(newEmp);
      }
    });

    // Employee deleted by Admin
    this.socket.on('employee:deleted', (data) => {
      if (window.appController) {
        window.appController.handleEmployeeDeleted(data.employeeId);
      }
    });

    // Channel deleted by Admin
    this.socket.on('channel:deleted', (data) => {
      if (window.appController) {
        window.appController.handleChannelDeleted(data.channelId);
      }
    });

    // All messages cleared (clean slate for Go-Live)
    this.socket.on('channel:cleared', () => {
      if (window.appController) {
        window.appController.loadChannels();
        if (window.appController.activeChannel) {
          window.appController.loadMessages(window.appController.activeChannel.id);
        }
      }
    });

    // Channel members updated by Admin (dividing employees into groups)
    this.socket.on('channel:members_updated', (data) => {
      if (window.appController) {
        window.appController.loadChannels();
        if (window.appController.activeChannel && window.appController.activeChannel.id === data.channelId) {
          window.appController.renderChannelDetailsModal(data.channelId);
        }
      }
    });

    // New department added by Admin
    this.socket.on('department:added', (newDept) => {
      if (window.appController) {
        window.appController.handleDepartmentAdded(newDept);
      }
    });

    // Department deleted by Admin
    this.socket.on('department:deleted', (data) => {
      if (window.appController) {
        window.appController.handleDepartmentDeleted(data);
      }
    });

    // Employee department updated by Admin
    this.socket.on('employee:department_updated', (updatedUser) => {
      if (window.appController) {
        window.appController.handleEmployeeUpdated(updatedUser);
      }
    });

    // Work Assistance Tracker live events
    this.socket.on('tracker:request_created', (req) => {
      if (window.appController) {
        window.appController.handleTrackerRequestCreated(req);
      }
    });

    this.socket.on('tracker:request_updated', (req) => {
      if (window.appController) {
        window.appController.handleTrackerRequestUpdated(req);
      }
    });

    this.socket.on('tracker:request_closed', (req) => {
      if (window.appController) {
        window.appController.handleTrackerRequestClosed(req);
      }
    });

    this.socket.on('tracker:cleared', () => {
      if (window.appController) {
        window.appController.loadWorkTracker();
      }
    });

    // Backup completed event
    this.socket.on('backup:completed', (manifest) => {
      if (window.appController && typeof window.appController.handleBackupCompleted === 'function') {
        window.appController.handleBackupCompleted(manifest);
      }
    });
  }

  switchChannel(channelId) {
    if (this.currentChannelId && this.socket) {
      this.socket.emit('channel:leave', { channelId: this.currentChannelId });
    }
    this.currentChannelId = channelId;
    if (channelId && this.socket && this.connected) {
      this.socket.emit('channel:join', { channelId });
    }
  }

  async sendMessage(data) {
    // If socket is online, emit via real-time WebSocket
    if (this.socket && this.connected) {
      try {
        this.socket.emit('message:send', data);
        return { success: true, via: 'socket' };
      } catch (err) {
        console.warn('[Socket] Emit failed, trying HTTP fallback...', err);
      }
    }

    // Instant HTTP REST Fallback (reliable delivery even if socket is reconnecting or asleep)
    try {
      console.log('[Socket] Sending message via HTTP fallback endpoint...');
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const saved = await res.json();
      if (!res.ok) throw new Error(saved.error || 'HTTP send failed');
      return { success: true, via: 'http', message: saved };
    } catch (httpErr) {
      console.error('[Socket] Both WebSocket and HTTP delivery failed:', httpErr);
      throw httpErr;
    }
  }

  sendTypingStart(channelId, user) {
    if (!this.socket || !this.connected) return;
    this.socket.emit('typing:start', {
      channelId,
      userId: user.id,
      userName: user.full_name
    });
  }

  sendTypingStop(channelId, userId) {
    if (!this.socket || !this.connected) return;
    this.socket.emit('typing:stop', {
      channelId,
      userId
    });
  }
}

window.socketService = new SocketService();
