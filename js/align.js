// Automatic alignment: estimate the similarity transform (scale, rotation,
// translation) that maps one image onto another. Everything runs in the browser.
//
// Method: both images are reduced to small locally-normalised edge maps (so a
// pencil drawing and a photo are compared by structure, not tone). A coarse grid
// of scales and rotations is tried; for each, the best translation is found in
// one step by FFT cross-correlation. The best candidates are refined at a higher
// resolution with progressively finer steps. The normalised correlation peak
// (ncc) and its peak-to-sidelobe ratio (psr) say how trustworthy the match is.
//
// `alignCore` is self-contained on purpose: its source text is also used to
// build the Web Worker (via a Blob, which works from file:// too).

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const RASTER_MAX = 256; // longest side of the luminance raster handed to the matcher
  // Acceptance thresholds, set between the clusters seen in synthetic tests:
  // true matches scored ncc 0.43-0.73 / psr 21-35, unrelated pairs 0.26-0.35 / 13-17.
  // (Re-measured with the synthetic suite: see README "Auto-align".) Matches whose
  // best scale/rotation sits on the edge of the search range are also rejected.
  const NCC_MIN = 0.4;
  const PSR_MIN = 19;

  /**
   * @param {{data: Float32Array, w: number, h: number, k: number}} moving  luminance raster; k = source px per raster px
   * @param {{data: Float32Array, w: number, h: number, k: number}} fixed
   * @param {(progress: number) => void} [report]
   * @returns {{s:number, theta:number, tx:number, ty:number, ncc:number, psr:number}}
   *   Maps moving -> fixed in centred, oriented source pixels: pf = s * R(theta) * pm + t.
   */
  function alignCore(moving, fixed, report) {
    const SCALE_OCTAVE_STEPS = 8; // coarse scale step = 2^(1/8) ~ 9%
    const SCALE_RANGE = 10; // +-10 steps = 0.42x .. 2.4x
    const ROT_STEP = (4 * Math.PI) / 180;
    const ROT_RANGE = 8; // +-8 steps = +-32 degrees

    // ---- FFT (radix-2, in place) ----
    const tables = {};
    function table(n) {
      if (tables[n]) return tables[n];
      const rev = new Uint32Array(n);
      let bits = 0;
      while (1 << bits < n) bits++;
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        rev[i] = r;
      }
      const cos = new Float64Array(n / 2);
      const sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / n);
        sin[i] = Math.sin((2 * Math.PI * i) / n);
      }
      return (tables[n] = { rev, cos, sin });
    }
    function fft(re, im, n, inverse) {
      const { rev, cos, sin } = table(n);
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const step = n / len;
        for (let i = 0; i < n; i += len) {
          for (let k = 0, idx = 0; k < half; k++, idx += step) {
            const wr = cos[idx];
            const wi = inverse ? sin[idx] : -sin[idx];
            const a = i + k;
            const b = a + half;
            const xr = re[b] * wr - im[b] * wi;
            const xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi;
            re[a] += xr; im[a] += xi;
          }
        }
      }
    }
    function fft2(re, im, n, inverse) {
      for (let r = 0; r < n; r++) fft(re.subarray(r * n, r * n + n), im.subarray(r * n, r * n + n), n, inverse);
      const cr = new Float64Array(n);
      const ci = new Float64Array(n);
      for (let c = 0; c < n; c++) {
        for (let r = 0; r < n; r++) { cr[r] = re[r * n + c]; ci[r] = im[r * n + c]; }
        fft(cr, ci, n, inverse);
        for (let r = 0; r < n; r++) { re[r * n + c] = cr[r]; im[r * n + c] = ci[r]; }
      }
    }

    // ---- image helpers ----
    function halve(img) {
      const w = img.w >> 1;
      const h = img.h >> 1;
      const out = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = 2 * y * img.w + 2 * x;
          out[y * w + x] = (img.data[i] + img.data[i + 1] + img.data[i + img.w] + img.data[i + img.w + 1]) / 4;
        }
      }
      return { data: out, w, h, k: img.k * (img.w / w) };
    }
    function boxBlur(src, w, h, r) {
      const tmp = new Float32Array(w * h);
      const out = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0, n = 0;
          for (let d = -r; d <= r; d++) {
            const xx = x + d;
            if (xx >= 0 && xx < w) { sum += src[y * w + xx]; n++; }
          }
          tmp[y * w + x] = sum / n;
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0, n = 0;
          for (let d = -r; d <= r; d++) {
            const yy = y + d;
            if (yy >= 0 && yy < h) { sum += tmp[yy * w + x]; n++; }
          }
          out[y * w + x] = sum / n;
        }
      }
      return out;
    }
    /**
     * Gradient magnitude at full raster resolution. The pyramid is built from this
     * edge-energy map (not from luminance) so thin pencil lines survive downscaling.
     */
    function gradient(img) {
      const { w, h } = img;
      const g = boxBlur(img.data, w, h, 1);
      const mag = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
          const gx = g[y0 * w + x1] + 2 * g[y * w + x1] + g[y1 * w + x1] - g[y0 * w + x0] - 2 * g[y * w + x0] - g[y1 * w + x0];
          const gy = g[y1 * w + x0] + 2 * g[y1 * w + x] + g[y1 * w + x1] - g[y0 * w + x0] - 2 * g[y0 * w + x] - g[y0 * w + x1];
          mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
        }
      }
      return { data: mag, w, h, k: img.k };
    }
    /** Locally normalised edge energy, zero-mean, tapered at the borders. */
    function features(img) {
      const { w, h } = img;
      const mag = img.data;
      let mean = 0;
      for (let i = 0; i < mag.length; i++) mean += mag[i];
      mean /= w * h;
      const local = boxBlur(mag, w, h, Math.max(3, Math.round(Math.max(w, h) / 10)));
      const out = new Float32Array(w * h);
      let sum = 0;
      for (let i = 0; i < out.length; i++) {
        out[i] = Math.min(4, mag[i] / (local[i] + 0.5 * mean + 1e-6));
        sum += out[i];
      }
      const avg = sum / out.length;
      const smooth = boxBlur(out, w, h, 1);
      const edge = Math.max(2, Math.round(Math.min(w, h) * 0.08));
      for (let y = 0; y < h; y++) {
        const wy = Math.min(1, (Math.min(y, h - 1 - y) + 0.5) / edge);
        for (let x = 0; x < w; x++) {
          const wx = Math.min(1, (Math.min(x, w - 1 - x) + 0.5) / edge);
          smooth[y * w + x] = (smooth[y * w + x] - avg) * wx * wy;
        }
      }
      return { data: smooth, w, h, k: img.k };
    }
    /** Resample `feat` scaled by s and rotated by theta into a centred P x P grid; returns its energy. */
    function warp(feat, s, theta, P, out) {
      const { data, w, h } = feat;
      const c = Math.cos(theta) / s;
      const sn = Math.sin(theta) / s;
      const half = P / 2;
      let energy = 0;
      for (let gy = 0; gy < P; gy++) {
        const uy = gy + 0.5 - half;
        for (let gx = 0; gx < P; gx++) {
          const ux = gx + 0.5 - half;
          const px = ux * c + uy * sn + w / 2 - 0.5;
          const py = -ux * sn + uy * c + h / 2 - 0.5;
          let v = 0;
          if (px >= 0 && py >= 0 && px <= w - 1 && py <= h - 1) {
            const x0 = Math.floor(px), y0 = Math.floor(py);
            const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
            const fx = px - x0, fy = py - y0;
            v = (data[y0 * w + x0] * (1 - fx) + data[y0 * w + x1] * fx) * (1 - fy) +
                (data[y1 * w + x0] * (1 - fx) + data[y1 * w + x1] * fx) * fy;
          }
          out[gy * P + gx] = v;
          energy += v * v;
        }
      }
      return energy;
    }

    /**
     * A matcher for one resolution level: the fixed image's spectrum is computed once.
     * Candidates are evaluated two at a time: two real images packed into the real and
     * imaginary parts of one complex FFT, so each pair costs two FFTs instead of six.
     * Returns evaluateMany(list of [s, theta], wantPsr) -> list of results.
     */
    function makeLevel(movFeat, fixFeat, P) {
      const n2 = P * P;
      const Fr = new Float64Array(n2);
      const Fi = new Float64Array(n2);
      const fixEnergy = warp(fixFeat, 1, 0, P, Fr);
      fft2(Fr, Fi, P, false);
      const re = new Float64Array(n2);
      const im = new Float64Array(n2);
      const cr = new Float64Array(n2);
      const ci = new Float64Array(n2);
      const sub = (a, b, c) => {
        const d = a - 2 * b + c;
        return Math.abs(d) < 1e-12 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
      };
      /** Peak, sub-pixel offset and (optionally) peak-to-sidelobe ratio of a correlation surface. */
      function peak(buf, energy, s, theta, wantPsr) {
        let best = -Infinity, bi = 0;
        for (let i = 0; i < n2; i++) if (buf[i] > best) { best = buf[i]; bi = i; }
        const bx = bi % P, by = (bi - bx) / P;
        const at = (x, y) => buf[((y + P) % P) * P + ((x + P) % P)];
        let dx = bx + sub(at(bx - 1, by), best, at(bx + 1, by));
        let dy = by + sub(at(bx, by - 1), best, at(bx, by + 1));
        if (dx > P / 2) dx -= P;
        if (dy > P / 2) dy -= P;
        let psr = 0;
        if (wantPsr) {
          let sum = 0, sq = 0, n = 0;
          const guard = Math.max(4, P >> 4);
          for (let y = 0; y < P; y++) {
            const ddy = Math.min(Math.abs(y - by), P - Math.abs(y - by));
            for (let x = 0; x < P; x++) {
              const ddx = Math.min(Math.abs(x - bx), P - Math.abs(x - bx));
              if (ddx <= guard && ddy <= guard) continue;
              const v = buf[y * P + x];
              sum += v; sq += v * v; n++;
            }
          }
          const mean = sum / n;
          const sd = Math.sqrt(Math.max(1e-18, sq / n - mean * mean));
          psr = (best - mean) / sd;
        }
        return { ncc: best / n2 / Math.sqrt(energy * fixEnergy), dx, dy, psr, s, theta };
      }
      const empty = (s, theta) => ({ ncc: 0, dx: 0, dy: 0, psr: 0, s, theta });

      function pair(a, b, wantPsr) {
        const e1 = warp(movFeat, a[0], a[1], P, re);
        const e2 = b ? warp(movFeat, b[0], b[1], P, im) : (im.fill(0), 0);
        fft2(re, im, P, false);
        for (let ky = 0; ky < P; ky++) {
          const ny = ((P - ky) % P) * P;
          for (let kx = 0; kx < P; kx++) {
            const k = ky * P + kx, kn = ny + ((P - kx) % P);
            const zr = re[k], zi = im[k], wr = re[kn], wi = im[kn];
            // Spectra of the two real inputs: M1 = (Z + conj Z(-k)) / 2, M2 = (Z - conj Z(-k)) / 2i.
            const m1r = (zr + wr) / 2, m1i = (zi - wi) / 2;
            const m2r = (zi + wi) / 2, m2i = (wr - zr) / 2;
            // G = F * conj(M); the packed result is G1 + i*G2.
            const g1r = Fr[k] * m1r + Fi[k] * m1i, g1i = Fi[k] * m1r - Fr[k] * m1i;
            const g2r = Fr[k] * m2r + Fi[k] * m2i, g2i = Fi[k] * m2r - Fr[k] * m2i;
            cr[k] = g1r - g2i;
            ci[k] = g1i + g2r;
          }
        }
        fft2(cr, ci, P, true);
        const bad = (e) => e < 1e-9 || fixEnergy < 1e-9;
        const r1 = bad(e1) ? empty(a[0], a[1]) : peak(cr, e1, a[0], a[1], wantPsr);
        const r2 = !b ? null : bad(e2) ? empty(b[0], b[1]) : peak(ci, e2, b[0], b[1], wantPsr);
        return [r1, r2];
      }

      return function evaluateMany(list, wantPsr) {
        const out = [];
        for (let i = 0; i < list.length; i += 2) {
          const [r1, r2] = pair(list[i], list[i + 1], wantPsr);
          out.push(r1);
          if (r2) out.push(r2);
        }
        return out;
      };
    }

    // ---- pyramid: ~128 px for refinement, ~64 px for the coarse search ----
    const reduce = (img, target) => {
      let out = img;
      while (Math.max(out.w, out.h) > target * 1.5) out = halve(out);
      return out;
    };
    const movB = reduce(gradient(moving), 128), fixB = reduce(gradient(fixed), 128);
    const movA = reduce(movB, 64), fixA = reduce(fixB, 64);
    const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

    // ---- coarse search over scale x rotation ----
    const PA = pow2(2 * Math.max(movA.w, movA.h, fixA.w, fixA.h));
    const evalA = makeLevel(features(movA), features(fixA), PA);
    const coarse = [];
    const total = (2 * SCALE_RANGE + 1) * (2 * ROT_RANGE + 1);
    for (let si = -SCALE_RANGE; si <= SCALE_RANGE; si++) {
      const jobs = [];
      for (let ri = -ROT_RANGE; ri <= ROT_RANGE; ri++) jobs.push([Math.pow(2, si / SCALE_OCTAVE_STEPS), ri * ROT_STEP]);
      evalA(jobs, false).forEach((r, k) => {
        r.si = si; r.ri = k - ROT_RANGE;
        coarse.push(r);
      });
      if (report) report((0.6 * coarse.length) / total);
    }
    coarse.sort((a, b) => b.ncc - a.ncc);
    // A winner on the edge of the searched range usually means the true transform
    // lies outside it: the result is then only a clamped guess and must not be trusted.
    const atEdge = Math.abs(coarse[0].si) === SCALE_RANGE || Math.abs(coarse[0].ri) === ROT_RANGE;
    const candidates = [coarse[0]];
    const second = coarse.find((c) => Math.abs(c.si - coarse[0].si) > 1 || Math.abs(c.ri - coarse[0].ri) > 1);
    if (second) candidates.push(second);

    // ---- refine each candidate at the finer level ----
    const PB = pow2(2 * Math.max(movB.w, movB.h, fixB.w, fixB.h));
    const evalB = makeLevel(features(movB), features(fixB), PB);
    // 3x3 pattern search around the current best, halving the step each pass.
    const PASSES = 6;
    let sStep = 1 / (2 * SCALE_OCTAVE_STEPS); // in octaves
    let rStep = ROT_STEP / 2;
    const around = (best, skipCentre) => {
      const s0 = best.s, t0 = best.theta;
      const jobs = [];
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          if (skipCentre && i === 0 && j === 0) continue;
          jobs.push([s0 * Math.pow(2, i * sStep), t0 + j * rStep]);
        }
      }
      for (const r of evalB(jobs, false)) if (r.ncc > best.ncc) best = r;
      return best;
    };
    // First pass for every candidate; only the winner is refined further.
    let bestOverall = null;
    candidates.forEach((cand, ci) => {
      const best = around({ ncc: -1, s: cand.s, theta: cand.theta }, false);
      if (!bestOverall || best.ncc > bestOverall.ncc) bestOverall = best;
      if (report) report(0.6 + (0.1 * (ci + 1)) / candidates.length);
    });
    for (let pass = 1; pass < PASSES; pass++) {
      sStep /= 2;
      rStep /= 2;
      bestOverall = around(bestOverall, true);
      if (report) report(0.7 + (0.3 * pass) / (PASSES - 1));
    }

    const fin = evalB([[bestOverall.s, bestOverall.theta]], true)[0];
    return {
      s: (fin.s * fixB.k) / movB.k,
      theta: fin.theta,
      tx: fin.dx * fixB.k,
      ty: fin.dy * fixB.k,
      ncc: fin.ncc,
      psr: fin.psr,
      atEdge,
    };
  }

  /**
   * Luminance raster of an image in its displayed orientation (flips and 90-degree
   * turns applied), longest side RASTER_MAX.
   * @param {{source: HTMLCanvasElement, flipH: boolean, flipV: boolean, rotation: number}} img
   */
  function rasterize(img, maxSide = RASTER_MAX) {
    const turned = img.rotation % 180 !== 0;
    const bw = turned ? img.source.height : img.source.width;
    const bh = turned ? img.source.width : img.source.height;
    const f = maxSide / Math.max(bw, bh);
    const w = Math.max(8, Math.round(bw * f));
    const h = Math.max(8, Math.round(bh * f));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(w / 2, h / 2);
    ctx.scale(img.flipH ? -1 : 1, img.flipV ? -1 : 1);
    ctx.rotate((img.rotation * Math.PI) / 180);
    ctx.scale(w / bw, h / bh);
    ctx.drawImage(img.source, -img.source.width / 2, -img.source.height / 2);
    const px = ctx.getImageData(0, 0, w, h).data;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) {
      data[i] = (0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]) / 255;
    }
    return { data, w, h, k: bw / w };
  }

  // ---- worker plumbing (falls back to the main thread if workers are unavailable) ----
  let worker = null;
  let workerFailed = false;
  let seq = 0;
  const pending = new Map();

  function getWorker() {
    if (worker || workerFailed) return worker;
    try {
      const src = `${alignCore.toString()}
        onmessage = (e) => {
          const { id, moving, fixed } = e.data;
          try {
            const result = alignCore(moving, fixed, (p) => postMessage({ id, progress: p }));
            postMessage({ id, result });
          } catch (err) {
            postMessage({ id, error: String(err) });
          }
        };`;
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = (e) => {
        const job = pending.get(e.data.id);
        if (!job) return;
        if (e.data.progress !== undefined) {
          if (job.onProgress) job.onProgress(e.data.progress);
          return;
        }
        pending.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data.result);
      };
      worker.onerror = () => {
        workerFailed = true;
        worker = null;
        for (const job of pending.values()) job.retry();
        pending.clear();
      };
    } catch {
      workerFailed = true;
      worker = null;
    }
    return worker;
  }

  function runInline(moving, fixed, onProgress) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(alignCore(moving, fixed, onProgress));
        } catch (err) {
          reject(err);
        }
      }, 30); // let the "Aligning…" state paint first
    });
  }

  /**
   * Estimate the transform taking `moving` onto `fixed` (both from rasterize()).
   * Resolves with { s, theta, tx, ty, ncc, psr, confident }.
   */
  function estimate(moving, fixed, onProgress) {
    const w = getWorker();
    const run = w
      ? new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, {
            resolve,
            reject,
            onProgress,
            retry: () => runInline(moving, fixed, onProgress).then(resolve, reject),
          });
          w.postMessage({ id, moving, fixed });
        })
      : runInline(moving, fixed, onProgress);
    return run.then((r) => ({ ...r, confident: r.ncc >= NCC_MIN && r.psr >= PSR_MIN && !r.atEdge }));
  }

  DC.Aligner = { rasterize, estimate, alignCore, NCC_MIN, PSR_MIN };
})();
