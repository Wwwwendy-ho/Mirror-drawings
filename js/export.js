// Compose the visible pane canvases into one image and trigger a PNG download.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  /**
   * @param {{ layout: 'side'|'stacked'|'overlay', canvases: HTMLCanvasElement[], gap?: number, background?: string }} opts
   *   `gap` is in device pixels (the pane canvases are already DPR-scaled).
   */
  function composeExport({ layout, canvases, gap = 16, background = '#000' }) {
    const out = document.createElement('canvas');
    const vertical = layout === 'stacked';
    const widths = canvases.map((c) => c.width);
    const heights = canvases.map((c) => c.height);
    const spacing = gap * (canvases.length - 1);
    out.width = vertical ? Math.max(...widths) : widths.reduce((a, b) => a + b, 0) + spacing;
    out.height = vertical ? heights.reduce((a, b) => a + b, 0) + spacing : Math.max(...heights);

    const ctx = out.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    let offset = 0;
    for (const c of canvases) {
      if (vertical) {
        ctx.drawImage(c, 0, offset);
        offset += c.height + gap;
      } else {
        ctx.drawImage(c, offset, 0);
        offset += c.width + gap;
      }
    }
    return out;
  }

  function downloadCanvas(canvas, filename) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Could not encode PNG'));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        resolve();
      }, 'image/png');
    });
  }

  DC.composeExport = composeExport;
  DC.downloadCanvas = downloadCanvas;
})();
