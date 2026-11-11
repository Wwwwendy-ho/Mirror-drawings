// Turning files / clipboard data into canvases. Nothing here touches the network.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const MAX_EDGE = 2048; // downscale huge phone photos so rendering stays smooth

  /**
   * Decode an image Blob into a canvas no larger than MAX_EDGE on its longest side.
   * Uses an <img>, which honours EXIF orientation in all current browsers.
   */
  async function decodeImage(blob, maxEdge = MAX_EDGE) {
    // createImageBitmap decodes off the rendering path (it does not stall in a
    // background tab) and applies EXIF orientation; <img> is the fallback for
    // browsers or formats where it fails.
    let source = null;
    let url = null;
    try {
      if (typeof createImageBitmap === 'function') {
        try {
          source = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        } catch {
          source = null;
        }
      }
      if (!source) {
        url = URL.createObjectURL(blob);
        source = new Image();
        source.src = url;
        await source.decode();
      }
      const sw = source.naturalWidth || source.width;
      const sh = source.naturalHeight || source.height;
      const r = Math.min(1, maxEdge / Math.max(sw, sh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw * r));
      canvas.height = Math.max(1, Math.round(sh * r));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      if (source.close) source.close();
      return canvas;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  /** First image file in a DataTransfer (drop or paste event), or null. */
  function imageFileFrom(dataTransfer) {
    if (!dataTransfer) return null;
    for (const item of dataTransfer.items || []) {
      if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
    }
    for (const file of dataTransfer.files || []) {
      if (file.type.startsWith('image/')) return file;
    }
    return null;
  }

  /**
   * Read an image from the async clipboard API. Resolves to a Blob, or null when
   * the clipboard holds no image. Rejects when the API is unavailable or denied.
   */
  async function readClipboardImage() {
    if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('Clipboard API unavailable');
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return item.getType(type);
    }
    return null;
  }

  DC.decodeImage = decodeImage;
  DC.imageFileFrom = imageFileFrom;
  DC.readClipboardImage = readClipboardImage;
})();
