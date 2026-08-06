/**
 * Track timeline: altitude vs time for the whole recording, with the
 * detected flight segment shaded and two draggable markers (exit,
 * deployment). Auto-detection gets close; the human confirms.
 */

export class TrackTimeline {
  /** onChange(iExit, iDeploy) fires when a marker drag ends. */
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.samples = null;
    this.iExit = null;
    this.iDeploy = null;
    this.drag = null; // 'exit' | 'deploy'

    canvas.addEventListener("pointerdown", (ev) => {
      if (!this.samples) return;
      const x = this._x(ev);
      const dExit = Math.abs(x - this._xOf(this.iExit));
      const dDep = Math.abs(x - this._xOf(this.iDeploy));
      if (Math.min(dExit, dDep) > 14) return;
      this.drag = dExit <= dDep ? "exit" : "deploy";
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!this.drag) return;
      const i = this._iOf(this._x(ev));
      if (this.drag === "exit") this.iExit = Math.min(i, this.iDeploy - 5);
      else this.iDeploy = Math.max(i, this.iExit + 5);
      this.draw();
    });
    const end = (ev) => {
      if (!this.drag) return;
      this.drag = null;
      canvas.releasePointerCapture?.(ev.pointerId);
      this.onChange(this.iExit, this.iDeploy);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  setData(samples, iExit, iDeploy) {
    this.samples = samples;
    this.iExit = iExit;
    this.iDeploy = iDeploy;
    this.draw();
  }

  _x(ev) {
    return ev.clientX - this.canvas.getBoundingClientRect().left;
  }

  _xOf(i) {
    const s = this.samples;
    const t0 = s[0].t;
    const t1 = s[s.length - 1].t;
    return ((s[i].t - t0) / (t1 - t0)) * this.canvas.clientWidth;
  }

  _iOf(x) {
    const s = this.samples;
    const t0 = s[0].t;
    const t1 = s[s.length - 1].t;
    const t = t0 + (Math.max(0, Math.min(1, x / this.canvas.clientWidth))) * (t1 - t0);
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t < t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== c.clientWidth * dpr) {
      c.width = c.clientWidth * dpr;
      c.height = c.clientHeight * dpr;
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = c.clientWidth;
    const h = c.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!this.samples) return;
    const s = this.samples;

    let hMin = Infinity;
    let hMax = -Infinity;
    for (const p of s) {
      if (p.h < hMin) hMin = p.h;
      if (p.h > hMax) hMax = p.h;
    }
    const y = (alt) => 4 + ((hMax - alt) / Math.max(1, hMax - hMin)) * (h - 8);

    // flight segment shading
    const xE = this._xOf(this.iExit);
    const xD = this._xOf(this.iDeploy);
    ctx.fillStyle = "rgba(127,189,245,0.12)";
    ctx.fillRect(xE, 0, xD - xE, h);

    // altitude line
    ctx.strokeStyle = "rgba(242,244,241,0.7)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(s.length / w));
    for (let i = 0; i < s.length; i += step) {
      const px = this._xOf(i);
      const py = y(s[i].h);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // markers
    const marker = (x, color, label) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "9px 'Archivo', sans-serif";
      ctx.textAlign = x < w - 40 ? "left" : "right";
      ctx.textBaseline = "top";
      ctx.fillText(label, x + (x < w - 40 ? 3 : -3), 2);
    };
    marker(xE, "#da291c", "exit");
    marker(xD, "#C77FE8", "deploy");
  }
}
