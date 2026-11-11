// Camera: a page-wide CameraSession that owns the stream (so the browser is
// asked for permission as rarely as it allows), and the capture dialog that
// uses it. If the camera is unavailable or blocked, a plain <input type=file
// capture> is offered so phones can still take a photo.
//
// Rules (see README, "Camera permission"):
//  - getUserMedia is called only from CameraSession.acquire(), which the UI
//    calls only from a user gesture (Camera button, Front/Back change, Resume).
//  - Closing the dialog does not stop the camera: it goes to standby (video
//    paused, tracks disabled, not stopped) so reopening is instant and never
//    prompts. Standby ends after STANDBY_MS, on pagehide, or after the page has
//    been hidden for HIDDEN_RELEASE_MS.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const STANDBY_MS = 120000; // camera kept warm this long after the dialog closes
  const HIDDEN_RELEASE_MS = 30000; // released after the page has been hidden this long
  const CAPTURE_TYPE = 'image/jpeg';
  const CAPTURE_QUALITY = 0.92;
  const FACINGS = ['environment', 'user'];

  class CameraSession {
    constructor() {
      this.standbyMs = STANDBY_MS; // instance fields so tests can shorten them
      this.hiddenMs = HIDDEN_RELEASE_MS;
      this.stream = null;
      this.facing = null; // facing the current stream was acquired for
      this.state = 'idle'; // 'idle' | 'live' | 'standby'
      this.dialogOpen = false;
      this.permissionState = 'unknown'; // 'granted' | 'denied' | 'prompt' | 'unknown'
      this.prefs = { devices: {}, facing: 'environment' }; // remembered deviceId per facing, last facing
      this.onPrefs = null; // called after prefs change, so the app can persist them
      this.video = null;
      this._subs = new Set();
      this._inflight = null;
      this._permStatus = null;
      this._standbyTimer = 0;
      this._hiddenTimer = 0;

      document.addEventListener('visibilitychange', () => this._onVisibility());
      window.addEventListener('pagehide', () => this.release());
      window.addEventListener('pageshow', (e) => {
        if (e.persisted) this._emit('visible'); // restored from the back/forward cache: the stream is gone
      });
    }

    /** Listen for 'state' | 'permission' | 'visible' | 'interrupted' | 'recovered'. Returns an unsubscribe function. */
    subscribe(fn) {
      this._subs.add(fn);
      return () => this._subs.delete(fn);
    }

    _emit(type) {
      for (const fn of [...this._subs]) {
        try {
          fn(type);
        } catch (err) {
          console.error(err);
        }
      }
    }

    bindVideo(video) {
      this.video = video;
    }

    /** True while the camera is on or in standby (the device indicator may be lit). */
    isOn() {
      return this.state !== 'idle';
    }

    _track() {
      return this.stream ? this.stream.getVideoTracks()[0] || null : null;
    }

    _usable() {
      const t = this._track();
      return !!t && t.readyState === 'live' && !t.muted;
    }

    /** Is there a usable stream for this facing already (so acquire() will not call getUserMedia)? */
    hasLive(facing) {
      return !!this.stream && this.facing === facing && this._usable();
    }

    setPrefs(devices, facing) {
      this.prefs.devices = devices && typeof devices === 'object' ? { ...devices } : {};
      this.prefs.facing = FACINGS.includes(facing) ? facing : 'environment';
    }

    _remember(facing, deviceId) {
      if (deviceId) this.prefs.devices[facing] = deviceId;
      else delete this.prefs.devices[facing];
      this.prefs.facing = facing;
      if (this.onPrefs) this.onPrefs(this.prefs);
    }

    // ------------------------------------------------------------ permission

    /** Read the camera permission (never prompts) and follow its changes. Unsupported browsers give 'unknown'. */
    async watchPermission() {
      try {
        if (!this._permStatus) {
          const status = await navigator.permissions.query({ name: 'camera' });
          this._permStatus = status;
          status.addEventListener('change', () => this._setPermission(status.state));
        }
        this._setPermission(this._permStatus.state);
      } catch {
        this._setPermission('unknown');
      }
      return this.permissionState;
    }

    refreshPermission() {
      return this.watchPermission();
    }

    _setPermission(state) {
      const next = ['granted', 'denied', 'prompt'].includes(state) ? state : 'unknown';
      if (next === this.permissionState) return;
      this.permissionState = next;
      this._emit('permission');
    }

    // ------------------------------------------------------------ stream

    /**
     * The one place getUserMedia is called. Reuses a live stream for the same
     * facing; concurrent callers share one request. Call from a user gesture.
     */
    acquire(facing = this.prefs.facing) {
      if (this._inflight && this._inflight.facing === facing) return this._inflight.promise;
      const prior = this._inflight ? this._inflight.promise.catch(() => null) : Promise.resolve();
      const rec = { facing, promise: prior.then(() => this._acquire(facing)) };
      this._inflight = rec;
      const clear = () => {
        if (this._inflight === rec) this._inflight = null;
      };
      rec.promise.then(clear, clear);
      return rec.promise;
    }

    async _acquire(facing) {
      if (this.hasLive(facing)) return this.stream;
      this.release(); // a different facing, or an ended/muted stream: phones cannot open two cameras
      const stream = await this._open(facing);
      const track = stream.getVideoTracks()[0];
      this.stream = stream;
      this.facing = facing;
      this.state = 'live';
      if (track) {
        track.addEventListener('ended', () => {
          if (this.stream !== stream) return;
          this.release();
          if (this.dialogOpen && !document.hidden) this._emit('interrupted');
        });
        track.addEventListener('mute', () => {
          if (this.stream === stream && this.dialogOpen && !document.hidden) this._emit('interrupted');
        });
        track.addEventListener('unmute', () => {
          if (this.stream === stream && this.dialogOpen && !document.hidden) this._emit('recovered');
        });
        const settings = track.getSettings ? track.getSettings() : {};
        this._remember(facing, settings.deviceId || null);
      }
      if (!this.dialogOpen || document.hidden) this.standby(); // closed (or hidden) while waiting for permission
      this._emit('state');
      return stream;
    }

    /** Remembered device first; if it is gone, forget it and try once with a plain facing request. */
    async _open(facing) {
      const md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) {
        const err = new Error('Live camera is not available here');
        err.name = 'NotSupportedError';
        throw err;
      }
      const size = { width: { ideal: 1920 }, height: { ideal: 1440 } };
      const id = this.prefs.devices[facing];
      if (id) {
        try {
          return await md.getUserMedia({ video: { deviceId: { exact: id }, ...size }, audio: false });
        } catch (err) {
          if (!err || (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError')) throw err;
          delete this.prefs.devices[facing]; // Safari issues new ids when permission is not persistent: normal there
        }
      }
      return md.getUserMedia({ video: { facingMode: { ideal: facing }, ...size }, audio: false });
    }

    /** Dialog is open: show the stream and start playing (tracks on). Reuse after standby needs no prompt. */
    async activate() {
      if (!this.stream) return;
      clearTimeout(this._standbyTimer);
      this._standbyTimer = 0;
      this.stream.getTracks().forEach((t) => (t.enabled = true));
      this.state = 'live';
      if (this.video) {
        if (this.video.srcObject !== this.stream) this.video.srcObject = this.stream;
        try {
          await this.video.play();
        } catch {
          /* autoplay restrictions: the preview still shows once the stream is attached */
        }
      }
      this._emit('state');
    }

    /** Keep the stream but switch it off: video paused, tracks disabled (not stopped). Ends after standbyMs. */
    standby() {
      if (!this.stream) return;
      if (this.video && !this.video.paused) this.video.pause();
      this.stream.getTracks().forEach((t) => (t.enabled = false));
      this.state = 'standby';
      clearTimeout(this._standbyTimer);
      this._standbyTimer = setTimeout(() => this.release(), this.standbyMs);
      this._emit('state');
    }

    /** Really stop the camera (indicator off). */
    release() {
      clearTimeout(this._standbyTimer);
      this._standbyTimer = 0;
      const had = this.state !== 'idle';
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.facing = null;
      this.state = 'idle';
      if (this.video) {
        if (!this.video.paused) this.video.pause();
        this.video.srcObject = null;
      }
      if (had) this._emit('state');
    }

    _onVisibility() {
      if (document.hidden) {
        if (!this.stream) return;
        if (this.dialogOpen && this.state === 'live') this.standby(); // preview off at once
        clearTimeout(this._hiddenTimer);
        this._hiddenTimer = setTimeout(() => this.release(), this.hiddenMs);
      } else {
        clearTimeout(this._hiddenTimer);
        this._hiddenTimer = 0;
        this._emit('visible');
      }
    }
  }

  const session = new CameraSession();

  // -------------------------------------------------------------------- dialog

  const PROMPT_NOTE = "Your browser will ask for camera access. Choose Allow, and 'remember' or 'on every visit' if offered, so it does not ask again.";
  const BLOCKED_NOTE = 'Camera is blocked for this site. Allow the camera in the site settings (padlock icon in the address bar), then press Resume camera.';

  class CameraDialog {
    constructor(dialog) {
      this.dialog = dialog;
      this.video = dialog.querySelector('video');
      this.facing = dialog.querySelector('select');
      this.error = dialog.querySelector('.camera-error');
      this.note = dialog.querySelector('#camera-note');
      this.captureBtn = dialog.querySelector('[data-camera="capture"]');
      this.resumeBtn = dialog.querySelector('[data-camera="resume"]');
      this.fallback = dialog.querySelector('#camera-fallback');
      this.fallbackInput = this.fallback.querySelector('input[type="file"]');
      this._resolve = null;
      this._result = null;
      this._token = 0;
      session.bindVideo(this.video);

      this.facing.addEventListener('change', () => this._start());
      this.captureBtn.addEventListener('click', () => this._capture());
      this.resumeBtn.addEventListener('click', () => this._resume());
      dialog.querySelector('[data-camera="cancel"]').addEventListener('click', () => dialog.close());
      this.fallbackInput.addEventListener('change', () => {
        const file = this.fallbackInput.files && this.fallbackInput.files[0];
        this.fallbackInput.value = '';
        if (file) {
          this._result = file;
          dialog.close();
        }
      });
      dialog.addEventListener('close', () => {
        this._token++; // abandon any start() still waiting
        session.dialogOpen = false;
        session.standby(); // not stop: reopening within the standby window is instant
        const resolve = this._resolve;
        this._resolve = null;
        if (resolve) resolve(this._result);
      });
      session.subscribe((type) => this._onSession(type));
    }

    /**
     * Best-effort check for a camera before showing any UI (enumerateDevices does not prompt).
     * @returns {Promise<'available'|'none'|'unknown'>}
     */
    static async detect() {
      const md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) return 'none'; // no API at all (insecure context / old browser)
      if (!md.enumerateDevices) return 'unknown';
      try {
        const devices = await md.enumerateDevices();
        return devices.some((d) => d.kind === 'videoinput') ? 'available' : 'none';
      } catch {
        return 'unknown';
      }
    }

    /** Open the dialog (call from a user gesture); resolves with a Blob/File, or null if cancelled. */
    open() {
      return new Promise((resolve) => {
        this._resolve = resolve;
        this._result = null;
        if (session.prefs.facing && [...this.facing.options].some((o) => o.value === session.prefs.facing)) this.facing.value = session.prefs.facing;
        session.dialogOpen = true;
        this.dialog.showModal();
        this._start();
      });
    }

    _reset() {
      this.error.hidden = true;
      this.note.hidden = true;
      this.fallback.hidden = true;
      this.resumeBtn.hidden = true;
      this.captureBtn.disabled = true;
    }

    _say(message) {
      this.note.textContent = message;
      this.note.hidden = !message;
    }

    async _start() {
      const token = ++this._token;
      this._reset();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this._fail('Live camera is not available here (it needs a secure https:// or local page). You can still pick or take a photo:');
        return;
      }
      const facing = this.facing.value;
      const warm = session.hasLive(facing);
      if (session.permissionState === 'denied' && !warm) {
        // Blocked: do not call getUserMedia (it would fail without asking). Offer the fallback and Resume.
        this._fail(BLOCKED_NOTE, { resume: true });
        return;
      }
      if (!warm && session.permissionState !== 'granted') this._say(PROMPT_NOTE);
      try {
        await session.acquire(facing);
      } catch (err) {
        if (token !== this._token) return;
        this._fail(describe(err), { resume: !!err && err.name !== 'NotSupportedError' });
        return;
      }
      if (token !== this._token || !this.dialog.open) return;
      this._say('');
      this.video.classList.toggle('mirror', facing === 'user');
      this.fallbackInput.setAttribute('capture', facing);
      await session.activate();
      await this._firstFrame();
      if (token === this._token && this.dialog.open) this.captureBtn.disabled = false;
    }

    /** After standby the first frames can be black: wait for a real one (bounded). */
    _firstFrame() {
      const v = this.video;
      if (!v.requestVideoFrameCallback) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(resolve, 250);
        v.requestVideoFrameCallback(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    async _resume() {
      await session.refreshPermission();
      this._start();
    }

    _paused() {
      if (!this.dialog.open) return;
      this._token++;
      this._reset();
      this._say('Camera paused.');
      this.resumeBtn.hidden = false;
    }

    _onSession(type) {
      if (!this.dialog.open) return;
      if (type === 'visible') {
        // Back on the page: reuse a live stream by itself, otherwise ask for a tap (a user gesture).
        if (session.hasLive(this.facing.value)) this._start();
        else this._paused();
      } else if (type === 'interrupted') {
        this._paused();
      } else if (type === 'recovered') {
        if (session.hasLive(this.facing.value)) this._start();
      }
    }

    _capture() {
      const { videoWidth: w, videoHeight: h } = this.video;
      if (!w || !h) return;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(this.video, 0, 0);
      canvas.toBlob(
        (blob) => {
          this._result = blob;
          this.dialog.close();
        },
        CAPTURE_TYPE,
        CAPTURE_QUALITY,
      );
    }

    _fail(message, { resume = false } = {}) {
      this.note.hidden = true;
      this.error.textContent = message;
      this.error.hidden = false;
      this.fallback.hidden = false;
      this.resumeBtn.hidden = !resume;
    }
  }

  function describe(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera access was denied. Allow it in your browser settings, then press Resume camera, or pick a photo instead:';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No matching camera was found. Try the other camera, or pick a photo instead:';
      case 'NotReadableError':
        return 'The camera is busy or unavailable (another app may be using it). You can pick a photo instead:';
      case 'NotSupportedError':
        return 'Live camera is not available here (it needs a secure https:// or local page). You can still pick or take a photo:';
      default:
        return `Could not start the camera (${(err && err.message) || err}). You can pick a photo instead:`;
    }
  }

  DC.CameraSession = session;
  DC.CameraDialog = CameraDialog;
})();
