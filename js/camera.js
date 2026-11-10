// Camera capture dialog: live getUserMedia preview, front/back switch, capture
// to a Blob. If the camera is unavailable or denied, a plain <input type=file
// capture> is offered instead so phones can still take a photo.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  class CameraDialog {
    constructor(dialog) {
      this.dialog = dialog;
      this.video = dialog.querySelector('video');
      this.facing = dialog.querySelector('select');
      this.error = dialog.querySelector('.camera-error');
      this.captureBtn = dialog.querySelector('[data-camera="capture"]');
      this.fallback = dialog.querySelector('#camera-fallback');
      this.fallbackInput = this.fallback.querySelector('input[type="file"]');
      this.stream = null;
      this._resolve = null;
      this._result = null;

      this.facing.addEventListener('change', () => this._start());
      this.captureBtn.addEventListener('click', () => this._capture());
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
        this._stop();
        const resolve = this._resolve;
        this._resolve = null;
        if (resolve) resolve(this._result);
      });
    }

    /**
     * Best-effort check for a camera before showing any UI.
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

    /** Open the dialog; resolves with a Blob/File, or null if cancelled. */
    open() {
      return new Promise((resolve) => {
        this._resolve = resolve;
        this._result = null;
        this.dialog.showModal();
        this._start();
      });
    }

    async _start() {
      this._stop();
      this.error.hidden = true;
      this.fallback.hidden = true;
      this.captureBtn.disabled = true;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this._fail('Live camera is not available here (it needs a secure https:// or local page). You can still pick or take a photo:');
        return;
      }
      const facing = this.facing.value;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
      } catch (err) {
        this._fail(describe(err));
        return;
      }
      if (!this.dialog.open) {
        this._stop(); // closed while we were waiting for permission
        return;
      }
      this.video.srcObject = this.stream;
      this.video.classList.toggle('mirror', facing === 'user');
      this.fallbackInput.setAttribute('capture', facing);
      try {
        await this.video.play();
      } catch {
        /* autoplay restrictions: the preview still shows once the stream is attached */
      }
      this.captureBtn.disabled = false;
    }

    _capture() {
      const { videoWidth: w, videoHeight: h } = this.video;
      if (!w || !h) return;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(this.video, 0, 0);
      canvas.toBlob((blob) => {
        this._result = blob;
        this.dialog.close();
      }, 'image/png');
    }

    _fail(message) {
      this.error.textContent = message;
      this.error.hidden = false;
      this.fallback.hidden = false;
    }

    _stop() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.video.srcObject = null;
    }
  }

  function describe(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera access was denied. Allow it in your browser settings, or pick a photo instead:';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No matching camera was found. Try the other camera, or pick a photo instead:';
      case 'NotReadableError':
        return 'The camera is busy or unavailable (another app may be using it). You can pick a photo instead:';
      default:
        return `Could not start the camera (${(err && err.message) || err}). You can pick a photo instead:`;
    }
  }

  DC.CameraDialog = CameraDialog;
})();
