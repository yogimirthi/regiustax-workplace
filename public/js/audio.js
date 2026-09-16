/**
 * RTwhat's up - Audio & Voice Note Handler
 * Provides voice note recording via MediaRecorder API and Web Audio chime synthesizer.
 */

class AudioController {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.startTime = null;
    this.timerInterval = null;
    this.isRecording = false;
    this.audioCtx = null;
  }

  // Initialize or get Web Audio Context for synthesized notification sounds
  getAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioCtx = new AudioCtx();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  // Play pleasant WhatsApp-style subtle message notification chime
  playNotificationSound() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      // Classic friendly double chime: 880Hz -> 1320Hz
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.25);
    } catch (e) {
      console.warn('Could not play synthesized chime:', e);
    }
  }

  // Start recording voice note
  async startRecording(onTimerUpdate) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Microphone access is not supported by this browser.');
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.startTime = Date.now();

      if (onTimerUpdate) {
        this.timerInterval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
          const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
          const secs = String(elapsed % 60).padStart(2, '0');
          onTimerUpdate(`${mins}:${secs}`);
        }, 500);
      }

      return true;
    } catch (err) {
      console.error('Error accessing microphone:', err);
      alert('Could not access microphone: ' + err.message);
      return false;
    }
  }

  // Stop recording safely and return audio Blob without deadlocks
  stopRecording() {
    return new Promise((resolve) => {
      let resolved = false;
      const safeResolve = (blob) => {
        if (resolved) return;
        resolved = true;
        clearInterval(this.timerInterval);
        this.isRecording = false;
        resolve(blob);
      };

      // Safety timeout: Never let promise hang if mediaRecorder events fail
      const timeoutId = setTimeout(() => {
        console.warn('[Audio] Recording stop timed out, resolving safely');
        safeResolve(this.audioChunks.length > 0 ? new Blob(this.audioChunks, { type: 'audio/webm; codecs=opus' }) : null);
      }, 3000);

      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        clearTimeout(timeoutId);
        safeResolve(null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        clearTimeout(timeoutId);
        const audioBlob = this.audioChunks.length > 0 
          ? new Blob(this.audioChunks, { type: 'audio/webm; codecs=opus' }) 
          : null;
        
        // Stop all audio stream tracks
        if (this.mediaRecorder && this.mediaRecorder.stream) {
          try {
            this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
          } catch (e) {
            console.warn('[Audio] Error stopping stream tracks:', e);
          }
        }

        safeResolve(audioBlob);
      };

      try {
        this.mediaRecorder.stop();
      } catch (err) {
        console.warn('[Audio] MediaRecorder.stop() threw exception:', err);
        clearTimeout(timeoutId);
        safeResolve(null);
      }
    });
  }

  // Cancel current voice recording without saving safely
  cancelRecording() {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.onstop = () => {
          if (this.mediaRecorder && this.mediaRecorder.stream) {
            try {
              this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
            } catch (e) {}
          }
        };
        this.mediaRecorder.stop();
      }
    } catch (err) {
      console.warn('[Audio] Error canceling recording:', err);
    }
    clearInterval(this.timerInterval);
    this.isRecording = false;
    this.audioChunks = [];
  }
}

window.audioController = new AudioController();
