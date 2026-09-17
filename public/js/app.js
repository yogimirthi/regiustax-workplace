/**
 * RTwhat's up - Main Client Application Controller
 * Handles UI interactions, WhatsApp styling logic, file uploads, and state management.
 */

class AppController {
  constructor() {
    this.currentUser = null;
    this.activeChannel = null;
    this.channels = [];
    this.users = [];
    this.currentFilter = 'all';
    this.serverInfo = null;
    this.typingTimeout = null;
    this.currentPlayingAudio = null;
    this.departments = [];
    this.workRequests = [];
    this.trackerStats = { total: 0, urgent: 0, inProgress: 0, waiting: 0, completed: 0, closed: 0 };
    this.trackerFilterStatus = 'All';
    this.trackerFilterTeam = 'All';
    this.trackerFilterPriority = 'All';
    this.trackerSearch = '';
    this.currentReplyTo = null;
    this.currentChannelMessages = [];

    this.init();
  }

  initPortalMode() {
    const state = window.__PRELOADED_STATE__ || {};
    const path = window.location.pathname.toLowerCase();
    const urlParams = new URLSearchParams(window.location.search);
    if (state.portalMode) {
      this.portalMode = state.portalMode;
    } else if (path.startsWith('/admin') || urlParams.get('portal') === 'admin') {
      this.portalMode = 'admin';
    } else if (path.startsWith('/employee') || urlParams.get('portal') === 'employee') {
      this.portalMode = 'employee';
    } else {
      this.portalMode = 'admin';
    }
  }

  async init() {
    this.initTheme();
    this.initPortalMode();

    if (window.__PRELOADED_STATE__) {
      const state = window.__PRELOADED_STATE__;
      this.serverInfo = state.serverInfo;
      this.updateServerInfoUI();
      this.users = state.users;
      this.departments = state.departments || [];
      if (state.channels && state.channels.length > 0) {
        this.channels = state.channels;
        this.renderChatList();
      }
    } else {
      await this.fetchServerInfo();
      await this.fetchUsers();
      await this.fetchDepartments();
    }

    this.setupEventListeners();
    this.loadWorkTrackerStats();

    const isAuthenticated = this.initCurrentUser();
    if (isAuthenticated) {
      if (!this.channels || this.channels.length === 0) {
        await this.loadChannels();
      }
      if (this.channels && this.channels.length > 0 && window.innerWidth > 900) {
        const urlParams = new URLSearchParams(window.location.search);
        if (!urlParams.has('welcome')) {
          const firstChan = this.channels[0];
          const state = window.__PRELOADED_STATE__;
          if (state && state.initialMessages && state.channels && state.channels[0]?.id === firstChan.id) {
            this.activeChannel = firstChan;
            this.messages = state.initialMessages;
            this.renderActiveChannelUI();
          } else {
            this.selectChannel(firstChan.id);
          }
        }
      }
    } else {
      // Find candidate email to prefill if user clicked a department or link
      let prefillEmail = '';
      const urlParams = new URLSearchParams(window.location.search);
      const deptParam = urlParams.get('dept');
      const userParam = urlParams.get('user') || urlParams.get('userId') || urlParams.get('email');
      if (this.portalMode === 'admin') {
        prefillEmail = 'admin@regiustax.com';
      } else if (userParam) {
        const target = this.users.find(u => (u.id === userParam || u.email.toLowerCase() === userParam.toLowerCase()) && u.role === 'Employee');
        if (target) prefillEmail = target.email;
      } else if (deptParam) {
        const target = this.users.find(u => u.role === 'Employee' && (u.department || '').toLowerCase().includes(deptParam.toLowerCase()));
        if (target) prefillEmail = target.email;
      } else {
        const firstEmp = this.users.find(u => u.role === 'Employee');
        if (firstEmp) prefillEmail = firstEmp.email;
      }

      this.showAuthLoginModal(prefillEmail);
    }

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('modal') && this.currentUser) {
      const modalId = urlParams.get('modal');
      const tab = urlParams.get('tab');
      this.openModal(modalId);
      if (modalId === 'modal-profiles' && tab) {
        this.renderStaffModal(tab);
      }
    }
  }

  async fetchDepartments() {
    try {
      const res = await fetch('/api/departments');
      this.departments = await res.json();
    } catch (err) {
      console.error('Error fetching departments:', err);
    }
  }

  getUserAvatarHtml(user, size = 20) {
    if (!user) {
      return `<div class="avatar-circle avatar-circle-user"><svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>`;
    }
    if (user.avatar && (user.avatar.startsWith('http') || user.avatar.startsWith('/') || user.avatar.startsWith('data:'))) {
      return `<div class="avatar-circle"><img src="${user.avatar}" alt="${this.escapeHtml(user.full_name || 'User')}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;"></div>`;
    }
    const isAdmin = user.role === 'Admin' || (user.email && user.email.toLowerCase().includes('admin'));
    if (isAdmin) {
      return `<div class="avatar-circle avatar-circle-admin"><svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg></div>`;
    }
    return `<div class="avatar-circle avatar-circle-user"><svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>`;
  }

  getChannelAvatarHtml(channel, size = 20) {
    if (!channel) return '';
    if (channel.is_direct) {
      return this.getUserAvatarHtml(channel.direct_user, size);
    }
    return `<div class="avatar-circle avatar-circle-group"><svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></div>`;
  }

  getFileIconSvg(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="10" y1="9" x2="10" y2="21"/></svg>`;
    } else if (ext === 'pdf') {
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><rect x="8" y="12" width="8" height="6" rx="1"/></svg>`;
    } else if (['docx', 'doc'].includes(ext)) {
      return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
  }

  // Dark / Light Mode Preference
  initTheme() {
    const savedTheme = localStorage.getItem('rtwhatsup_theme') || 'light';
    if (savedTheme === 'dark') {
      document.body.classList.add('theme-dark');
    } else {
      document.body.classList.remove('theme-dark');
    }
  }

  toggleTheme() {
    const isDark = document.body.classList.toggle('theme-dark');
    localStorage.setItem('rtwhatsup_theme', isDark ? 'dark' : 'light');
    const mobileThemeLabel = document.getElementById('mobile-theme-label');
    const mobileThemeIcon = document.getElementById('mobile-theme-icon');
    const sunSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg>';
    const moonSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>';
    if (mobileThemeLabel) mobileThemeLabel.innerText = isDark ? 'Light Mode' : 'Dark Mode';
    if (mobileThemeIcon) mobileThemeIcon.innerHTML = isDark ? sunSvg : moonSvg;
  }

  updateServerInfoUI() {
    if (!this.serverInfo) return;
    const ipDisplay = document.getElementById('network-ip-display');
    if (ipDisplay) ipDisplay.innerText = `LAN: ${this.serverInfo.networkUrl}`;
    const welcomeUrl = document.getElementById('welcome-network-url');
    if (welcomeUrl) welcomeUrl.innerText = this.serverInfo.networkUrl;
    const modalLanUrl = document.getElementById('modal-lan-url');
    if (modalLanUrl) modalLanUrl.value = this.serverInfo.networkUrl;
    const modalQr = document.getElementById('modal-qr-image');
    if (modalQr && this.serverInfo.qrCode) modalQr.src = this.serverInfo.qrCode;
  }

  // Fetch Server details and LAN IP
  async fetchServerInfo() {
    try {
      const res = await fetch('/api/info');
      this.serverInfo = await res.json();
      this.updateServerInfoUI();
    } catch (err) {
      console.error('Error fetching server info:', err);
    }
  }

  // Fetch all staff users
  async fetchUsers() {
    try {
      const res = await fetch('/api/users');
      this.users = await res.json();
    } catch (err) {
      console.error('Error fetching users:', err);
    }
  }

  getStoredAuthSession() {
    try {
      const sessionStr = localStorage.getItem('rtwhatsup_auth_' + this.portalMode);
      if (!sessionStr) return null;
      const user = JSON.parse(sessionStr);
      if (!user || !user.id || !user.role) return null;
      if (this.portalMode === 'admin' && user.role !== 'Admin') return null;
      if (this.portalMode === 'employee' && user.role !== 'Employee') return null;

      if (this.users && this.users.length > 0) {
        const fresh = this.users.find(u => u.id === user.id);
        if (fresh) return fresh;
      }
      return user;
    } catch (e) {
      return null;
    }
  }

  // Check and restore authenticated staff member based on portal mode
  initCurrentUser() {
    const authUser = this.getStoredAuthSession();
    if (authUser) {
      this.currentUser = authUser;
      if (this.portalMode === 'admin') {
        localStorage.setItem('rtwhatsup_admin_user_id', authUser.id);
      } else {
        localStorage.setItem('rtwhatsup_employee_user_id', authUser.id);
      }
      this.renderCurrentUserHeader();
      window.socketService.init(this.currentUser.id);
      return true;
    }
    this.currentUser = null;
    return false;
  }

  showAuthLoginModal(prefillEmail = '') {
    const modal = document.getElementById('modal-auth-login');
    if (!modal) return;

    const titleEl = document.getElementById('auth-portal-title');
    const badgeEl = document.getElementById('auth-portal-badge');
    const hintEl = document.getElementById('auth-hint-text');
    const emailInput = document.getElementById('auth-input-email');
    const passInput = document.getElementById('auth-input-password');
    const errEl = document.getElementById('auth-login-error');

    if (errEl) errEl.style.display = 'none';
    if (passInput) passInput.value = '';

    if (this.portalMode === 'admin') {
      if (titleEl) titleEl.innerText = 'RegiusTax Admin Portal Sign In';
      if (badgeEl) badgeEl.innerHTML = '<span style="display:inline-flex; align-items:center; gap:5px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg> Administrator Authentication</span>';
      if (hintEl) {
        hintEl.innerHTML = `<span style="display:inline-flex; align-items:center; gap:4px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg> <strong>Admin Account:</strong></span> <code>admin@regiustax.com</code><br>Default initial password: <code>RegiusAdmin@2026</code>`;
      }
      if (emailInput) {
        emailInput.value = prefillEmail || 'admin@regiustax.com';
      }
    } else {
      if (titleEl) titleEl.innerText = 'RegiusTax Employee Portal Sign In';
      if (badgeEl) badgeEl.innerHTML = '<span style="display:inline-flex; align-items:center; gap:5px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg> Employee Workspace</span>';
      if (hintEl) {
        hintEl.innerHTML = `<span style="display:inline-flex; align-items:center; gap:4px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg> <strong>Employees:</strong></span> e.g. <code>calling.emp1@regiustax.com</code><br>Default initial password: <code>RegiusStaff@2026</code> (or password created by Admin)`;
      }
      if (emailInput) {
        emailInput.value = prefillEmail || '';
      }
    }

    modal.style.display = 'flex';
    if (emailInput && !emailInput.value) {
      emailInput.focus();
    } else if (passInput) {
      passInput.focus();
    }
  }

  async handleAuthLogin(email, password) {
    const errEl = document.getElementById('auth-login-error');
    const submitBtn = document.getElementById('btn-auth-signin');
    if (errEl) errEl.style.display = 'none';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Verifying...';
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
          portalMode: this.portalMode
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      // Store authenticated session
      localStorage.setItem('rtwhatsup_auth_' + this.portalMode, JSON.stringify(data.user));
      this.currentUser = data.user;

      // Close login modal
      document.getElementById('modal-auth-login').style.display = 'none';

      // Re-init current user & sockets & channels
      await this.fetchUsers();
      this.renderCurrentUserHeader();
      window.socketService.init(this.currentUser.id);
      await this.loadChannels();

      if (this.channels && this.channels.length > 0 && window.innerWidth > 900) {
        this.selectChannel(this.channels[0].id);
      }
    } catch (err) {
      if (errEl) {
        errEl.innerText = `⚠️ ${err.message}`;
        errEl.style.display = 'block';
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span style="display:inline-flex; align-items:center; gap:6px;"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg> Sign In</span>';
      }
    }
  }

  logout() {
    if (confirm('Are you sure you want to lock/sign out of this session? You will need your password to sign in again.')) {
      localStorage.removeItem('rtwhatsup_auth_' + this.portalMode);
      this.currentUser = null;
      if (window.socketService && window.socketService.socket) {
        window.socketService.socket.disconnect();
      }
      this.channels = [];
      this.renderChatList();
      const activeConv = document.getElementById('active-conversation');
      if (activeConv) activeConv.style.display = 'none';
      const welcome = document.getElementById('welcome-screen');
      if (welcome) welcome.style.display = 'flex';
      this.showAuthLoginModal();
    }
  }

  switchUser(user) {
    if (this.portalMode === 'employee' && user.role !== 'Employee') {
      alert('This is the Employee Portal. To access Admin privileges, please visit the Admin Portal (/admin).');
      return;
    }
    this.currentUser = user;
    if (this.portalMode === 'employee') {
      localStorage.setItem('rtwhatsup_employee_user_id', user.id);
      localStorage.setItem('rtwhatsup_auth_employee', JSON.stringify(user));
    } else {
      localStorage.setItem('rtwhatsup_admin_user_id', user.id);
      localStorage.setItem('rtwhatsup_auth_admin', JSON.stringify(user));
    }
    this.renderCurrentUserHeader();
    window.socketService.init(user.id);
    this.closeModal('modal-profiles');
    this.loadChannels();
    this.activeChannel = null;
    document.getElementById('active-conversation').style.display = 'none';
    document.getElementById('welcome-screen').style.display = 'flex';
  }

  renderCurrentUserHeader() {
    if (!this.currentUser) return;

    // Portal Badges & Dynamic Page Title
    const headerPill = document.getElementById('header-portal-indicator');
    const badgeTitle = document.getElementById('portal-badge-title');
    if (this.portalMode === 'admin') {
      if (headerPill) {
        headerPill.className = 'portal-header-pill portal-pill-admin';
        headerPill.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg><span>Admin</span>';
      }
      if (badgeTitle) badgeTitle.innerText = 'RegiusTax Admin Console';
      document.title = "RTwhat's up - RegiusTax Admin Portal";
    } else {
      if (headerPill) {
        headerPill.className = 'portal-header-pill portal-pill-emp';
        headerPill.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg><span>Employee</span>';
      }
      if (badgeTitle) badgeTitle.innerText = 'RegiusTax Employee Workspace';
      document.title = "RTwhat's up - RegiusTax Employee Portal";
    }

    const curAvatarEl = document.getElementById('current-user-avatar');
    if (curAvatarEl) {
      const isAdmin = this.currentUser && this.currentUser.role === 'Admin';
      curAvatarEl.className = 'avatar-circle current-avatar ' + (isAdmin ? 'avatar-circle-admin' : 'avatar-circle-user');
      curAvatarEl.innerHTML = isAdmin
        ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
    }
    document.getElementById('current-user-name').innerText = this.currentUser.full_name;

    let roleHtml = '';
    if (this.currentUser.role === 'Admin') {
      roleHtml = `<span class="badge-role badge-admin">ADMIN</span> ${this.escapeHtml(this.currentUser.email || '')}`;
    } else {
      const dept = this.currentUser.department || 'Calling Team';
      roleHtml = `<span class="badge-role badge-emp">EMPLOYEE</span> <span class="badge-dept" style="font-size:10.5px; margin-left:4px;">${this.escapeHtml(dept)}</span>`;
    }
    document.getElementById('current-user-role').innerHTML = roleHtml;

    // Availability status pill button update
    const btnAvail = document.getElementById('btn-availability-toggle');
    const labelAvail = document.getElementById('availability-status-label');
    if (btnAvail && labelAvail) {
      const isUnavailable = (this.currentUser.status || '').toLowerCase().includes('unavailable');
      if (isUnavailable) {
        btnAvail.className = 'btn-availability-toggle unavailable';
        labelAvail.innerText = 'Unavailable';
        btnAvail.title = 'You are currently marked UNAVAILABLE (Away). Click to switch to Available.';
      } else {
        btnAvail.className = 'btn-availability-toggle available';
        labelAvail.innerText = 'Available';
        btnAvail.title = 'You are currently marked AVAILABLE. Click to switch to Unavailable.';
      }
    }

    // Admin-only quick buttons (strictly hidden in Employee portal)
    const quickAddBtn = document.getElementById('btn-quick-add-emp');
    if (quickAddBtn) {
      quickAddBtn.style.display = (this.portalMode === 'admin' && this.currentUser.role === 'Admin') ? 'flex' : 'none';
    }

    const btnAdminOutsideLinks = document.getElementById('btn-admin-outside-links');
    if (btnAdminOutsideLinks) {
      btnAdminOutsideLinks.style.display = (this.portalMode === 'admin' && this.currentUser.role === 'Admin') ? 'flex' : 'none';
    }

    // Hide delete channel button in Employee portal
    const delActiveChanBtn = document.getElementById('btn-delete-active-channel');
    if (delActiveChanBtn) {
      delActiveChanBtn.style.display = (this.portalMode === 'admin' && this.currentUser.role === 'Admin') ? 'flex' : 'none';
    }

    // Data Backup Manager buttons (Strictly visible to Admin only in Admin Portal, hidden for Employees)
    const isAdmin = (this.portalMode === 'admin' && this.currentUser.role === 'Admin');
    const btnOpenBackup = document.getElementById('btn-open-backup-manager');
    if (btnOpenBackup) {
      btnOpenBackup.style.display = isAdmin ? 'flex' : 'none';
    }
    const btnBannerBackup = document.getElementById('btn-banner-backup');
    if (btnBannerBackup) {
      btnBannerBackup.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    // Mobile More Dropdown menu items
    const mobileBackup = document.getElementById('mobile-item-backup');
    if (mobileBackup) mobileBackup.style.display = isAdmin ? 'flex' : 'none';
    const mobileAddEmp = document.getElementById('mobile-item-add-emp');
    if (mobileAddEmp) mobileAddEmp.style.display = isAdmin ? 'flex' : 'none';
    const mobileOutsideLinks = document.getElementById('mobile-item-outside-links');
    if (mobileOutsideLinks) mobileOutsideLinks.style.display = isAdmin ? 'flex' : 'none';

    const mobileThemeLabel = document.getElementById('mobile-theme-label');
    const mobileThemeIcon = document.getElementById('mobile-theme-icon');
    const isDark = document.body.classList.contains('theme-dark');
    if (mobileThemeLabel) mobileThemeLabel.innerText = isDark ? 'Light Mode' : 'Dark Mode';
    if (mobileThemeIcon) {
      mobileThemeIcon.innerHTML = isDark
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>';
    }
  }

  // Load Channels & Direct Messages for Current User
  async loadChannels() {
    if (!this.currentUser) return;
    try {
      const res = await fetch(`/api/channels?userId=${this.currentUser.id}`);
      this.channels = await res.json();
      this.renderChatList();

      // Auto-open first channel if none active and screen is desktop
      if (!this.activeChannel && this.channels.length > 0 && window.innerWidth > 900) {
        await this.selectChannel(this.channels[0].id);
      }
    } catch (err) {
      console.error('Error loading channels:', err);
    }
  }

  renderChatList() {
    const chatList = document.getElementById('chat-list');
    if (!chatList) return;

    let filtered = this.channels;
    if (this.currentFilter === 'channels') {
      filtered = this.channels.filter(c => !c.is_direct);
    } else if (this.currentFilter === 'direct') {
      filtered = this.channels.filter(c => c.is_direct);
    }

    // Apply search filter if present
    const searchVal = document.getElementById('search-input').value.trim().toLowerCase();
    if (searchVal) {
      filtered = filtered.filter(c => 
        (c.name && c.name.toLowerCase().includes(searchVal)) ||
        (c.last_message && c.last_message.toLowerCase().includes(searchVal)) ||
        (c.description && c.description.toLowerCase().includes(searchVal))
      );
    }

    if (filtered.length === 0) {
      chatList.innerHTML = `<div class="loading-chats">No conversations found</div>`;
      return;
    }

    chatList.innerHTML = filtered.map(c => {
      const isActive = this.activeChannel && this.activeChannel.id === c.id;
      const isOnline = c.is_direct && c.direct_user ? c.direct_user.isOnline : false;
      const timeStr = c.last_message_time ? this.formatTime(c.last_message_time) : '';
      
      let lastMsgPreview = c.last_message || c.description || 'Start a conversation';
      if (c.last_message_type === 'image') lastMsgPreview = 'Photo / Invoice';
      else if (c.last_message_type === 'file') lastMsgPreview = 'Document attached';
      else if (c.last_message_type === 'audio') lastMsgPreview = 'Voice message';

      const unreadBadge = c.unread_count > 0 
        ? `<span class="unread-badge">${c.unread_count}</span>` 
        : '';

      return `
        <div class="chat-item ${isActive ? 'active' : ''}" data-id="${c.id}">
          <div class="chat-avatar-wrapper">
            ${this.getChannelAvatarHtml(c, 20)}
            ${isOnline ? '<div class="online-dot"></div>' : ''}
          </div>
          <div class="chat-details">
            <div class="chat-row-top">
              <span class="chat-item-name">${this.escapeHtml(c.name)}</span>
              <span class="chat-item-time">${timeStr}</span>
            </div>
            <div class="chat-row-bottom">
              <span class="chat-last-msg">${this.escapeHtml(lastMsgPreview)}</span>
              ${unreadBadge}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach click handlers to chat items
    chatList.querySelectorAll('.chat-item').forEach(el => {
      el.addEventListener('click', () => {
        const channelId = el.getAttribute('data-id');
        this.selectChannel(channelId);
      });
    });
  }

  // Select a Channel & Open Conversation Canvas
  async selectChannel(channelId, initialMessages = null) {
    const channel = this.channels.find(c => c.id === channelId);
    if (!channel) return;

    this.cancelReply();
    this.activeChannel = channel;
    this.renderChatList(); // Update active highlight

    // Switch UI from welcome screen to active chat
    document.getElementById('welcome-screen').style.display = 'none';
    const activeConv = document.getElementById('active-conversation');
    activeConv.style.display = 'flex';
    document.querySelector('.messenger-box').classList.add('mobile-chat-active');

    // Update Chat Header
    const chatHeaderAv = document.getElementById('chat-header-avatar');
    if (chatHeaderAv) {
      const isDirect = channel.is_direct;
      const isAdmin = isDirect && channel.direct_user && (channel.direct_user.role === 'Admin' || (channel.direct_user.email && channel.direct_user.email.includes('admin')));
      chatHeaderAv.className = 'avatar-circle ' + (isDirect ? (isAdmin ? 'avatar-circle-admin' : 'avatar-circle-user') : 'avatar-circle-group');
      chatHeaderAv.innerHTML = isDirect
        ? (isAdmin 
            ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>')
        : '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
    }
    document.getElementById('chat-header-title').innerText = channel.name;

    if (channel.is_direct && channel.direct_user) {
      const isUnavail = (channel.direct_user.status || '').toLowerCase().includes('unavailable');
      if (isUnavail) {
        document.getElementById('chat-header-status').innerHTML = '<span style="color:#ea4335; font-weight:600; display:inline-flex; align-items:center; gap:5px;"><span class="status-dot" style="width:7px; height:7px; background:#ea4335; border-radius:50%; display:inline-block;"></span> Unavailable (Away from desk)</span>';
      } else {
        document.getElementById('chat-header-status').innerText = channel.direct_user.isOnline 
          ? 'Online' 
          : `Last seen ${this.formatTime(channel.direct_user.last_seen)}`;
      }
    } else {
      document.getElementById('chat-header-status').innerText = channel.description || 'Department Channel';
    }

    // Admin Delete Channel button visibility
    const delChanBtn = document.getElementById('btn-delete-active-channel');
    if (delChanBtn) {
      delChanBtn.style.display = (this.currentUser && this.currentUser.role === 'Admin' && !channel.is_direct) 
        ? 'flex' 
        : 'none';
    }

    // Connect Socket.IO to this channel
    window.socketService.switchChannel(channel.id);

    // Render messages
    if (initialMessages && initialMessages.length > 0) {
      this.renderMessages(initialMessages);
    } else {
      await this.loadMessages(channel.id);
    }

    // Mark as read
    fetch(`/api/channels/${channel.id}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: this.currentUser.id })
    });
    channel.unread_count = 0;
    this.renderChatList();
  }

  async loadMessages(channelId) {
    try {
      const res = await fetch(`/api/channels/${channelId}/messages`);
      const messages = await res.json();
      this.renderMessages(messages);
    } catch (err) {
      console.error('Error loading messages:', err);
    }
  }

  renderMessages(messages) {
    this.currentChannelMessages = Array.isArray(messages) ? [...messages] : [];
    const container = document.getElementById('messages-container');
    if (!container) return;

    if (messages.length === 0) {
      container.innerHTML = `
        <div class="date-divider">Today</div>
        <div style="text-align:center; padding: 20px; font-size:13px; color:var(--text-muted);">
          No messages yet. Send a note or attach a tax document to begin.
        </div>
      `;
      return;
    }

    let html = '<div class="date-divider">Today</div>';
    let lastDate = null;

    messages.forEach(m => {
      const isOutgoing = m.sender_id === this.currentUser.id;
      const time = this.formatTime(m.created_at);

      let quotedReplyHtml = '';
      if (m.reply_to_id) {
        let replySender = m.reply_to_sender_name || 'Original message';
        if (replySender === this.currentUser.full_name) {
          replySender = 'You';
        }
        let replySnippet = m.reply_to_text || '';
        if (m.reply_to_type === 'image') replySnippet = 'Photo / Invoice';
        else if (m.reply_to_type === 'file') replySnippet = `Document: ${m.reply_to_file_name || 'Tax File'}`;
        else if (m.reply_to_type === 'audio') replySnippet = 'Voice Note';

        quotedReplyHtml = `
          <div class="quoted-reply-box" onclick="window.appController.scrollToMessage('${m.reply_to_id}')" title="Jump to quoted message">
            <div class="quoted-reply-border"></div>
            <div class="quoted-reply-body">
              <div class="quoted-reply-sender">${this.escapeHtml(replySender)}</div>
              <div class="quoted-reply-text">${this.escapeHtml(replySnippet || 'Replied message')}</div>
            </div>
          </div>
        `;
      }

      const replyBtn = `
        <button class="btn-msg-reply-trigger" title="Reply to this message" onclick="event.stopPropagation(); window.appController.startReplyToMessage('${m.id}')" aria-label="Reply">
          <svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
          <span>Reply</span>
        </button>
      `;

      let bodyHtml = '';
      if (m.type === 'text') {
        bodyHtml = `<div class="message-content">${this.renderFormattedText(m.text)}</div>`;
      } else if (m.type === 'file') {
        const sizeStr = m.file_size ? `${(m.file_size / 1024).toFixed(1)} KB` : '';
        bodyHtml = `
          <a href="${m.file_url}" target="_blank" download="${m.file_name}" class="file-card">
            <span class="file-icon">${this.getFileIconSvg(m.file_name)}</span>
            <div class="file-info">
              <div class="file-name">${this.escapeHtml(m.file_name)}</div>
              <div class="file-size">${sizeStr} · Click to Download</div>
            </div>
            <span class="file-download-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></span>
          </a>
          ${m.text ? `<div class="message-content">${this.renderFormattedText(m.text)}</div>` : ''}
        `;
      } else if (m.type === 'image') {
        bodyHtml = `
          <div class="image-card" onclick="window.appController.openLightbox('${m.file_url}')">
            <img src="${m.file_url}" alt="${m.file_name}">
          </div>
          ${m.text ? `<div class="message-content">${this.renderFormattedText(m.text)}</div>` : ''}
        `;
      } else if (m.type === 'audio') {
        bodyHtml = `
          <div class="voice-note-card">
            <button class="voice-play-btn" onclick="window.appController.playAudio('${m.file_url}', this)">▶</button>
            <div class="voice-wave-bar">
              <span style="height: 10px;"></span>
              <span style="height: 16px;"></span>
              <span style="height: 22px;"></span>
              <span style="height: 14px;"></span>
              <span style="height: 18px;"></span>
              <span style="height: 12px;"></span>
              <span style="height: 20px;"></span>
              <span style="height: 8px;"></span>
            </div>
            <span class="voice-duration">Voice Note</span>
          </div>
        `;
      }

      const senderTag = !isOutgoing && !this.activeChannel.is_direct
        ? `<div class="sender-tag">
             <span>${this.escapeHtml(m.sender_name)}</span>
             <span class="sender-role-tag">${this.escapeHtml(m.sender_role || '')}</span>
           </div>`
        : '';

      const checkmarks = isOutgoing 
        ? `<span class="checkmarks read" title="Delivered & Read">✓✓</span>` 
        : '';

      const topRowHtml = `
        <div class="message-top-row">
          ${senderTag || '<div></div>'}
          ${replyBtn}
        </div>
      `;

      html += `
        <div class="message-bubble ${isOutgoing ? 'outgoing' : 'incoming'}" data-msg-id="${m.id}" onclick="window.appController.handleMessageBubbleClick('${m.id}', event)" ondblclick="window.appController.startReplyToMessage('${m.id}')" title="Click Reply button or double-click to reply">
          ${topRowHtml}
          ${quotedReplyHtml}
          ${bodyHtml}
          <div class="message-meta">
            <span class="message-time">${time}</span>
            ${checkmarks}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
    this.scrollToBottom();
  }

  scrollToBottom() {
    const container = document.getElementById('messages-container');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // Send Message logic with resilient delivery and text preservation
  async sendMessage() {
    const input = document.getElementById('message-text-input');
    const text = input.value.trim();
    if (!text || !this.activeChannel) return;

    const replyToId = this.currentReplyTo ? this.currentReplyTo.id : null;
    const payload = {
      channelId: this.activeChannel.id,
      senderId: this.currentUser.id,
      text,
      type: 'text',
      replyToId
    };

    // Clear reply preview draft
    this.cancelReply();

    // Clear input optimistically
    input.value = '';
    input.style.height = 'auto';
    window.socketService.sendTypingStop(this.activeChannel.id, this.currentUser.id);

    try {
      await window.socketService.sendMessage(payload);
    } catch (err) {
      console.error('Failed to deliver message:', err);
      // Restore user text so they never lose their message!
      input.value = text;
      alert('Message delivery failed: ' + (err.message || 'Please check your connection and retry.'));
    }
  }

  // Upload file (document, image, voice note) with visual loading indicator
  async uploadFile(file) {
    if (!file || !this.activeChannel) return;

    const replyToId = this.currentReplyTo ? this.currentReplyTo.id : null;
    this.cancelReply();

    const input = document.getElementById('message-text-input');
    const origPlaceholder = input ? input.placeholder : '';
    if (input) {
      input.disabled = true;
      input.placeholder = `Uploading ${file.name}... Please wait...`;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'File upload failed');

      await window.socketService.sendMessage({
        channelId: this.activeChannel.id,
        senderId: this.currentUser.id,
        text: '',
        type: data.type,
        fileUrl: data.url,
        fileName: data.fileName,
        fileSize: data.fileSize,
        replyToId
      });
    } catch (err) {
      console.error('File upload failed:', err);
      alert('Upload error: ' + err.message);
    } finally {
      if (input) {
        input.disabled = false;
        input.placeholder = origPlaceholder;
        input.focus();
      }
    }
  }

  // Handle incoming real-time message
  handleIncomingMessage(message) {
    if (this.activeChannel && message.channel_id === this.activeChannel.id) {
      if (!this.currentChannelMessages) this.currentChannelMessages = [];
      this.currentChannelMessages.push(message);

      const container = document.getElementById('messages-container');
      const isOutgoing = message.sender_id === this.currentUser.id;
      const time = this.formatTime(message.created_at);

      let quotedReplyHtml = '';
      if (message.reply_to_id) {
        let replySender = message.reply_to_sender_name || 'Original message';
        if (replySender === this.currentUser.full_name) {
          replySender = 'You';
        }
        let replySnippet = message.reply_to_text || '';
        if (message.reply_to_type === 'image') replySnippet = 'Photo / Invoice';
        else if (message.reply_to_type === 'file') replySnippet = `Document: ${message.reply_to_file_name || 'Tax File'}`;
        else if (message.reply_to_type === 'audio') replySnippet = 'Voice Note';

        quotedReplyHtml = `
          <div class="quoted-reply-box" onclick="window.appController.scrollToMessage('${message.reply_to_id}')" title="Jump to quoted message">
            <div class="quoted-reply-border"></div>
            <div class="quoted-reply-body">
              <div class="quoted-reply-sender">${this.escapeHtml(replySender)}</div>
              <div class="quoted-reply-text">${this.escapeHtml(replySnippet || 'Replied message')}</div>
            </div>
          </div>
        `;
      }

      const replyBtn = `
        <button class="btn-msg-reply-trigger" title="Reply to this message" onclick="event.stopPropagation(); window.appController.startReplyToMessage('${message.id}')" aria-label="Reply">
          <svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
          <span>Reply</span>
        </button>
      `;

      let bodyHtml = '';
      if (message.type === 'text') {
        bodyHtml = `<div class="message-content">${this.renderFormattedText(message.text)}</div>`;
      } else if (message.type === 'file') {
        const sizeStr = message.file_size ? `${(message.file_size / 1024).toFixed(1)} KB` : '';
        bodyHtml = `
          <a href="${message.file_url}" target="_blank" download="${message.file_name}" class="file-card">
            <span class="file-icon">${this.getFileIconSvg(message.file_name)}</span>
            <div class="file-info">
              <div class="file-name">${this.escapeHtml(message.file_name)}</div>
              <div class="file-size">${sizeStr} · Click to Download</div>
            </div>
            <span class="file-download-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></span>
          </a>
        `;
      } else if (message.type === 'image') {
        bodyHtml = `
          <div class="image-card" onclick="window.appController.openLightbox('${message.file_url}')">
            <img src="${message.file_url}" alt="${message.file_name}">
          </div>
        `;
      } else if (message.type === 'audio') {
        bodyHtml = `
          <div class="voice-note-card">
            <button class="voice-play-btn" onclick="window.appController.playAudio('${message.file_url}', this)">▶</button>
            <div class="voice-wave-bar">
              <span style="height: 14px;"></span>
              <span style="height: 20px;"></span>
              <span style="height: 12px;"></span>
              <span style="height: 18px;"></span>
              <span style="height: 8px;"></span>
            </div>
            <span class="voice-duration">Voice Note</span>
          </div>
        `;
      }

      const senderTag = !isOutgoing && !this.activeChannel.is_direct
        ? `<div class="sender-tag">
             <span>${this.escapeHtml(message.sender_name)}</span>
             <span class="sender-role-tag">${this.escapeHtml(message.sender_role || '')}</span>
           </div>`
        : '';

      const checkmarks = isOutgoing 
        ? `<span class="checkmarks read" title="Delivered & Read">✓✓</span>` 
        : '';

      const topRowHtml = `
        <div class="message-top-row">
          ${senderTag || '<div></div>'}
          ${replyBtn}
        </div>
      `;

      const bubble = document.createElement('div');
      bubble.className = `message-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;
      bubble.setAttribute('data-msg-id', message.id);
      bubble.setAttribute('title', 'Click Reply button or double-click to reply');
      bubble.onclick = (e) => this.handleMessageBubbleClick(message.id, e);
      bubble.ondblclick = () => this.startReplyToMessage(message.id);
      bubble.innerHTML = `
        ${topRowHtml}
        ${quotedReplyHtml}
        ${bodyHtml}
        <div class="message-meta">
          <span class="message-time">${time}</span>
          ${checkmarks}
        </div>
      `;
      container.appendChild(bubble);
      this.scrollToBottom();

      // If this was our message, clear any reply preview
      if (isOutgoing) {
        this.cancelReply();
      }

      // Play subtle chime for incoming messages from others
      if (!isOutgoing) {
        window.audioController.playNotificationSound();
      }
    }

    // Refresh channel last message and order in sidebar
    this.loadChannels();
  }

  // WhatsApp-style Reply Feature methods
  startReplyToMessage(msgId) {
    if (!msgId) return;
    let msg = this.currentChannelMessages ? this.currentChannelMessages.find(m => m.id === msgId) : null;
    
    if (!msg) {
      const bubble = document.querySelector(`[data-msg-id="${msgId}"]`);
      if (bubble) {
        const senderTag = bubble.querySelector('.sender-tag span');
        const content = bubble.querySelector('.message-content');
        msg = {
          id: msgId,
          sender_name: senderTag ? senderTag.innerText : (bubble.classList.contains('outgoing') ? 'You' : 'Member'),
          text: content ? content.innerText : 'Attachment / Note',
          type: 'text'
        };
      }
    }

    if (!msg) return;

    this.currentReplyTo = msg;

    const bar = document.getElementById('reply-preview-bar');
    const senderEl = document.getElementById('reply-preview-sender');
    const textEl = document.getElementById('reply-preview-text');

    const isSelf = (msg.sender_id && msg.sender_id === this.currentUser.id) || (msg.sender_name === 'You');
    const senderDisplay = isSelf ? 'Yourself' : (msg.sender_name || 'Member');

    let textSnippet = msg.text || '';
    if (msg.type === 'image') textSnippet = 'Photo / Invoice';
    else if (msg.type === 'file') textSnippet = `Document: ${msg.file_name || 'Tax File'}`;
    else if (msg.type === 'audio') textSnippet = 'Voice Note';

    if (senderEl) senderEl.innerText = `Replying to ${senderDisplay}`;
    if (textEl) textEl.innerText = textSnippet.length > 80 ? textSnippet.substring(0, 80) + '...' : textSnippet;
    if (bar) bar.style.display = 'flex';

    const input = document.getElementById('message-text-input');
    if (input) {
      input.focus();
    }
  }

  cancelReply() {
    this.currentReplyTo = null;
    const bar = document.getElementById('reply-preview-bar');
    if (bar) bar.style.display = 'none';
  }

  scrollToMessage(targetMsgId) {
    if (!targetMsgId) return;
    const targetEl = document.querySelector(`[data-msg-id="${targetMsgId}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.remove('message-highlight-pulse');
      void targetEl.offsetWidth;
      targetEl.classList.add('message-highlight-pulse');
      setTimeout(() => {
        targetEl.classList.remove('message-highlight-pulse');
      }, 2000);
    }
  }

  handleMessageBubbleClick(msgId, event) {
    if (!msgId) return;
    // Don't trigger if user clicked a link, button, file, or image
    if (event.target.closest('a') || event.target.closest('button') || event.target.closest('.image-card') || event.target.closest('.file-card') || event.target.closest('.voice-play-btn')) {
      return;
    }
    // On mobile / small screens, tapping a bubble opens reply
    if (window.innerWidth <= 768) {
      this.startReplyToMessage(msgId);
    }
  }

  async toggleAvailability() {
    if (!this.currentUser) return;
    const currentStatus = (this.currentUser.status || '').toLowerCase();
    const isCurrentlyUnavailable = currentStatus.includes('unavailable');
    const newStatus = isCurrentlyUnavailable ? 'Available' : 'Unavailable';

    try {
      const res = await fetch('/api/users/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.currentUser.id,
          status: newStatus
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update status');

      this.currentUser.status = newStatus;
      if (this.portalMode === 'admin') {
        const stored = localStorage.getItem('rtwhatsup_admin_user');
        if (stored) {
          try {
            const u = JSON.parse(stored);
            u.status = newStatus;
            localStorage.setItem('rtwhatsup_admin_user', JSON.stringify(u));
          } catch(e) {}
        }
      } else {
        const stored = localStorage.getItem('rtwhatsup_employee_user');
        if (stored) {
          try {
            const u = JSON.parse(stored);
            u.status = newStatus;
            localStorage.setItem('rtwhatsup_employee_user', JSON.stringify(u));
          } catch(e) {}
        }
      }

      this.renderCurrentUserHeader();
      this.renderChatList();

      const toast = document.createElement('div');
      toast.className = 'connection-toast show';
      toast.style.background = isCurrentlyUnavailable ? '#0b6e4f' : '#c5221f';
      toast.innerText = isCurrentlyUnavailable 
        ? '🟢 Status: You are now AVAILABLE' 
        : '🔴 Status: You are now UNAVAILABLE (Auto-reply active)';
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }, 2500);

    } catch (err) {
      console.error('Error toggling availability:', err);
      alert('Failed to update availability: ' + err.message);
    }
  }

  handleChannelNotice(data) {
    if (!this.activeChannel || this.activeChannel.id !== data.channelId) {
      window.audioController.playNotificationSound();
      this.loadChannels();
    }
  }

  handlePresenceUpdate({ userId, isOnline }) {
    const user = this.users.find(u => u.id === userId);
    if (user) {
      user.isOnline = isOnline;
    }
    this.renderChatList();
    if (this.activeChannel && this.activeChannel.is_direct && this.activeChannel.direct_user && this.activeChannel.direct_user.id === userId) {
      document.getElementById('chat-header-status').innerText = isOnline ? 'Online' : 'Offline';
    }
  }

  handleTypingStatus({ channelId, userId, userName, isTyping }) {
    if (!this.activeChannel || this.activeChannel.id !== channelId) return;
    if (userId === this.currentUser.id) return;

    const bar = document.getElementById('typing-indicator-bar');
    const text = document.getElementById('typing-text');

    if (isTyping) {
      text.innerText = `${userName} is typing...`;
      bar.style.display = 'flex';
    } else {
      bar.style.display = 'none';
    }
  }

  // Play audio voice note safely
  playAudio(url, buttonEl) {
    if (this.currentPlayingAudio) {
      this.currentPlayingAudio.pause();
      if (this.currentPlayingAudio.btn) {
        this.currentPlayingAudio.btn.innerText = '▶';
      }
      if (this.currentPlayingAudio.src.endsWith(url)) {
        this.currentPlayingAudio = null;
        return;
      }
    }

    const audio = new Audio(url);
    audio.btn = buttonEl;
    buttonEl.innerText = '⏸';

    audio.onended = () => {
      buttonEl.innerText = '▶';
      this.currentPlayingAudio = null;
    };

    audio.onerror = (e) => {
      console.warn('Audio playback error:', e);
      buttonEl.innerText = '▶';
      this.currentPlayingAudio = null;
    };

    const playPromise = audio.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch((err) => {
        console.warn('Autoplay prevented or audio play failed:', err);
        buttonEl.innerText = '▶';
        this.currentPlayingAudio = null;
      });
    }
    this.currentPlayingAudio = audio;
  }

  // Live connection status indicator (warns user if offline, hides when online)
  updateConnectionStatus(isConnected) {
    let banner = document.getElementById('network-reconnecting-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'network-reconnecting-banner';
      banner.style.cssText = 'display:none; background:#ea4335; color:white; font-size:12px; font-weight:600; text-align:center; padding:6px 12px; z-index:9999; position:sticky; top:0; width:100%; box-sizing:border-box; box-shadow:0 2px 8px rgba(0,0,0,0.2);';
      banner.innerHTML = '⚡ Network paused. Reconnecting to RegiusTax local network...';
      const mainBox = document.querySelector('.messenger-box');
      if (mainBox) mainBox.prepend(banner);
    }

    if (isConnected) {
      banner.style.display = 'none';
    } else {
      banner.style.display = 'block';
    }
  }

  // Lightbox
  openLightbox(url) {
    const modal = document.getElementById('modal-lightbox');
    const img = document.getElementById('lightbox-image');
    img.src = url;
    modal.style.display = 'flex';
  }

  // Setup DOM Event Listeners
  setupEventListeners() {
    // Send message on Enter (Shift+Enter for newline)
    const textInput = document.getElementById('message-text-input');
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      } else {
        this.triggerTyping();
      }
    });

    document.getElementById('btn-send-message').addEventListener('click', () => {
      this.sendMessage();
    });

    // Cancel reply preview button
    const btnCancelReply = document.getElementById('btn-cancel-reply');
    if (btnCancelReply) {
      btnCancelReply.addEventListener('click', () => {
        this.cancelReply();
      });
    }

    // Escape key cancels active reply draft
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.currentReplyTo) {
        this.cancelReply();
      }
    });

    // Theme toggle
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      this.toggleTheme();
    });

    // Availability status toggle (Available ⇄ Unavailable)
    const btnAvail = document.getElementById('btn-availability-toggle');
    if (btnAvail) {
      btnAvail.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleAvailability();
      });
    }

    // Mobile More Menu Toggle (3 Dots ⋮)
    const btnMobileMenu = document.getElementById('btn-mobile-more-menu');
    const mobileDropdown = document.getElementById('mobile-more-dropdown');
    if (btnMobileMenu && mobileDropdown) {
      btnMobileMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = mobileDropdown.style.display === 'flex';
        mobileDropdown.style.display = isOpen ? 'none' : 'flex';
      });

      // Close mobile dropdown when tapping outside
      document.addEventListener('click', (e) => {
        if (!mobileDropdown.contains(e.target) && e.target !== btnMobileMenu) {
          mobileDropdown.style.display = 'none';
        }
      });
    }

    // Connect items in mobile menu
    const bindMobileClick = (id, fn) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (mobileDropdown) mobileDropdown.style.display = 'none';
          fn(e);
        });
      }
    };

    bindMobileClick('mobile-item-password', () => this.openChangePasswordModal());
    bindMobileClick('mobile-item-theme', () => this.toggleTheme());
    bindMobileClick('mobile-item-lan', () => this.openModal('modal-lan'));
    bindMobileClick('mobile-item-backup', () => this.openBackupManagerModal());
    bindMobileClick('mobile-item-add-emp', () => {
      this.renderStaffModal('admin-add');
      this.openModal('modal-profiles');
    });
    bindMobileClick('mobile-item-outside-links', () => this.openModal('modal-client-links'));
    bindMobileClick('mobile-item-profiles', () => this.openModal('modal-profiles'));
    bindMobileClick('mobile-item-logout', () => this.logout());
    bindMobileClick('mobile-item-gateway', () => { window.location.href = '/'; });

    // Back button on mobile
    document.getElementById('btn-back-to-list').addEventListener('click', () => {
      document.querySelector('.messenger-box').classList.remove('mobile-chat-active');
    });

    // LAN / QR Modal
    document.getElementById('btn-lan-info').addEventListener('click', () => {
      this.openModal('modal-lan');
    });
    document.getElementById('btn-show-qr-welcome').addEventListener('click', () => {
      this.openModal('modal-lan');
    });
    document.getElementById('btn-close-lan').addEventListener('click', () => {
      this.closeModal('modal-lan');
    });
    document.getElementById('btn-copy-ip').addEventListener('click', () => {
      this.copyToClipboard(this.serverInfo ? this.serverInfo.networkUrl : '');
    });
    document.getElementById('btn-modal-copy-ip').addEventListener('click', () => {
      this.copyToClipboard(document.getElementById('modal-lan-url').value);
    });

    // Auth Logout / Lock
    const btnLogout = document.getElementById('btn-auth-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => {
        this.logout();
      });
    }

    // Open Work Assistance Tracker Modal (Header & Banner buttons)
    const btnOpenTracker = document.getElementById('btn-open-work-tracker');
    if (btnOpenTracker) {
      btnOpenTracker.addEventListener('click', () => {
        this.openWorkTrackerModal();
      });
    }

    const btnBannerTracker = document.getElementById('btn-banner-work-tracker');
    if (btnBannerTracker) {
      btnBannerTracker.addEventListener('click', () => {
        this.openWorkTrackerModal();
      });
    }

    // Close Work Tracker Modal
    const btnCloseTracker = document.getElementById('btn-close-work-tracker');
    if (btnCloseTracker) {
      btnCloseTracker.addEventListener('click', () => {
        this.closeModal('modal-work-tracker');
      });
    }

    // Refresh Work Tracker
    const btnRefreshTracker = document.getElementById('btn-refresh-tracker');
    if (btnRefreshTracker) {
      btnRefreshTracker.addEventListener('click', () => {
        this.loadWorkTracker();
      });
    }

    // Go-Live: Clear All Tracker Requests button in Tracker Header (Admin only)
    const btnClearTrackerHeader = document.getElementById('btn-admin-clear-tracker');
    if (btnClearTrackerHeader) {
      btnClearTrackerHeader.addEventListener('click', () => {
        this.adminClearAllWorkRequests();
      });
    }

    // Open New Request Modal
    const btnOpenNewReq = document.getElementById('btn-open-new-tracker-request');
    if (btnOpenNewReq) {
      btnOpenNewReq.addEventListener('click', () => {
        this.openNewWorkRequestModal();
      });
    }

    // Close New Request Modal
    const btnCloseNewReq = document.getElementById('btn-close-new-request');
    if (btnCloseNewReq) {
      btnCloseNewReq.addEventListener('click', () => {
        this.closeModal('modal-new-work-request');
      });
    }

    // Form: Submit New Work Request
    const formNewWorkReq = document.getElementById('form-new-work-request');
    if (formNewWorkReq) {
      formNewWorkReq.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.submitNewWorkRequest();
      });
    }

    // Cancel Close Request Modal
    const btnCancelCloseReq = document.getElementById('btn-cancel-close-req');
    if (btnCancelCloseReq) {
      btnCancelCloseReq.addEventListener('click', () => {
        this.closeModal('modal-close-work-request');
      });
    }

    // Form: Submit Close Request
    const formCloseWorkReq = document.getElementById('form-close-work-request');
    if (formCloseWorkReq) {
      formCloseWorkReq.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.submitCloseWorkRequest();
      });
    }

    // Status Filter Tabs
    const statusTabs = document.querySelectorAll('#tracker-status-tabs .pill-filter');
    statusTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        statusTabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.trackerFilterStatus = btn.getAttribute('data-status');
        this.updateActiveMetricCardIndicator();
        this.loadWorkTracker();
      });
    });

    // Team Filter
    const filterTeam = document.getElementById('tracker-filter-team');
    if (filterTeam) {
      filterTeam.addEventListener('change', (e) => {
        this.trackerFilterTeam = e.target.value;
        this.loadWorkTracker();
      });
    }

    // Priority Filter
    const filterPriority = document.getElementById('tracker-filter-priority');
    if (filterPriority) {
      filterPriority.addEventListener('change', (e) => {
        this.trackerFilterPriority = e.target.value;
        this.updateActiveMetricCardIndicator();
        this.loadWorkTracker();
      });
    }

    // Search Input
    const searchTracker = document.getElementById('tracker-search-input');
    if (searchTracker) {
      let searchTimeout = null;
      searchTracker.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          this.trackerSearch = e.target.value.trim();
          this.loadWorkTracker();
        }, 300);
      });
    }

    // Clickable Metric Cards as Quick Filter Buttons (Total, Urgent, In Progress, Completed, Closed)
    const metricCards = document.querySelectorAll('.tracker-metric-card[data-filter]');
    metricCards.forEach(card => {
      const handleMetricClick = () => {
        const filterType = card.getAttribute('data-filter');
        this.applyTrackerMetricFilter(filterType);
      };

      card.addEventListener('click', handleMetricClick);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleMetricClick();
        }
      });
    });

    // Header Open Change Password button
    const btnOpenChangePass = document.getElementById('btn-open-change-password');
    if (btnOpenChangePass) {
      btnOpenChangePass.addEventListener('click', () => {
        this.openChangePasswordModal();
      });
    }

    // Header Open Backup Manager button
    const btnOpenBackup = document.getElementById('btn-open-backup-manager');
    if (btnOpenBackup) {
      btnOpenBackup.addEventListener('click', () => {
        this.openBackupManagerModal();
      });
    }

    // Banner Backup Manager button (Admin only)
    const btnBannerBackup = document.getElementById('btn-banner-backup');
    if (btnBannerBackup) {
      btnBannerBackup.addEventListener('click', () => {
        this.openBackupManagerModal();
      });
    }

    // Close Backup Manager Modal
    const btnCloseBackup = document.getElementById('btn-close-backup-manager');
    if (btnCloseBackup) {
      btnCloseBackup.addEventListener('click', () => {
        this.closeModal('modal-backup-manager');
      });
    }

    // Take Backup Now button
    const btnTriggerBackup = document.getElementById('btn-trigger-backup-now');
    if (btnTriggerBackup) {
      btnTriggerBackup.addEventListener('click', () => {
        this.triggerBackupNow();
      });
    }

    // Download Latest Backup button
    const btnDownloadLatest = document.getElementById('btn-download-latest-backup');
    if (btnDownloadLatest) {
      btnDownloadLatest.addEventListener('click', () => {
        if (!this.currentUser || this.currentUser.role !== 'Admin') return;
        window.open(`/api/backup/download/latest?adminId=${encodeURIComponent(this.currentUser.id)}`, '_blank');
      });
    }

    // Refresh Backup List button
    const btnRefreshBackup = document.getElementById('btn-refresh-backup-list');
    if (btnRefreshBackup) {
      btnRefreshBackup.addEventListener('click', () => {
        this.loadBackupStatus();
      });
    }

    // Go-Live: Clear All Messages button (Admin only)
    const btnClearAllMsgs = document.getElementById('btn-admin-clear-all-msgs');
    if (btnClearAllMsgs) {
      btnClearAllMsgs.addEventListener('click', () => {
        this.adminClearAllMessages();
      });
    }

    // Go-Live: Clear All Tracker Requests button (Admin only in Backup Manager)
    const btnClearAllReqs = document.getElementById('btn-admin-clear-all-requests');
    if (btnClearAllReqs) {
      btnClearAllReqs.addEventListener('click', () => {
        this.adminClearAllWorkRequests();
      });
    }

    // Dedicated Change Password Modal Close
    const btnCloseChangePass = document.getElementById('btn-close-change-pass');
    if (btnCloseChangePass) {
      btnCloseChangePass.addEventListener('click', () => {
        this.closeModal('modal-change-password');
      });
    }

    // Form: Dedicated Change Own Password
    const formChangeOwnPass = document.getElementById('form-change-own-password');
    if (formChangeOwnPass) {
      formChangeOwnPass.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPass = document.getElementById('input-change-current-pass').value.trim();
        const newPass = document.getElementById('input-change-new-pass').value.trim();
        const confirmPass = document.getElementById('input-change-confirm-pass').value.trim();
        await this.submitChangeOwnPassword(currentPass, newPass, confirmPass, 'modal');
      });
    }

    // Form: Profiles Tab Change Own Password
    const formProfilesChangePass = document.getElementById('form-profiles-change-pass');
    if (formProfilesChangePass) {
      formProfilesChangePass.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPass = document.getElementById('profiles-change-current-pass').value.trim();
        const newPass = document.getElementById('profiles-change-new-pass').value.trim();
        const confirmPass = document.getElementById('profiles-change-confirm-pass').value.trim();
        await this.submitChangeOwnPassword(currentPass, newPass, confirmPass, 'profiles');
      });
    }

    // Dedicated Auth Login Form Submission
    const formAuthLogin = document.getElementById('form-auth-login');
    if (formAuthLogin) {
      formAuthLogin.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('auth-input-email').value.trim();
        const password = document.getElementById('auth-input-password').value.trim();
        await this.handleAuthLogin(email, password);
      });
    }

    // Toggle Password Visibility
    const btnToggleAuthPass = document.getElementById('btn-toggle-auth-password');
    if (btnToggleAuthPass) {
      btnToggleAuthPass.addEventListener('click', () => {
        const passInput = document.getElementById('auth-input-password');
        if (passInput.type === 'password') {
          passInput.type = 'text';
          btnToggleAuthPass.innerText = 'Hide';
        } else {
          passInput.type = 'password';
          btnToggleAuthPass.innerText = 'Show';
        }
      });
    }

    // Quick Add Employee button (header)
    const quickAdd = document.getElementById('btn-quick-add-emp');
    if (quickAdd) {
      quickAdd.addEventListener('click', () => {
        this.renderStaffModal('admin-add');
        this.openModal('modal-profiles');
      });
    }

    // Account Switcher Modal
    document.getElementById('btn-profile-switch').addEventListener('click', () => {
      this.renderStaffModal('accounts');
      this.openModal('modal-profiles');
    });
    document.getElementById('btn-close-profiles').addEventListener('click', () => {
      this.closeModal('modal-profiles');
    });

    // Account Modal Tabs
    document.getElementById('tab-switch-acc').addEventListener('click', () => {
      this.switchStaffModalTab('switch-acc');
    });
    const tabChangePass = document.getElementById('tab-change-pass');
    if (tabChangePass) {
      tabChangePass.addEventListener('click', () => {
        this.switchStaffModalTab('change-pass');
      });
    }
    document.getElementById('tab-login-email').addEventListener('click', () => {
      this.switchStaffModalTab('login-email');
    });
    document.getElementById('tab-admin-add-emp').addEventListener('click', () => {
      this.switchStaffModalTab('admin-add-emp');
    });
    document.getElementById('tab-admin-depts').addEventListener('click', () => {
      this.switchStaffModalTab('admin-depts');
    });

    // Toggle inline department creation box
    const btnToggleInline = document.getElementById('btn-toggle-inline-dept');
    const inlineBox = document.getElementById('inline-dept-box');
    if (btnToggleInline && inlineBox) {
      btnToggleInline.addEventListener('click', () => {
        inlineBox.style.display = inlineBox.style.display === 'none' ? 'block' : 'none';
        if (inlineBox.style.display === 'block') {
          document.getElementById('inline-new-dept-name').focus();
        }
      });
    }

    // Save inline new department
    const btnSaveInline = document.getElementById('btn-save-inline-dept');
    if (btnSaveInline) {
      btnSaveInline.addEventListener('click', async () => {
        const input = document.getElementById('inline-new-dept-name');
        const deptName = input.value.trim();
        if (!deptName) return;

        try {
          const res = await fetch('/api/departments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: deptName, adminId: this.currentUser.id })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to create department');
          await this.fetchDepartments();
          this.renderDepartmentDropdown();
          document.getElementById('new-emp-department').value = data.name;
          input.value = '';
          inlineBox.style.display = 'none';
        } catch (err) {
          alert('Error adding department: ' + err.message);
        }
      });
    }

    // Form: Admin Create Department in Departments Tab
    const formCreateDept = document.getElementById('form-create-department');
    if (formCreateDept) {
      formCreateDept.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('input-new-dept-tab');
        const deptName = input.value.trim();
        const errEl = document.getElementById('admin-dept-error');
        const succEl = document.getElementById('admin-dept-success');
        errEl.style.display = 'none';
        succEl.style.display = 'none';

        try {
          const res = await fetch('/api/departments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: deptName, adminId: this.currentUser.id })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to create department');
          succEl.innerText = `✅ Department "${data.name}" created with its room!`;
          succEl.style.display = 'block';
          input.value = '';
          await this.fetchDepartments();
          this.renderDepartmentsPanel();
          this.renderDepartmentDropdown();
          await this.loadChannels();
        } catch (err) {
          errEl.innerText = err.message;
          errEl.style.display = 'block';
        }
      });
    }

    // Form: Login by Email & Password
    const formLoginEmail = document.getElementById('form-login-email');
    if (formLoginEmail) {
      formLoginEmail.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('input-login-email').value.trim();
        const password = document.getElementById('input-login-password').value.trim();
        const errEl = document.getElementById('login-email-error');
        if (errEl) errEl.style.display = 'none';

        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, portalMode: this.portalMode })
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Failed to sign in');
          }
          localStorage.setItem('rtwhatsup_auth_' + this.portalMode, JSON.stringify(data.user));
          await this.fetchUsers();
          this.switchUser(data.user);
        } catch (err) {
          if (errEl) {
            errEl.innerText = err.message;
            errEl.style.display = 'block';
          }
        }
      });
    }

    // Form: Admin Add Employee by Email & Department with Password
    const formAddEmp = document.getElementById('form-admin-add-employee');
    if (formAddEmp) {
      formAddEmp.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('new-emp-email').value.trim();
        const password = document.getElementById('new-emp-password').value.trim();
        const name = document.getElementById('new-emp-name').value.trim();
        const department = document.getElementById('new-emp-department').value;
        const errEl = document.getElementById('admin-add-error');
        const succEl = document.getElementById('admin-add-success');
        if (errEl) errEl.style.display = 'none';
        if (succEl) succEl.style.display = 'none';

        if (!password) {
          if (errEl) {
            errEl.innerText = 'Please create an initial password for this employee.';
            errEl.style.display = 'block';
          }
          return;
        }

        try {
          const res = await fetch('/api/employees/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email,
              password,
              full_name: name,
              department,
              adminId: this.currentUser.id
            })
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Failed to add employee');
          }
          if (succEl) {
            succEl.innerText = `✅ Employee "${email}" added to ${data.department || 'Calling Team'} with password successfully!`;
            succEl.style.display = 'block';
          }
          document.getElementById('new-emp-email').value = '';
          document.getElementById('new-emp-password').value = '';
          document.getElementById('new-emp-name').value = '';
          await this.fetchUsers();
          this.renderStaffModal('accounts');
        } catch (err) {
          if (errEl) {
            errEl.innerText = err.message;
            errEl.style.display = 'block';
          }
        }
      });
    }

    // Admin Outside Links Header Button
    const btnAdminOutsideLinks = document.getElementById('btn-admin-outside-links');
    if (btnAdminOutsideLinks) {
      btnAdminOutsideLinks.addEventListener('click', () => {
        this.renderStaffModal('outside-links');
        this.openModal('modal-profiles');
      });
    }

    // Outside Links Tab in Profiles Modal
    const tabAdminOutsideLinks = document.getElementById('tab-admin-outside-links');
    if (tabAdminOutsideLinks) {
      tabAdminOutsideLinks.addEventListener('click', () => {
        this.switchStaffModalTab('outside-links');
      });
    }

    // Copy Client Link Button
    const copyClientBtn = document.getElementById('btn-copy-client-link');
    if (copyClientBtn) {
      copyClientBtn.addEventListener('click', () => {
        const val = document.getElementById('outside-client-url-input').value;
        this.copyToClipboard(val);
      });
    }

    // Copy Employee Remote Link Button
    const copyEmpBtn = document.getElementById('btn-copy-emp-link');
    if (copyEmpBtn) {
      copyEmpBtn.addEventListener('click', () => {
        const val = document.getElementById('outside-emp-url-input').value;
        this.copyToClipboard(val);
      });
    }

    // Save Custom Public URL Button
    const savePublicUrlBtn = document.getElementById('btn-save-public-url');
    if (savePublicUrlBtn) {
      savePublicUrlBtn.addEventListener('click', () => {
        this.saveCustomPublicUrl();
      });
    }

    // New Chat / Channel Modal
    document.getElementById('btn-new-chat').addEventListener('click', () => {
      this.renderNewChatModal();
      this.openModal('modal-new-chat');
    });
    document.getElementById('btn-close-new-chat').addEventListener('click', () => {
      this.closeModal('modal-new-chat');
    });

    document.getElementById('tab-direct-chat').addEventListener('click', () => {
      document.getElementById('tab-direct-chat').classList.add('active');
      document.getElementById('tab-group-chat').classList.remove('active');
      document.getElementById('panel-direct-chat').style.display = 'block';
      document.getElementById('panel-group-chat').style.display = 'none';
    });

    document.getElementById('tab-group-chat').addEventListener('click', () => {
      document.getElementById('tab-group-chat').classList.add('active');
      document.getElementById('tab-direct-chat').classList.remove('active');
      document.getElementById('panel-group-chat').style.display = 'block';
      document.getElementById('panel-direct-chat').style.display = 'none';
    });

    // Employee assignment: Select All / Deselect All
    const selectAllBtn = document.getElementById('btn-group-select-all');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        document.querySelectorAll('#group-members-checkbox-list input[type="checkbox"]').forEach(cb => cb.checked = true);
      });
    }
    const deselectAllBtn = document.getElementById('btn-group-deselect-all');
    if (deselectAllBtn) {
      deselectAllBtn.addEventListener('click', () => {
        document.querySelectorAll('#group-members-checkbox-list input[type="checkbox"]').forEach(cb => cb.checked = false);
      });
    }

    // Create group channel form (Admin: Divide employees into groups)
    document.getElementById('form-create-group').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('group-name-input').value.trim();
      const desc = document.getElementById('group-desc-input').value.trim();
      if (!name) return;

      // Collect explicitly assigned employee IDs from checkboxes
      const selectedCheckboxes = document.querySelectorAll('#group-members-checkbox-list input[type="checkbox"]:checked');
      const memberIds = Array.from(selectedCheckboxes).map(cb => cb.value);

      try {
        const res = await fetch('/api/channels/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description: desc,
            creatorId: this.currentUser.id,
            memberIds
          })
        });
        const newChan = await res.json();
        if (!res.ok) throw new Error(newChan.error || 'Failed to create channel');
        this.closeModal('modal-new-chat');
        document.getElementById('group-name-input').value = '';
        document.getElementById('group-desc-input').value = '';
        await this.loadChannels();
        this.selectChannel(newChan.id);
      } catch (err) {
        alert('Failed to create channel: ' + err.message);
      }
    });

    // Admin Delete Active Channel Button (in chat header)
    const delActiveChanBtn = document.getElementById('btn-delete-active-channel');
    if (delActiveChanBtn) {
      delActiveChanBtn.addEventListener('click', () => {
        if (!this.activeChannel) return;
        this.confirmAndDeleteChannel(this.activeChannel.id, this.activeChannel.name);
      });
    }

    // Channel Details / Members Modal
    const membersInfoBtn = document.getElementById('btn-members-info');
    if (membersInfoBtn) {
      membersInfoBtn.addEventListener('click', () => {
        if (!this.activeChannel) return;
        this.renderChannelDetailsModal(this.activeChannel.id);
        this.openModal('modal-channel-details');
      });
    }
    const closeDetailsBtn = document.getElementById('btn-close-details');
    if (closeDetailsBtn) {
      closeDetailsBtn.addEventListener('click', () => {
        this.closeModal('modal-channel-details');
      });
    }

    // Admin Delete Channel from Details Modal
    const modalDelChanBtn = document.getElementById('btn-modal-delete-channel');
    if (modalDelChanBtn) {
      modalDelChanBtn.addEventListener('click', () => {
        if (!this.activeChannel) return;
        this.confirmAndDeleteChannel(this.activeChannel.id, this.activeChannel.name);
      });
    }

    // Admin Add Member to Channel button
    const addMemberBtn = document.getElementById('btn-add-member-to-group');
    if (addMemberBtn) {
      addMemberBtn.addEventListener('click', () => {
        const select = document.getElementById('select-add-member-employee');
        if (!select || !select.value || !this.activeChannel) return;
        this.addMemberToChannel(this.activeChannel.id, select.value);
      });
    }

    // Filter tabs in sidebar
    document.querySelectorAll('.filter-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFilter = btn.getAttribute('data-filter');
        this.renderChatList();
      });
    });

    // Search bar input
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search');
    searchInput.addEventListener('input', () => {
      clearBtn.style.display = searchInput.value ? 'block' : 'none';
      this.renderChatList();
    });
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      this.renderChatList();
    });

    // In-chat search toggle
    document.getElementById('btn-search-in-chat').addEventListener('click', () => {
      const bar = document.getElementById('inchat-search-bar');
      bar.style.display = bar.style.display === 'none' ? 'flex' : 'none';
      if (bar.style.display === 'flex') {
        document.getElementById('inchat-search-input').focus();
      }
    });
    document.getElementById('btn-close-inchat-search').addEventListener('click', () => {
      document.getElementById('inchat-search-bar').style.display = 'none';
      this.filterMessagesInChat('');
    });
    document.getElementById('inchat-search-input').addEventListener('input', (e) => {
      this.filterMessagesInChat(e.target.value.trim());
    });

    // Attachment menu toggle
    const attachBtn = document.getElementById('btn-attachment-toggle');
    const attachMenu = document.getElementById('attachment-menu');
    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachMenu.style.display = attachMenu.style.display === 'none' ? 'flex' : 'none';
    });

    document.addEventListener('click', (e) => {
      if (!attachBtn.contains(e.target) && !attachMenu.contains(e.target)) {
        attachMenu.style.display = 'none';
      }
    });

    // File inputs
    document.getElementById('file-input-doc').addEventListener('change', (e) => {
      attachMenu.style.display = 'none';
      if (e.target.files && e.target.files[0]) {
        this.uploadFile(e.target.files[0]);
        e.target.value = '';
      }
    });

    document.getElementById('file-input-img').addEventListener('change', (e) => {
      attachMenu.style.display = 'none';
      if (e.target.files && e.target.files[0]) {
        this.uploadFile(e.target.files[0]);
        e.target.value = '';
      }
    });

    // Emoji Picker Toggle
    const emojiBtn = document.getElementById('btn-emoji-toggle');
    const emojiPanel = document.getElementById('emoji-picker-panel');
    emojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      emojiPanel.style.display = emojiPanel.style.display === 'none' ? 'block' : 'none';
    });

    emojiPanel.querySelectorAll('.emoji-grid span').forEach(span => {
      span.addEventListener('click', () => {
        textInput.value += span.innerText;
        textInput.focus();
      });
    });

    document.addEventListener('click', (e) => {
      if (!emojiBtn.contains(e.target) && !emojiPanel.contains(e.target)) {
        emojiPanel.style.display = 'none';
      }
    });

    // Voice Note Recording
    const micBtn = document.getElementById('btn-mic-start');
    const voiceBar = document.getElementById('voice-recorder-bar');
    const timerLabel = document.getElementById('record-timer');

    micBtn.addEventListener('click', async () => {
      if (!this.activeChannel) return;
      const started = await window.audioController.startRecording((timeStr) => {
        timerLabel.innerText = timeStr;
      });
      if (started) {
        voiceBar.style.display = 'flex';
      }
    });

    document.getElementById('btn-cancel-voice').addEventListener('click', () => {
      window.audioController.cancelRecording();
      voiceBar.style.display = 'none';
    });

    document.getElementById('btn-send-voice').addEventListener('click', async () => {
      const audioBlob = await window.audioController.stopRecording();
      voiceBar.style.display = 'none';
      if (audioBlob && this.activeChannel) {
        const file = new File([audioBlob], `voice-note-${Date.now()}.webm`, { type: 'audio/webm' });
        this.uploadFile(file);
      }
    });

    // Lightbox close
    document.getElementById('btn-close-lightbox').addEventListener('click', () => {
      document.getElementById('modal-lightbox').style.display = 'none';
    });
  }

  triggerTyping() {
    if (!this.activeChannel) return;
    window.socketService.sendTypingStart(this.activeChannel.id, this.currentUser);
    clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => {
      window.socketService.sendTypingStop(this.activeChannel.id, this.currentUser.id);
    }, 2000);
  }

  filterMessagesInChat(query) {
    const bubbles = document.querySelectorAll('#messages-container .message-bubble');
    bubbles.forEach(b => {
      if (!query) {
        b.style.display = 'block';
        return;
      }
      const match = b.innerText.toLowerCase().includes(query.toLowerCase());
      b.style.display = match ? 'block' : 'none';
    });
  }

  renderStaffModal(defaultTab = 'accounts') {
    const list = document.getElementById('staff-grid-list');
    const isAdmin = (this.portalMode === 'admin' && this.currentUser && this.currentUser.role === 'Admin');

    // In Employee Portal, strictly show only employee accounts
    const usersToDisplay = (this.portalMode === 'employee')
      ? this.users.filter(u => u.role === 'Employee')
      : this.users;

    list.innerHTML = usersToDisplay.map(u => {
      const isCurrent = this.currentUser && this.currentUser.id === u.id;
      const roleBadge = u.role === 'Admin'
        ? '<span class="badge-role badge-admin">ADMIN</span>'
        : '<span class="badge-role badge-emp">EMPLOYEE</span>';

      const deptBadge = (u.role === 'Employee' && u.department)
        ? `<span class="badge-dept">${this.escapeHtml(u.department)}</span>`
        : '';

      const resetPassBtn = (isAdmin && u.role !== 'Admin')
        ? `<button class="btn-action-sm" title="Change Employee Password" style="padding:4px 8px; font-size:11.5px; background:var(--panel-bg); border:1px solid var(--border-color); border-radius:6px; cursor:pointer; color:var(--text-primary); margin-right:6px; font-weight:600; display:inline-flex; align-items:center; gap:4px;" onclick="event.stopPropagation(); window.appController.promptResetEmployeePassword('${u.id}', '${this.escapeHtml(u.full_name)}')"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg> Password</button>`
        : '';

      const deleteBtn = (isAdmin && u.role !== 'Admin')
        ? `<button class="btn-delete-item" title="Delete Employee" style="display:inline-flex; align-items:center; gap:4px;" onclick="event.stopPropagation(); window.appController.deleteEmployee('${u.id}', '${this.escapeHtml(u.email)}')"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg> Delete</button>`
        : '';

      return `
        <div class="staff-card ${isCurrent ? 'active' : ''}" onclick="window.appController.switchUserById('${u.id}')">
          ${this.getUserAvatarHtml(u, 20)}
          <div style="flex:1;">
            <div class="staff-card-name">${this.escapeHtml(u.full_name)} ${isCurrent ? '(Active)' : ''}</div>
            <div class="staff-card-role">${roleBadge} ${deptBadge} ${this.escapeHtml(u.email || '')}</div>
          </div>
          <div class="staff-card-actions" style="display:flex; align-items:center;">
            ${resetPassBtn}
            ${deleteBtn}
          </div>
        </div>
      `;
    }).join('');

    // Check admin permissions for add employee, department, and outside links tabs
    const formAdmin = document.getElementById('form-admin-add-employee');
    const noticeAdmin = document.getElementById('admin-add-restricted-notice');
    const tabAdminAddEmp = document.getElementById('tab-admin-add-emp');
    const tabAdminDepts = document.getElementById('tab-admin-depts');
    const tabAdminOutsideLinks = document.getElementById('tab-admin-outside-links');

    if (tabAdminAddEmp) tabAdminAddEmp.style.display = isAdmin ? 'block' : 'none';
    if (tabAdminDepts) tabAdminDepts.style.display = isAdmin ? 'block' : 'none';
    if (tabAdminOutsideLinks) tabAdminOutsideLinks.style.display = isAdmin ? 'block' : 'none';

    if (formAdmin && noticeAdmin) {
      if (isAdmin) {
        formAdmin.style.display = 'flex';
        noticeAdmin.style.display = 'none';
        this.renderDepartmentDropdown();
      } else {
        formAdmin.style.display = 'none';
        noticeAdmin.style.display = 'block';
      }
    }

    if (defaultTab === 'admin-add') {
      this.switchStaffModalTab('admin-add-emp');
    } else if (defaultTab === 'admin-depts') {
      this.switchStaffModalTab('admin-depts');
    } else if (defaultTab === 'outside-links') {
      this.switchStaffModalTab('outside-links');
    } else if (defaultTab === 'login-email') {
      this.switchStaffModalTab('login-email');
    } else {
      this.switchStaffModalTab('switch-acc');
    }
  }

  switchStaffModalTab(tabKey) {
    document.querySelectorAll('#modal-profiles .tab-pill').forEach(b => b.classList.remove('active'));
    document.getElementById('panel-switch-acc').style.display = 'none';
    const panelChangePass = document.getElementById('panel-change-pass');
    if (panelChangePass) panelChangePass.style.display = 'none';
    document.getElementById('panel-login-email').style.display = 'none';
    document.getElementById('panel-admin-add-emp').style.display = 'none';
    const panelDepts = document.getElementById('panel-admin-depts');
    if (panelDepts) panelDepts.style.display = 'none';
    const panelOutside = document.getElementById('panel-admin-outside-links');
    if (panelOutside) panelOutside.style.display = 'none';

    if (tabKey === 'change-pass') {
      const tabChangePass = document.getElementById('tab-change-pass');
      if (tabChangePass) tabChangePass.classList.add('active');
      if (panelChangePass) {
        panelChangePass.style.display = 'block';
        const currInput = document.getElementById('profiles-change-current-pass');
        if (currInput) currInput.focus();
      }
    } else if (tabKey === 'login-email') {
      document.getElementById('tab-login-email').classList.add('active');
      document.getElementById('panel-login-email').style.display = 'block';
      document.getElementById('input-login-email').focus();
    } else if (tabKey === 'admin-add-emp') {
      document.getElementById('tab-admin-add-emp').classList.add('active');
      document.getElementById('panel-admin-add-emp').style.display = 'block';
      this.renderDepartmentDropdown();
      document.getElementById('new-emp-email').focus();
    } else if (tabKey === 'admin-depts') {
      const tabDepts = document.getElementById('tab-admin-depts');
      if (tabDepts) tabDepts.classList.add('active');
      if (panelDepts) panelDepts.style.display = 'block';
      this.renderDepartmentsPanel();
    } else if (tabKey === 'outside-links') {
      const tabOutside = document.getElementById('tab-admin-outside-links');
      if (tabOutside) tabOutside.classList.add('active');
      if (panelOutside) panelOutside.style.display = 'block';
      this.loadOutsideLinks();
    } else {
      document.getElementById('tab-switch-acc').classList.add('active');
      document.getElementById('panel-switch-acc').style.display = 'block';
    }
  }

  async loadOutsideLinks() {
    if (!this.currentUser || this.currentUser.role !== 'Admin') return;
    try {
      const res = await fetch(`/api/admin/outside-links?adminId=${this.currentUser.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load outside links');

      document.getElementById('outside-client-url-input').value = data.clientLink;
      document.getElementById('outside-client-qr-img').src = data.clientQr;
      document.getElementById('btn-wa-client-link').href = `https://api.whatsapp.com/send?text=${encodeURIComponent('Hello! You can chat directly with our RegiusTax Calling & Tax Advisory Team here: ' + data.clientLink)}`;

      document.getElementById('outside-emp-url-input').value = data.employeeLink;
      document.getElementById('btn-wa-emp-link').href = `https://api.whatsapp.com/send?text=${encodeURIComponent('RegiusTax Team: Connect to RTwhat\'s up remotely here: ' + data.employeeLink)}`;

      document.getElementById('custom-public-url-input').value = data.baseUrl;
    } catch (err) {
      console.error('Error loading outside links:', err);
    }
  }

  async saveCustomPublicUrl() {
    if (!this.currentUser || this.currentUser.role !== 'Admin') return;
    const input = document.getElementById('custom-public-url-input');
    const feedback = document.getElementById('save-public-url-feedback');
    const newUrl = input.value.trim();

    try {
      const res = await fetch('/api/admin/outside-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: newUrl, adminId: this.currentUser.id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update outside domain');

      document.getElementById('outside-client-url-input').value = data.clientLink;
      document.getElementById('outside-client-qr-img').src = data.clientQr;
      document.getElementById('btn-wa-client-link').href = `https://api.whatsapp.com/send?text=${encodeURIComponent('Hello! You can chat directly with our RegiusTax Calling & Tax Advisory Team here: ' + data.clientLink)}`;

      document.getElementById('outside-emp-url-input').value = data.employeeLink;
      document.getElementById('btn-wa-emp-link').href = `https://api.whatsapp.com/send?text=${encodeURIComponent('RegiusTax Team: Connect to RTwhat\'s up remotely here: ' + data.employeeLink)}`;

      feedback.innerText = '✓ Domain saved! Both Client & Employee links have been updated.';
      feedback.style.display = 'block';
      setTimeout(() => feedback.style.display = 'none', 4000);
    } catch (err) {
      alert('Error updating outside domain: ' + err.message);
    }
  }

  renderDepartmentDropdown() {
    const select = document.getElementById('new-emp-department');
    if (!select) return;

    if (!this.departments || this.departments.length === 0) {
      this.departments = [
        { name: 'Calling Team' },
        { name: 'Preparation Team' },
        { name: 'Review Team' }
      ];
    }

    const currentVal = select.value;
    select.innerHTML = this.departments.map(d => {
      return `<option value="${this.escapeHtml(d.name)}">${this.escapeHtml(d.name)}</option>`;
    }).join('');

    if (currentVal && this.departments.some(d => d.name === currentVal)) {
      select.value = currentVal;
    }
  }

  renderDepartmentsPanel() {
    const list = document.getElementById('departments-list');
    if (!list) return;

    if (!this.departments || this.departments.length === 0) {
      list.innerHTML = `<div style="padding:12px; color:var(--text-muted); font-size:13px;">No departments found.</div>`;
      return;
    }

    const isAdmin = this.currentUser && this.currentUser.role === 'Admin';

    list.innerHTML = this.departments.map(d => {
      const empCount = this.users.filter(u => u.role === 'Employee' && u.department === d.name).length;

      const deleteBtn = isAdmin
        ? `<button class="btn-delete-dept" title="Delete Department" style="display:inline-flex; align-items:center; justify-content:center; padding:4px;" onclick="event.stopPropagation(); window.appController.deleteDepartment('${d.id}', '${this.escapeHtml(d.name)}')"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>`
        : '';

      return `
        <div class="dept-row-item">
          <div class="dept-row-name">
            <span style="display:inline-flex; align-items:center; color:var(--rt-indigo);"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>
            <span>${this.escapeHtml(d.name)}</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="dept-row-count">${empCount} ${empCount === 1 ? 'employee' : 'employees'}</span>
            ${deleteBtn}
          </div>
        </div>
      `;
    }).join('');
  }

  async deleteDepartment(deptId, deptName) {
    if (!confirm(`Are you sure you want to delete department "${deptName}"?\n\nAny employees in this department will be moved to another department, and its team room channel will be deleted.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/departments/${deptId}?adminId=${this.currentUser.id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete department');
      this.handleDepartmentDeleted(data);
    } catch (err) {
      alert('Error deleting department: ' + err.message);
    }
  }

  handleDepartmentDeleted(data) {
    const deptId = data.deletedId || data.departmentId;
    const deptName = data.deletedName || data.departmentName;
    const fallbackDept = data.fallbackDept;

    this.departments = this.departments.filter(d => d.id !== deptId && d.name.toLowerCase() !== (deptName || '').toLowerCase());

    // Update affected local users
    if (deptName && fallbackDept) {
      this.users.forEach(u => {
        if (u.department && u.department.toLowerCase() === deptName.toLowerCase()) {
          u.department = fallbackDept;
        }
      });
    }

    if (data.deletedChannelId) {
      this.handleChannelDeleted(data.deletedChannelId);
    }

    this.renderDepartmentDropdown();
    this.renderDepartmentsPanel();
    this.renderStaffModal();
    this.loadChannels();
  }

  handleDepartmentAdded(newDept) {
    if (!this.departments.some(d => d.id === newDept.id || d.name.toLowerCase() === newDept.name.toLowerCase())) {
      this.departments.push(newDept);
    }
    this.renderDepartmentDropdown();
    this.renderDepartmentsPanel();
  }

  handleEmployeeUpdated(updatedUser) {
    const idx = this.users.findIndex(u => u.id === updatedUser.id);
    if (idx !== -1) {
      this.users[idx] = updatedUser;
    } else {
      this.users.push(updatedUser);
    }
    if (this.currentUser && this.currentUser.id === updatedUser.id) {
      this.currentUser = updatedUser;
      this.renderCurrentUserHeader();
    }
    this.renderStaffModal();
    this.loadChannels();
  }

  handleEmployeeAdded(newEmp) {
    if (!this.users.find(u => u.id === newEmp.id)) {
      this.users.push(newEmp);
      this.renderStaffModal();
      this.loadChannels();
    }
  }

  async deleteEmployee(employeeId, employeeEmail) {
    if (!confirm(`Are you sure you want to delete employee "${employeeEmail}"?\n\nTheir access and account will be revoked immediately.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/employees/${employeeId}?adminId=${this.currentUser.id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete employee');
      this.handleEmployeeDeleted(employeeId);
    } catch (err) {
      alert('Error deleting employee: ' + err.message);
    }
  }

  handleEmployeeDeleted(employeeId) {
    this.users = this.users.filter(u => u.id !== employeeId);
    if (this.currentUser && this.currentUser.id === employeeId) {
      alert('Your account was deleted by Admin.');
      const adminUser = this.users.find(u => u.role === 'Admin');
      if (adminUser) this.switchUser(adminUser);
      return;
    }
    this.renderStaffModal();
    this.loadChannels();
  }

  openChangePasswordModal() {
    if (!this.currentUser) {
      this.showAuthLoginModal();
      return;
    }

    const label = document.getElementById('change-pass-user-label');
    if (label) {
      label.innerText = `${this.currentUser.full_name} (${this.currentUser.email}) • ${this.currentUser.role}`;
    }

    const currentInput = document.getElementById('input-change-current-pass');
    const newInput = document.getElementById('input-change-new-pass');
    const confirmInput = document.getElementById('input-change-confirm-pass');
    const errEl = document.getElementById('change-pass-error');
    const succEl = document.getElementById('change-pass-success');

    if (currentInput) currentInput.value = '';
    if (newInput) newInput.value = '';
    if (confirmInput) confirmInput.value = '';
    if (errEl) errEl.style.display = 'none';
    if (succEl) succEl.style.display = 'none';

    this.openModal('modal-change-password');
    if (currentInput) currentInput.focus();
  }

  async submitChangeOwnPassword(currentPassword, newPassword, confirmPassword, formType = 'modal') {
    const errEl = (formType === 'profiles')
      ? document.getElementById('profiles-change-pass-error')
      : document.getElementById('change-pass-error');
    const succEl = (formType === 'profiles')
      ? document.getElementById('profiles-change-pass-success')
      : document.getElementById('change-pass-success');

    if (errEl) errEl.style.display = 'none';
    if (succEl) succEl.style.display = 'none';

    if (!currentPassword) {
      if (errEl) {
        errEl.innerText = 'Please enter your current password.';
        errEl.style.display = 'block';
      }
      return;
    }

    if (!newPassword || newPassword.length < 3) {
      if (errEl) {
        errEl.innerText = 'New password must be at least 3 characters.';
        errEl.style.display = 'block';
      }
      return;
    }

    if (newPassword !== confirmPassword) {
      if (errEl) {
        errEl.innerText = 'New password and Confirm password do not match.';
        errEl.style.display = 'block';
      }
      return;
    }

    try {
      const res = await fetch('/api/users/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.currentUser.id,
          currentPassword,
          newPassword
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update password');
      }

      if (succEl) {
        succEl.innerText = '✅ Password updated successfully! Please use this new password next time you log in.';
        succEl.style.display = 'block';
      }

      if (formType === 'modal') {
        const cIn = document.getElementById('input-change-current-pass');
        const nIn = document.getElementById('input-change-new-pass');
        const confIn = document.getElementById('input-change-confirm-pass');
        if (cIn) cIn.value = '';
        if (nIn) nIn.value = '';
        if (confIn) confIn.value = '';
        setTimeout(() => {
          this.closeModal('modal-change-password');
        }, 1800);
      } else {
        const cIn = document.getElementById('profiles-change-current-pass');
        const nIn = document.getElementById('profiles-change-new-pass');
        const confIn = document.getElementById('profiles-change-confirm-pass');
        if (cIn) cIn.value = '';
        if (nIn) nIn.value = '';
        if (confIn) confIn.value = '';
      }
    } catch (err) {
      if (errEl) {
        errEl.innerText = `⚠️ ${err.message}`;
        errEl.style.display = 'block';
      }
    }
  }

  async promptResetEmployeePassword(employeeId, employeeName) {
    if (!this.currentUser || this.currentUser.role !== 'Admin') {
      alert('Only Admin can reset employee passwords.');
      return;
    }
    const newPassword = prompt(`Admin Action: Enter new password for ${employeeName}:`);
    if (!newPassword || !newPassword.trim()) {
      return;
    }

    try {
      const res = await fetch(`/api/employees/${employeeId}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: newPassword.trim(),
          adminId: this.currentUser.id
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update password');
      }
      alert(`✅ ${data.message || 'Password updated successfully!'}`);
    } catch (err) {
      alert(`⚠️ Error updating password: ${err.message}`);
    }
  }

  async switchUserById(userId) {
    const user = this.users.find(u => u.id === userId);
    if (!user) return;
    if (this.currentUser && this.currentUser.id === user.id) {
      this.closeModal('modal-profiles');
      return;
    }

    if (this.portalMode === 'employee' && user.role !== 'Employee') {
      alert('This is the Employee Portal. To access Admin privileges, please visit the Admin Portal (/admin).');
      return;
    }

    const enteredPassword = prompt(`Password required to sign into ${user.full_name} (${user.email}):`);
    if (!enteredPassword) return;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          password: enteredPassword.trim(),
          portalMode: this.portalMode
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Incorrect password.');
      }
      localStorage.setItem('rtwhatsup_auth_' + this.portalMode, JSON.stringify(data.user));
      this.switchUser(data.user);
    } catch (err) {
      alert(`⚠️ Authentication Failed: ${err.message}`);
    }
  }

  renderNewChatModal() {
    const isAdmin = this.currentUser && this.currentUser.role === 'Admin';
    const tabGroupChat = document.getElementById('tab-group-chat');
    const noticeAdmin = document.getElementById('admin-group-restricted-notice');
    const formCreateGroup = document.getElementById('form-create-group');

    if (isAdmin) {
      tabGroupChat.style.display = 'block';
      if (noticeAdmin) noticeAdmin.style.display = 'none';
      if (formCreateGroup) formCreateGroup.style.display = 'block';

      // Render employee assignment checkboxes for dividing groups
      const employeeCheckList = document.getElementById('group-members-checkbox-list');
      const employees = this.users.filter(u => u.role === 'Employee');

      if (employees.length === 0) {
        employeeCheckList.innerHTML = `
          <div style="padding:10px; color:var(--text-muted); font-size:12.5px; text-align:center;">
            No employees registered yet. You can create this channel now and assign employees after registering them.
          </div>
        `;
      } else {
        employeeCheckList.innerHTML = employees.map(emp => `
          <label class="emp-check-item">
            <input type="checkbox" value="${emp.id}" checked>
            ${this.getUserAvatarHtml(emp, 16)}
            <div class="emp-check-info">
              <span class="emp-check-name">${this.escapeHtml(emp.full_name)} <span class="badge-dept" style="font-size:10px; margin-left:4px;">${this.escapeHtml(emp.department || 'Calling Team')}</span></span>
              <span class="emp-check-email">${this.escapeHtml(emp.email)}</span>
            </div>
          </label>
        `).join('');
      }
    } else {
      if (noticeAdmin) noticeAdmin.style.display = 'block';
      if (formCreateGroup) formCreateGroup.style.display = 'none';
      document.getElementById('tab-direct-chat').click();
      tabGroupChat.style.display = 'none';
    }

    // Direct message colleagues list
    const list = document.getElementById('colleagues-selection-list');
    const colleagues = this.users.filter(u => u.id !== this.currentUser.id);

    if (colleagues.length === 0) {
      const addEmpBtn = isAdmin
        ? `<div style="margin-top:12px;"><button class="btn-primary btn-sm" style="display:inline-flex; align-items:center; gap:6px;" onclick="window.appController.renderStaffModal('admin-add'); window.appController.openModal('modal-profiles'); window.appController.closeModal('modal-new-chat');"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Add Employee by Email</button></div>`
        : `<div style="margin-top:8px; font-size:12px; color:var(--text-muted);">Please ask Admin to add your colleagues' emails.</div>`;
      list.innerHTML = `
        <div style="padding:24px; text-align:center; color:var(--text-secondary); font-size:13.5px;">
          No other colleagues registered yet.
          ${addEmpBtn}
        </div>
      `;
      return;
    }

    list.innerHTML = colleagues.map(u => {
      const roleBadge = u.role === 'Admin'
        ? '<span class="badge-role badge-admin">ADMIN</span>'
        : '<span class="badge-role badge-emp">EMPLOYEE</span>';
      const deptBadge = u.department ? `<span class="badge-dept" style="font-size:10px; margin-left:4px;">${this.escapeHtml(u.department)}</span>` : '';
      return `
        <div class="colleague-item" onclick="window.appController.startDirectMessage('${u.id}')">
          ${this.getUserAvatarHtml(u, 20)}
          <div>
            <div style="font-weight:600; font-size:14px;">${this.escapeHtml(u.full_name)}</div>
            <div style="font-size:12px; color:var(--text-secondary);">${roleBadge} ${deptBadge} ${this.escapeHtml(u.email || '')}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  async confirmAndDeleteChannel(channelId, channelName) {
    if (!confirm(`Are you sure you want to delete channel "${channelName}"?\n\nAll messages, documents and media will be permanently deleted.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/channels/${channelId}?adminId=${this.currentUser.id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete channel');
      this.closeModal('modal-channel-details');
      this.handleChannelDeleted(channelId);
    } catch (err) {
      alert('Error deleting channel: ' + err.message);
    }
  }

  handleChannelDeleted(channelId) {
    this.channels = this.channels.filter(c => c.id !== channelId);
    if (this.activeChannel && this.activeChannel.id === channelId) {
      this.activeChannel = null;
      document.getElementById('active-conversation').style.display = 'none';
      document.getElementById('welcome-screen').style.display = 'flex';
      document.querySelector('.messenger-box').classList.remove('mobile-chat-active');
    }
    this.renderChatList();
  }

  async renderChannelDetailsModal(channelId) {
    try {
      const res = await fetch(`/api/channels/${channelId}?userId=${this.currentUser.id}`);
      const channel = await res.json();
      document.getElementById('channel-details-name').innerText = channel.name;
      document.getElementById('channel-details-desc').innerText = channel.description || 'No description provided';
      document.getElementById('channel-member-count').innerText = (channel.members || []).length;

      const isAdmin = this.currentUser && this.currentUser.role === 'Admin';
      const isDirect = channel.is_direct;

      const membersContainer = document.getElementById('channel-details-members');
      membersContainer.innerHTML = (channel.members || []).map(m => {
        const isSelf = this.currentUser.id === m.id;
        const roleBadge = m.role === 'Admin'
          ? '<span class="badge-role badge-admin">ADMIN</span>'
          : '<span class="badge-role badge-emp">EMPLOYEE</span>';
        const deptBadge = m.department ? `<span class="badge-dept" style="font-size:10px; margin-left:4px;">${this.escapeHtml(m.department)}</span>` : '';
        const removeBtn = (isAdmin && !isDirect && m.role !== 'Admin')
          ? `<button class="btn-remove-member" title="Remove from group" style="display:inline-flex; align-items:center; gap:4px;" onclick="window.appController.removeMemberFromChannel('${channel.id}', '${m.id}')"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> Remove</button>`
          : '';
        return `
          <div class="member-item-row">
            <div class="member-item-info">
              ${this.getUserAvatarHtml(m, 18)}
              <div>
                <div style="font-weight:600; font-size:13px;">${this.escapeHtml(m.full_name)} ${isSelf ? '(You)' : ''}</div>
                <div style="font-size:11px; color:var(--text-secondary);">${roleBadge} ${deptBadge} ${this.escapeHtml(m.email || '')}</div>
              </div>
            </div>
            ${removeBtn}
          </div>
        `;
      }).join('');

      // Add Member section for Admin
      const addMemberBox = document.getElementById('channel-admin-add-member-box');
      const dangerBox = document.getElementById('channel-admin-danger-box');

      if (isAdmin && !isDirect) {
        const memberIds = new Set((channel.members || []).map(m => m.id));
        const nonMembers = this.users.filter(u => !memberIds.has(u.id) && u.role === 'Employee');

        const select = document.getElementById('select-add-member-employee');
        if (nonMembers.length > 0) {
          select.innerHTML = nonMembers.map(u => `<option value="${u.id}">${this.escapeHtml(u.full_name)} [${this.escapeHtml(u.department || 'Calling Team')}] (${this.escapeHtml(u.email)})</option>`).join('');
          addMemberBox.style.display = 'block';
        } else {
          select.innerHTML = `<option value="">All employees are already in this group</option>`;
          addMemberBox.style.display = 'none';
        }

        dangerBox.style.display = 'block';
      } else {
        addMemberBox.style.display = 'none';
        dangerBox.style.display = 'none';
      }
    } catch (err) {
      console.error('Error rendering channel details:', err);
    }
  }

  async addMemberToChannel(channelId, userId) {
    try {
      const res = await fetch(`/api/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, adminId: this.currentUser.id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add member');
      await this.renderChannelDetailsModal(channelId);
      await this.loadChannels();
    } catch (err) {
      alert('Error adding member: ' + err.message);
    }
  }

  async removeMemberFromChannel(channelId, userId) {
    if (!confirm('Remove this employee from the group?')) return;
    try {
      const res = await fetch(`/api/channels/${channelId}/members/${userId}?adminId=${this.currentUser.id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove member');
      await this.renderChannelDetailsModal(channelId);
      await this.loadChannels();
    } catch (err) {
      alert('Error removing member: ' + err.message);
    }
  }

  handleStatusUpdate(data) {
    const user = this.users.find(u => u.id === data.userId);
    if (user) user.status = data.status;
    if (this.currentUser && this.currentUser.id === data.userId) {
      this.currentUser.status = data.status;
      this.renderCurrentUserHeader();
    }
    if (this.activeChannel && this.activeChannel.is_direct && this.activeChannel.direct_user && this.activeChannel.direct_user.id === data.userId) {
      this.activeChannel.direct_user.status = data.status;
      const isAway = (data.status || '').toLowerCase().includes('unavailable');
      const headerStatus = document.getElementById('chat-header-status');
      if (headerStatus) {
        headerStatus.innerHTML = isAway 
          ? '<span style="color:#ea4335; font-weight:600; display:inline-flex; align-items:center; gap:5px;"><span class="status-dot" style="width:7px; height:7px; background:#ea4335; border-radius:50%; display:inline-block;"></span> Unavailable (Away from desk)</span>' 
          : (this.activeChannel.direct_user.isOnline ? 'Online' : 'Offline');
      }
    }
    this.renderChatList();
  }

  handleMessagesRead(data) {
    if (this.activeChannel && this.activeChannel.id === data.channelId) {
      document.querySelectorAll('.message-bubble.outgoing .checkmarks').forEach(cm => {
        cm.classList.add('read');
      });
    }
  }

  async startDirectMessage(colleagueId) {
    try {
      const res = await fetch('/api/channels/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user1Id: this.currentUser.id,
          user2Id: colleagueId
        })
      });
      const channel = await res.json();
      this.closeModal('modal-new-chat');
      await this.loadChannels();
      this.selectChannel(channel.id);
    } catch (err) {
      alert('Error opening direct chat: ' + err.message);
    }
  }

  openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'flex';
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
  }

  copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      alert('Copied to clipboard: ' + text);
    } else {
      prompt('Copy this URL:', text);
    }
  }

  // ==========================================================================
  // WORK ASSISTANCE TRACKER
  // Employee -> WhatsApp Group -> HR/Coordinator -> Assign -> Track -> Complete -> Confirm -> Close
  // ==========================================================================

  async openWorkTrackerModal() {
    this.openModal('modal-work-tracker');
    const btnClearTracker = document.getElementById('btn-admin-clear-tracker');
    if (btnClearTracker) {
      btnClearTracker.style.display = (this.currentUser && this.currentUser.role === 'Admin') ? 'inline-flex' : 'none';
    }
    await this.loadWorkTracker();
    await this.loadWorkTrackerStats();
  }

  async adminClearAllWorkRequests() {
    if (!this.currentUser || this.currentUser.role !== 'Admin') {
      alert('Only an Administrator can clear all work tracker requests.');
      return;
    }

    const conf = confirm(
      '⚠️ ARE YOU SURE YOU WANT TO CLEAR ALL TRACKER REQUESTS?\n\n' +
      'This will delete all test requests from the Work Assistance Tracker.\n' +
      'New requests will start fresh from WA-001.\n\n' +
      'A safety backup will be created automatically before wiping.\n\n' +
      'Click OK to proceed with Go-Live wipe.'
    );
    if (!conf) return;

    try {
      // 1. Safety backup
      await fetch('/api/backup/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'pre_live_wipe', note: 'Safety snapshot before tracker requests wipe' })
      });

      // 2. Clear tracker requests
      const res = await fetch('/api/tracker/clear-all-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: this.currentUser.id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clear requests');

      // 3. Reload tracker UI
      await this.loadWorkTracker();
      await this.loadWorkTrackerStats();
      if (typeof this.loadBackupStatus === 'function') {
        this.loadBackupStatus();
      }

      alert('🚀 TRACKER CLEAN SLATE COMPLETE!\n\nAll test work requests have been cleared.\nThe next request raised will start from WA-001.');
    } catch (err) {
      alert('Error clearing requests: ' + err.message);
    }
  }

  async loadWorkTracker() {
    const listEl = document.getElementById('tracker-requests-list');
    if (listEl) {
      listEl.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-secondary);">⏳ Loading work assistance requests...</div>';
    }

    try {
      const params = new URLSearchParams();
      if (this.trackerFilterStatus && this.trackerFilterStatus !== 'All') {
        params.append('status', this.trackerFilterStatus);
      }
      if (this.trackerFilterTeam && this.trackerFilterTeam !== 'All') {
        params.append('assigned_team', this.trackerFilterTeam);
      }
      if (this.trackerFilterPriority && this.trackerFilterPriority !== 'All') {
        params.append('priority', this.trackerFilterPriority);
      }
      if (this.trackerSearch) {
        params.append('search', this.trackerSearch);
      }

      const res = await fetch(`/api/tracker/requests?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load requests');
      const data = await res.json();
      this.workRequests = data;
      this.updateActiveMetricCardIndicator();
      this.renderWorkTrackerList(data);
      this.loadWorkTrackerStats();
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = `<div style="text-align:center; padding:30px; color:#ea4335;">Failed to load requests: ${this.escapeHtml(err.message)}</div>`;
      }
    }
  }

  updateActiveMetricCardIndicator() {
    const cards = document.querySelectorAll('.tracker-metric-card');
    cards.forEach(c => {
      c.classList.remove('active-metric-card', 'active-metric-urgent', 'active-metric-inprogress', 'active-metric-completed', 'active-metric-closed');
    });

    if (this.trackerFilterPriority === 'Urgent') {
      const urgentCard = document.getElementById('tracker-card-urgent');
      if (urgentCard) urgentCard.classList.add('active-metric-urgent');
    } else if (this.trackerFilterStatus === 'In Progress') {
      const inprogCard = document.getElementById('tracker-card-inprogress');
      if (inprogCard) inprogCard.classList.add('active-metric-inprogress');
    } else if (this.trackerFilterStatus === 'Completed') {
      const compCard = document.getElementById('tracker-card-completed');
      if (compCard) compCard.classList.add('active-metric-completed');
    } else if (this.trackerFilterStatus === 'Closed') {
      const closedCard = document.getElementById('tracker-card-closed');
      if (closedCard) closedCard.classList.add('active-metric-closed');
    } else if ((!this.trackerFilterStatus || this.trackerFilterStatus === 'All') && (!this.trackerFilterPriority || this.trackerFilterPriority === 'All')) {
      const totalCard = document.getElementById('tracker-card-total');
      if (totalCard) totalCard.classList.add('active-metric-card');
    }
  }

  applyTrackerMetricFilter(type) {
    const prioritySelect = document.getElementById('tracker-filter-priority');
    const statusTabs = document.querySelectorAll('#tracker-status-tabs .pill-filter');
    const searchInput = document.getElementById('tracker-search-input');

    if (searchInput) {
      searchInput.value = '';
      this.trackerSearch = '';
    }

    if (type === 'total') {
      // Show ALL requests: reset status & priority
      this.trackerFilterStatus = 'All';
      this.trackerFilterPriority = 'All';
      if (prioritySelect) prioritySelect.value = 'All';
      statusTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-status') === 'All'));
    } else if (type === 'urgent') {
      // Filter Urgent requests: priority = Urgent
      this.trackerFilterStatus = 'All';
      this.trackerFilterPriority = 'Urgent';
      if (prioritySelect) prioritySelect.value = 'Urgent';
      statusTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-status') === 'All'));
    } else if (type === 'inprogress') {
      // Filter In Progress requests
      this.trackerFilterStatus = 'In Progress';
      this.trackerFilterPriority = 'All';
      if (prioritySelect) prioritySelect.value = 'All';
      statusTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-status') === 'In Progress'));
    } else if (type === 'completed') {
      // Filter Completed requests
      this.trackerFilterStatus = 'Completed';
      this.trackerFilterPriority = 'All';
      if (prioritySelect) prioritySelect.value = 'All';
      statusTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-status') === 'Completed'));
    } else if (type === 'closed') {
      // Filter Closed requests
      this.trackerFilterStatus = 'Closed';
      this.trackerFilterPriority = 'All';
      if (prioritySelect) prioritySelect.value = 'All';
      statusTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-status') === 'Closed'));
    }

    this.updateActiveMetricCardIndicator();
    this.loadWorkTracker();
  }

  async loadWorkTrackerStats() {
    try {
      const res = await fetch('/api/tracker/stats');
      if (!res.ok) return;
      const stats = await res.json();
      this.trackerStats = stats;

      const totalEl = document.getElementById('tracker-metric-total');
      const urgentEl = document.getElementById('tracker-metric-urgent');
      const inProgEl = document.getElementById('tracker-metric-inprogress');
      const compEl = document.getElementById('tracker-metric-completed');
      const closedEl = document.getElementById('tracker-metric-closed');
      const headerDot = document.getElementById('tracker-header-dot');

      if (totalEl) totalEl.innerText = stats.total;
      if (urgentEl) urgentEl.innerText = stats.urgent;
      if (inProgEl) inProgEl.innerText = stats.inProgress;
      if (compEl) compEl.innerText = stats.completed;
      if (closedEl) closedEl.innerText = stats.closed;

      if (headerDot) {
        headerDot.style.display = (stats.urgent > 0 || stats.inProgress > 0) ? 'block' : 'none';
      }
    } catch (err) {
      console.error('Error loading tracker stats:', err);
    }
  }

  renderWorkTrackerList(requests) {
    const listEl = document.getElementById('tracker-requests-list');
    if (!listEl) return;

    // Filter feedback banner
    let filterBanner = '';
    const isFiltered = (this.trackerFilterStatus && this.trackerFilterStatus !== 'All') ||
                       (this.trackerFilterPriority && this.trackerFilterPriority !== 'All') ||
                       (this.trackerFilterTeam && this.trackerFilterTeam !== 'All') ||
                       this.trackerSearch;

    if (isFiltered) {
      let filterDesc = [];
      if (this.trackerFilterPriority && this.trackerFilterPriority !== 'All') {
        filterDesc.push(`Priority: <strong>${this.escapeHtml(this.trackerFilterPriority)}</strong>`);
      }
      if (this.trackerFilterStatus && this.trackerFilterStatus !== 'All') {
        filterDesc.push(`Status: <strong>${this.escapeHtml(this.trackerFilterStatus)}</strong>`);
      }
      if (this.trackerFilterTeam && this.trackerFilterTeam !== 'All') {
        filterDesc.push(`Team: <strong>${this.escapeHtml(this.trackerFilterTeam)}</strong>`);
      }
      if (this.trackerSearch) {
        filterDesc.push(`Search: "<em>${this.escapeHtml(this.trackerSearch)}</em>"`);
      }

      filterBanner = `
        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,168,132,0.08); border:1px solid rgba(0,168,132,0.25); border-radius:8px; padding:8px 14px; margin-bottom:12px; font-size:12.5px;">
          <div style="display:flex; align-items:center; gap:6px; color:var(--text-primary);">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            <span><strong>Filtered View:</strong> ${filterDesc.join(' • ')} — Showing <strong>${requests ? requests.length : 0}</strong> matching request(s)</span>
          </div>
          <button type="button" onclick="window.appController.applyTrackerMetricFilter('total')" style="background:none; border:none; color:var(--rt-emerald); font-weight:700; cursor:pointer; font-size:12px; padding:2px 8px; display:inline-flex; align-items:center; gap:4px;">
            ✕ Reset Filter (Show All)
          </button>
        </div>
      `;
    }

    if (!requests || requests.length === 0) {
      listEl.innerHTML = `
        ${filterBanner}
        <div style="text-align:center; padding:40px 20px; background:var(--panel-header-bg); border-radius:10px; border:1px dashed var(--border-color);">
          <div style="display:inline-flex; align-items:center; justify-content:center; color:var(--text-muted); margin-bottom:10px;">
            <svg viewBox="0 0 24 24" width="42" height="42" fill="currentColor"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm-2 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
          </div>
          <div style="font-weight:600; font-size:15px; color:var(--text-primary); margin-bottom:4px;">No Assistance Requests Found</div>
          <div style="font-size:12.5px; color:var(--text-secondary); margin-bottom:14px;">No requests match the selected filters or search query.</div>
          <div style="display:flex; justify-content:center; gap:8px;">
            <button class="btn-secondary" onclick="window.appController.applyTrackerMetricFilter('total')" style="padding:7px 14px; font-size:12.5px; font-weight:600; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg> Show All Requests
            </button>
            <button class="btn-primary" onclick="window.appController.openNewWorkRequestModal()" style="padding:7px 14px; font-size:12.5px; font-weight:600; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Create New Request
            </button>
          </div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filterBanner + requests.map(req => {
      // Priority badge
      let priorityClass = 'badge-priority-normal';
      if (req.priority === 'Urgent') {
        priorityClass = 'badge-priority-urgent';
      } else if (req.priority === 'High') {
        priorityClass = 'badge-priority-high';
      }

      // Status badge
      let statusClass = 'status-new';
      if (req.status === 'Assigned') statusClass = 'status-assigned';
      else if (req.status === 'In Progress') statusClass = 'status-inprogress';
      else if (req.status === 'Waiting') statusClass = 'status-waiting';
      else if (req.status === 'Completed') statusClass = 'status-completed';
      else if (req.status === 'Closed') statusClass = 'status-closed';

      // Card priority border class
      const cardPriorityClass = `priority-${req.priority.toLowerCase()}`;

      // Source badge icon
      const sourceIcon = req.source.toLowerCase().includes('whatsapp')
        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="vertical-align:text-bottom;"><path d="M17.472 14.382c-.301-.15-1.782-.879-2.058-.98-.276-.1-.476-.15-.677.15-.2.301-.776.98-.952 1.18-.175.2-.351.226-.652.075-.3-.151-1.267-.467-2.414-1.49-.893-.796-1.496-1.78-1.672-2.08-.175-.3-.019-.463.131-.613.136-.134.301-.351.451-.527.15-.175.2-.3.3-.5.1-.2.05-.376-.025-.526-.075-.15-.677-1.63-.927-2.232-.244-.587-.492-.507-.677-.516-.175-.009-.376-.011-.577-.011s-.526.075-.802.376c-.276.301-1.053 1.028-1.053 2.508 0 1.48 1.078 2.909 1.229 3.109.15.2 2.122 3.24 5.141 4.544.718.31 1.279.496 1.716.635.721.23 1.377.197 1.896.12.578-.087 1.782-.728 2.033-1.431.25-.702.25-1.304.175-1.43-.075-.127-.276-.202-.577-.353z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="vertical-align:text-bottom;"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';

      // Employee confirmed badge
      let confirmHtml = '';
      if (req.employee_confirmed) {
        confirmHtml = `
          <div style="display:inline-flex; align-items:center; gap:5px; font-size:11.5px; color:#0b6e4f; background:rgba(0,174,82,0.1); border:1px solid rgba(0,174,82,0.25); padding:3px 8px; border-radius:6px; font-weight:600;">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Resolution Confirmed
          </div>
        `;
      } else if (req.status === 'Completed') {
        confirmHtml = `
          <div style="display:inline-flex; align-items:center; gap:5px; font-size:11.5px; color:#d97706; background:rgba(242,153,74,0.12); border:1px solid rgba(242,153,74,0.3); padding:3px 8px; border-radius:6px; font-weight:600;">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg> Awaiting Confirmation
          </div>
        `;
      }

      // Closed info
      let closedInfoHtml = '';
      if (req.status === 'Closed' && req.closed_at) {
        closedInfoHtml = `
          <div style="margin-top:4px; font-size:12px; color:var(--text-secondary); background:var(--panel-header-bg); padding:6px 10px; border-radius:6px; border:1px solid var(--border-color); display:flex; flex-direction:column; gap:3px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
              <span><strong>Closed on ${this.escapeHtml(req.closed_at)}</strong> by <strong>${this.escapeHtml(req.closed_by_name || 'Coordinator')}</strong></span>
            </div>
            ${req.resolution_notes ? `<div style="color:var(--text-primary); font-size:11.5px; margin-left:19px;"><em>Resolution:</em> ${this.escapeHtml(req.resolution_notes)}</div>` : ''}
          </div>
        `;
      }

      // Status pipeline step pills
      const steps = ['New', 'Assigned', 'In Progress', 'Waiting', 'Completed', 'Closed'];
      const pipelineHtml = `
        <div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap; margin: 6px 0;">
          ${steps.map(s => {
            const isActive = (req.status === s);
            return `<span class="tracker-pipeline-step ${isActive ? 'active-step' : ''}">${s}</span>`;
          }).join('<span style="color:var(--text-muted); font-size:10px;">➔</span>')}
        </div>
      `;

      // Status selector options
      const statusSelectHtml = `
        <select onchange="window.appController.updateRequestStatus('${req.id}', this.value)" style="padding:4px 8px; font-size:12px; font-weight:600; border-radius:6px; border:1px solid var(--border-color); background:var(--panel-bg); color:var(--text-primary); cursor:pointer;">
          <option value="New" ${req.status === 'New' ? 'selected' : ''}>New</option>
          <option value="Assigned" ${req.status === 'Assigned' ? 'selected' : ''}>Assigned</option>
          <option value="In Progress" ${req.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
          <option value="Waiting" ${req.status === 'Waiting' ? 'selected' : ''}>Waiting</option>
          <option value="Completed" ${req.status === 'Completed' ? 'selected' : ''}>Completed</option>
          <option value="Closed" ${req.status === 'Closed' ? 'selected' : ''}>Closed</option>
        </select>
      `;

      // Team selector options
      const teams = ['IT', 'HR', 'Admin', 'Calling Team', 'Preparation Team', 'Review Team'];
      const teamSelectHtml = `
        <select onchange="window.appController.updateRequestTeam('${req.id}', this.value)" style="padding:4px 8px; font-size:12px; font-weight:600; border-radius:6px; border:1px solid var(--border-color); background:var(--panel-bg); color:var(--text-primary); cursor:pointer;">
          ${teams.map(t => `<option value="${t}" ${req.assigned_team === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      `;

      // Action buttons
      // 1. WhatsApp Copy Update
      const btnWaCopy = `
        <button class="btn-wa-copy" onclick="window.appController.copyWhatsAppUpdate('${req.id}')" title="Copy formatted update to paste in WhatsApp group" style="display:inline-flex; align-items:center; gap:5px;">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy WA Update
        </button>
      `;

      // 2. Employee Confirm Resolution
      const btnConfirm = (!req.employee_confirmed && req.status !== 'Closed') ? `
        <button class="btn-tracker-confirm" onclick="window.appController.confirmRequestResolution('${req.id}')" title="Employee confirms issue is resolved" style="display:inline-flex; align-items:center; gap:5px;">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Confirm Resolution
        </button>
      ` : '';

      // 3. Close Request
      const btnClose = (req.status !== 'Closed') ? `
        <button class="btn-tracker-close" onclick="window.appController.openCloseRequestModal('${req.id}')" title="Close and record resolution" style="display:inline-flex; align-items:center; gap:5px;">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg> Close
        </button>
      ` : '';

      return `
        <div class="tracker-card ${cardPriorityClass}" id="tracker-card-${req.id}">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span class="tracker-id-badge">${this.escapeHtml(req.id)}</span>
              <span class="tracker-source-badge">${sourceIcon} ${this.escapeHtml(req.source)}</span>
              <span class="${priorityClass}">● ${this.escapeHtml(req.priority)}</span>
              <span class="badge-status-pill ${statusClass}">● ${this.escapeHtml(req.status)}</span>
              ${confirmHtml}
            </div>
            <div style="font-size:11.5px; color:var(--text-secondary); display:inline-flex; align-items:center; gap:4px;">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/></svg>
              <span>${this.escapeHtml(req.created_at || '')}</span>
            </div>
          </div>

          <div>
            <div style="font-size:15px; font-weight:700; color:var(--text-primary); margin-bottom:4px;">
              ${this.escapeHtml(req.title)}
            </div>
            ${req.description ? `<div style="font-size:13px; color:var(--text-secondary); line-height:1.45; white-space:pre-wrap;">${this.escapeHtml(req.description)}</div>` : ''}
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding:8px 10px; background:var(--panel-header-bg); border-radius:6px; border:1px solid var(--border-color); font-size:12.5px;">
            <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
              <div style="display:inline-flex; align-items:center; gap:4px;">
                <span style="color:var(--text-secondary);">Requester:</span>
                <strong style="display:inline-flex; align-items:center; gap:4px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg> ${this.escapeHtml(req.requester_name)}</strong>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="color:var(--text-secondary);">Team:</span>
                ${teamSelectHtml}
              </div>
              <div>
                <span style="color:var(--text-secondary);">Assignee:</span>
                <strong>${this.escapeHtml(req.assigned_to_name || 'Unassigned')}</strong>
              </div>
            </div>

            <div style="display:flex; align-items:center; gap:6px;">
              <span style="color:var(--text-secondary);">Change Status:</span>
              ${statusSelectHtml}
            </div>
          </div>

          ${pipelineHtml}
          ${closedInfoHtml}

          <div style="display:flex; justify-content:flex-end; align-items:center; gap:8px; border-top:1px solid var(--border-color); padding-top:10px;">
            ${btnWaCopy}
            ${btnConfirm}
            ${btnClose}
          </div>
        </div>
      `;
    }).join('');
  }

  openNewWorkRequestModal(prefill = {}) {
    const titleInput = document.getElementById('input-req-title');
    const nameInput = document.getElementById('input-req-name');
    const sourceSelect = document.getElementById('select-req-source');
    const teamSelect = document.getElementById('select-req-team');
    const prioritySelect = document.getElementById('select-req-priority');
    const assigneeSelect = document.getElementById('select-req-assignee');
    const descInput = document.getElementById('textarea-req-desc');
    const errEl = document.getElementById('new-req-error');

    if (errEl) errEl.style.display = 'none';

    if (titleInput) titleInput.value = prefill.title || '';
    if (nameInput) {
      nameInput.value = prefill.requester_name || (this.currentUser ? this.currentUser.full_name : '');
    }

    // Dynamically populate Source Channel options from active team channels and external sources
    if (sourceSelect) {
      let optionsHtml = '';
      const teamChannels = (this.channels || []).filter(c => !c.is_direct);
      if (teamChannels.length > 0) {
        optionsHtml += '<optgroup label="Active Company Channels">';
        teamChannels.forEach(c => {
          optionsHtml += `<option value="${c.id}" data-name="${this.escapeHtml(c.name)}">${this.escapeHtml(c.name)}</option>`;
        });
        optionsHtml += '</optgroup>';
      }

      optionsHtml += `
        <optgroup label="WhatsApp & External Sources">
          <option value="WhatsApp Group" data-name="WhatsApp Group">WhatsApp Group</option>
          <option value="Direct Request" data-name="Direct Request">Direct Employee</option>
          <option value="Outside Client" data-name="Outside Client">Outside Client Helpdesk</option>
        </optgroup>
      `;
      sourceSelect.innerHTML = optionsHtml;

      // Select default source:
      if (prefill.source_channel_id) {
        sourceSelect.value = prefill.source_channel_id;
      } else if (prefill.source) {
        const match = Array.from(sourceSelect.options).find(o => o.value === prefill.source || o.getAttribute('data-name') === prefill.source);
        if (match) sourceSelect.value = match.value;
      } else if (this.activeChannel && !this.activeChannel.is_direct) {
        sourceSelect.value = this.activeChannel.id;
      } else {
        sourceSelect.value = 'WhatsApp Group';
      }
    }

    if (teamSelect) teamSelect.value = prefill.assigned_team || 'IT';
    if (prioritySelect) prioritySelect.value = prefill.priority || 'Normal';
    if (descInput) descInput.value = prefill.description || '';

    // Populate assignee dropdown from loaded users
    if (assigneeSelect) {
      assigneeSelect.innerHTML = '<option value="">-- Assign at Team Level --</option>' +
        this.users.map(u => `<option value="${u.id}">${this.escapeHtml(u.full_name)} (${this.escapeHtml(u.department || u.role)})</option>`).join('');
      if (prefill.assigned_to_user_id) assigneeSelect.value = prefill.assigned_to_user_id;
    }

    this.openModal('modal-new-work-request');
    if (titleInput) titleInput.focus();
  }

  async submitNewWorkRequest() {
    const title = document.getElementById('input-req-title').value.trim();
    const requester_name = document.getElementById('input-req-name').value.trim();
    const sourceSelect = document.getElementById('select-req-source');
    const source_channel_id = sourceSelect ? sourceSelect.value : null;
    const selectedOpt = sourceSelect && sourceSelect.options[sourceSelect.selectedIndex];
    const source = selectedOpt ? (selectedOpt.getAttribute('data-name') || selectedOpt.text.replace(/^[^\w\s]+/, '').trim()) : 'WhatsApp Group';

    const assigned_team = document.getElementById('select-req-team').value;
    const priority = document.getElementById('select-req-priority').value;
    const assigneeSelect = document.getElementById('select-req-assignee');
    const assigned_to_user_id = assigneeSelect ? assigneeSelect.value : null;
    let assigned_to_name = null;
    if (assigned_to_user_id) {
      const u = this.users.find(usr => usr.id === assigned_to_user_id);
      if (u) assigned_to_name = u.full_name;
    }
    const description = document.getElementById('textarea-req-desc').value.trim();
    const errEl = document.getElementById('new-req-error');

    if (errEl) errEl.style.display = 'none';

    try {
      const res = await fetch('/api/tracker/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          requester_name,
          requester_id: this.currentUser ? this.currentUser.id : null,
          source,
          source_channel_id,
          assigned_team,
          assigned_to_user_id,
          assigned_to_name,
          priority
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create request');

      this.closeModal('modal-new-work-request');
      await this.loadWorkTracker();
      await this.loadWorkTrackerStats();

      let alertNotice = `✅ Work Assistance Request [${data.id}] recorded successfully!`;
      if (data.auto_posted_message) {
        alertNotice += `\n📢 Ticket announcement posted to Source Channel automatically!\nAll channel employees will receive the notification immediately.`;
      }
      alert(alertNotice);
    } catch (err) {
      if (errEl) {
        errEl.innerText = err.message;
        errEl.style.display = 'block';
      } else {
        alert('Error creating request: ' + err.message);
      }
    }
  }

  async updateRequestStatus(id, newStatus) {
    try {
      const res = await fetch(`/api/tracker/requests/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update status');
      await this.loadWorkTracker();
      await this.loadWorkTrackerStats();
    } catch (err) {
      alert('Error updating status: ' + err.message);
    }
  }

  async updateRequestTeam(id, newTeam) {
    try {
      const res = await fetch(`/api/tracker/requests/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_team: newTeam })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update team');
      await this.loadWorkTracker();
      await this.loadWorkTrackerStats();
    } catch (err) {
      alert('Error updating team: ' + err.message);
    }
  }

  async confirmRequestResolution(id) {
    try {
      const res = await fetch(`/api/tracker/requests/${id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.currentUser ? this.currentUser.id : null,
          userName: this.currentUser ? this.currentUser.full_name : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to confirm resolution');
      await this.loadWorkTracker();
      await this.loadWorkTrackerStats();
      alert(`✅ Resolution confirmed for request [${id}]!`);
    } catch (err) {
      alert('Error confirming resolution: ' + err.message);
    }
  }

  openCloseRequestModal(id) {
    const req = this.workRequests.find(r => r.id === id);
    if (!req) return;

    document.getElementById('close-req-id').value = id;
    document.getElementById('close-req-badge').innerText = id;
    document.getElementById('close-req-title-display').innerText = req.title;
    document.getElementById('close-req-meta-display').innerText = `Requester: ${req.requester_name} • Team: ${req.assigned_team} • Priority: ${req.priority}`;
    document.getElementById('close-req-notes').value = req.resolution_notes || '';
    document.getElementById('close-req-by-name').value = this.currentUser ? `${this.currentUser.full_name} (${this.currentUser.role})` : 'Coordinator';

    this.openModal('modal-close-work-request');
  }

  async submitCloseWorkRequest() {
    const id = document.getElementById('close-req-id').value;
    const notes = document.getElementById('close-req-notes').value.trim();
    const closedByName = this.currentUser ? this.currentUser.full_name : 'Coordinator';
    const closedByUserId = this.currentUser ? this.currentUser.id : null;

    try {
      const res = await fetch(`/api/tracker/requests/${id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          closedByUserId,
          closedByName,
          resolutionNotes: notes
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to close request');

      this.closeModal('modal-close-work-request');
      await this.loadWorkTracker();
      await this.loadWorkTrackerStats();
      alert(`🔒 Assistance Request [${id}] officially closed.`);
    } catch (err) {
      alert('Error closing request: ' + err.message);
    }
  }

  copyWhatsAppUpdate(id) {
    const req = this.workRequests.find(r => r.id === id);
    if (!req) return;

    const priorityEmoji = req.priority === 'Urgent' ? '🔴' : (req.priority === 'High' ? '🟠' : '🟢');
    let statusEmoji = '🔄';
    if (req.status === 'Completed') statusEmoji = '✅';
    else if (req.status === 'Closed') statusEmoji = '🔒';
    else if (req.status === 'Waiting') statusEmoji = '⏳';

    const text = [
      `📋 *RegiusTax Work Assistance [${req.id}]*`,
      `📌 *Title:* ${req.title}`,
      `👤 *Requester:* ${req.requester_name} (${req.source})`,
      `🏢 *Assigned Team:* ${req.assigned_team}${req.assigned_to_name ? ' (' + req.assigned_to_name + ')' : ''}`,
      `⚡ *Priority:* ${priorityEmoji} ${req.priority}`,
      `${statusEmoji} *Status:* ${req.status}`,
      req.employee_confirmed ? `✅ *Employee Verified:* Yes` : '',
      req.resolution_notes ? `💡 *Resolution:* ${req.resolution_notes}` : '',
      `\n_Tracked on RegiusTax RTwhat's up_`
    ].filter(Boolean).join('\n');

    this.copyToClipboard(text);
  }

  handleTrackerRequestCreated(newReq) {
    if (!this.workRequests.find(r => r.id === newReq.id)) {
      this.workRequests.unshift(newReq);
      this.renderWorkTrackerList(this.workRequests);
      this.loadWorkTrackerStats();
    }
  }

  handleTrackerRequestUpdated(updatedReq) {
    this.workRequests = this.workRequests.map(r => r.id === updatedReq.id ? updatedReq : r);
    this.renderWorkTrackerList(this.workRequests);
    this.loadWorkTrackerStats();
  }

  handleTrackerRequestClosed(closedReq) {
    this.workRequests = this.workRequests.map(r => r.id === closedReq.id ? closedReq : r);
    this.renderWorkTrackerList(this.workRequests);
    this.loadWorkTrackerStats();
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

  openWorkTrackerForTicket(ticketId) {
    this.openWorkTracker();
    const searchTracker = document.getElementById('tracker-search-input');
    if (searchTracker) {
      searchTracker.value = ticketId;
      this.trackerSearch = ticketId;
      this.loadWorkTracker();
    }
  }

  // ==========================================================================
  // BACKUP & DATA PROTECTION
  // Daily 12:00 PM Auto-Backup • Laptop Shutdown Protection
  // ==========================================================================

  async openBackupManagerModal() {
    if (!this.currentUser || this.currentUser.role !== 'Admin' || this.portalMode !== 'admin') {
      alert('Access Restricted: Only an Administrator can access Data Backup & Protection.');
      return;
    }
    this.openModal('modal-backup-manager');
    await this.loadBackupStatus();
  }

  async loadBackupStatus() {
    try {
      const adminId = this.currentUser ? this.currentUser.id : '';
      const res = await fetch(`/api/backup/status?adminId=${encodeURIComponent(adminId)}`);
      if (!res.ok) return;
      const status = await res.json();

      const nextRunEl = document.getElementById('backup-stat-next-run');
      const countdownEl = document.getElementById('backup-stat-countdown');
      const latestInfoEl = document.getElementById('backup-latest-info');
      const listEl = document.getElementById('backup-history-list');

      // Toggle Admin-only Go-Live message clearing section
      const adminGoLiveSec = document.getElementById('admin-go-live-section');
      if (adminGoLiveSec) {
        adminGoLiveSec.style.display = (this.currentUser && this.currentUser.role === 'Admin') ? 'block' : 'none';
      }

      if (nextRunEl && status.dailySchedule) {
        nextRunEl.innerText = `${status.dailySchedule.nextRunFormatted} (${status.dailySchedule.time})`;
      }
      if (countdownEl && status.dailySchedule) {
        countdownEl.innerText = `in ${status.dailySchedule.countdownFormatted}`;
      }

      if (latestInfoEl) {
        if (status.lastBackup) {
          latestInfoEl.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <span style="font-weight:700; color:var(--text-primary); font-size:13.5px; display:inline-flex; align-items:center; gap:6px;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
                <span>${this.escapeHtml(status.lastBackup.filename)}</span>
              </span>
              <span style="background:rgba(0,168,132,0.12); color:var(--rt-emerald); font-weight:700; font-size:11.5px; padding:2px 8px; border-radius:10px;">${this.escapeHtml(status.lastBackup.sizeFormatted)}</span>
            </div>
            <div style="font-size:12px; color:var(--text-secondary); display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span style="display:inline-flex; align-items:center; gap:4px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg> <strong>Created:</strong></span> ${this.escapeHtml(status.lastBackup.formattedTime)} • 
              <strong>Type:</strong> <span style="text-transform:capitalize;">${this.escapeHtml(status.lastBackup.type.replace('_', ' '))}</span>
            </div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:6px; font-family:monospace; word-break:break-all; background:var(--panel-header-bg); padding:4px 8px; border-radius:4px; border:1px solid var(--border-color); display:flex; align-items:center; gap:6px;">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
              <span>${this.escapeHtml(status.lastBackup.filePath)}</span>
            </div>
          `;
        } else {
          latestInfoEl.innerHTML = '<span style="color:var(--text-muted);">No backups created yet. Click "Take Backup Now" to create your first snapshot.</span>';
        }
      }

      if (listEl) {
        if (!status.recentBackups || status.recentBackups.length === 0) {
          listEl.innerHTML = '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:12px;">No past backups recorded.</div>';
        } else {
          listEl.innerHTML = status.recentBackups.map(b => `
            <div style="display:flex; justify-content:space-between; align-items:center; background:var(--panel-header-bg); border:1px solid var(--border-color); border-radius:6px; padding:8px 12px; font-size:12px;">
              <div>
                <div style="font-weight:600; color:var(--text-primary);">${this.escapeHtml(b.filename)}</div>
                <div style="font-size:11px; color:var(--text-secondary);">
                  ${this.escapeHtml(b.formattedTime)} • ${this.escapeHtml(b.sizeFormatted)} • <span style="text-transform:capitalize;">${this.escapeHtml(b.type)}</span>
                </div>
              </div>
              <div style="display:flex; gap:6px;">
                <a href="/api/backup/download/${encodeURIComponent(b.filename)}?adminId=${encodeURIComponent(adminId)}" class="btn-primary" style="padding:4px 10px; font-size:11.5px; text-decoration:none; border-radius:4px; display:inline-flex; align-items:center; gap:5px;">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Download
                </a>
              </div>
            </div>
          `).join('');
        }
      }
    } catch (err) {
      console.error('Failed to load backup status:', err);
    }
  }

  async triggerBackupNow() {
    if (!this.currentUser || this.currentUser.role !== 'Admin') {
      alert('Only an Administrator can take data backups.');
      return;
    }

    const btn = document.getElementById('btn-trigger-backup-now');
    const origText = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span style="display:inline-flex; align-items:center; gap:6px;"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg> Creating Snapshot...</span>';
    }

    try {
      const res = await fetch('/api/backup/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: this.currentUser.id, type: 'manual', note: 'Admin-initiated backup from portal' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Backup creation failed');

      await this.loadBackupStatus();
      alert(`✅ Full Backup Created Successfully!\n\nFile: ${data.filename}\nSize: ${data.sizeFormatted}\nTime: ${data.formattedTime}\nSaved in backups\\ folder on this laptop.`);
    } catch (err) {
      alert('Error creating backup: ' + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origText;
      }
    }
  }

  async adminClearAllMessages() {
    if (!this.currentUser || this.currentUser.role !== 'Admin') {
      alert('Only an Administrator can clear all messages.');
      return;
    }

    const conf = confirm(
      '⚠️ ARE YOU SURE YOU WANT TO CLEAR ALL MESSAGES?\n\n' +
      'This will wipe all test chat messages across all channels to prepare RTwhat\'s up for official Live use.\n\n' +
      'A safety backup will be created automatically before wiping.\n\n' +
      'Click OK to proceed with Go-Live wipe.'
    );
    if (!conf) return;

    const btn = document.getElementById('btn-admin-clear-all-msgs');
    const origText = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Clearing Messages...';
    }

    try {
      // 1. Take safety backup first
      await fetch('/api/backup/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'pre_live_wipe', note: 'Safety snapshot before Go-Live message wipe' })
      });

      // 2. Call clear messages API
      const res = await fetch('/api/admin/clear-all-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: this.currentUser.id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clear messages');

      // 3. Refresh channels & UI
      await this.loadChannels();
      if (this.activeChannel) {
        await this.loadMessages(this.activeChannel.id);
      }
      await this.loadBackupStatus();

      alert('🚀 GO-LIVE CLEAN SLATE COMPLETE!\n\nAll test messages have been cleared from all channels.\nYour channels, employee accounts, and settings are preserved and ready for live team communication.');
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origText;
      }
    }
  }

  handleBackupCompleted(manifest) {
    const modal = document.getElementById('modal-backup-manager');
    if (modal && modal.style.display !== 'none') {
      this.loadBackupStatus();
    }
  }

  renderFormattedText(text) {
    if (!text) return '';
    let escaped = this.escapeHtml(text);
    // Bold: *text*
    escaped = escaped.replace(/\*(.*?)\*/g, '<strong>$1</strong>');
    // Italic: _text_
    escaped = escaped.replace(/_(.*?)_/g, '<em>$1</em>');
    // Code: `text`
    escaped = escaped.replace(/`(.*?)`/g, '<code>$1</code>');

    // Extract ticket ID if present (e.g. WA-001)
    let ticketIdMatch = text.match(/\b(WA-\d+)\b/);
    const ticketId = ticketIdMatch ? ticketIdMatch[1] : null;

    // Work Assistance Ticket link badge
    escaped = escaped.replace(/\b(WA-\d+)\b/g, (match) => {
      return `<span class="badge-wa-ticket" onclick="window.appController.openWorkTrackerForTicket('${match}')" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; background:rgba(0,168,132,0.15); color:var(--rt-emerald); padding:1px 7px; border-radius:4px; font-weight:700; border:1px solid rgba(0,168,132,0.35); text-decoration:none;" title="Click to view ${match} in Work Tracker"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg> ${match}</span>`;
    });

    // If this is an auto-posted Work Tracker announcement, add direct action button
    if (ticketId && escaped.includes('Tracked via Work Assistance Tracker')) {
      escaped += `
        <div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(128,128,128,0.25); display:flex; align-items:center; justify-content:space-between;">
          <span style="font-size:11px; opacity:0.8;">Work Assistance System</span>
          <button type="button" class="btn-tracker-quick-open" onclick="window.appController.openWorkTrackerForTicket('${ticketId}')" style="background:var(--rt-emerald); color:#fff; border:none; padding:4px 10px; border-radius:5px; font-size:11.5px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:5px; box-shadow:0 2px 5px rgba(0,0,0,0.15);">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            <span>Open in Tracker</span>
          </button>
        </div>
      `;
    }

    return escaped;
  }
}

window.appController = new AppController();
