/**
 * Profile chart: altitude vs distance along one heading.
 * Terrain silhouette (neutral fill) + trajectory line, verdict markers with
 * text labels (status color is never the only carrier), crosshair + tooltip.
 * Fit-to-box scaling with the vertical exaggeration factor displayed.
 */

const INK = {
  primary: "rgba(242,244,241,0.92)",
  secondary: "rgba(242,244,241,0.66)",
  muted: "rgba(242,244,241,0.38)",
  grid: "rgba(242,244,241,0.10)",
  terrainFill: "rgba(58,74,88,0.85)",
  terrainEdge: "rgba(139,163,184,0.9)",
  flight: "#7FBDF5",
  track: "#C77FE8",
};
const STATUS = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b" };

export class ProfileChart {
  /**
   * @param canvas  <canvas>
   * @param tooltip absolutely-positioned HTML element for hover readout
   */
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.state = null;

    canvas.addEventListener("pointermove", (ev) => this._hover(ev));
    canvas.addEventListener("pointerleave", () => {
      this.hoverD = null;
      this.tooltip.style.display = "none";
      if (this.state) this.draw();
    });
  }

  /**
   * @param samples  [{d, tDrop}] terrain along the heading
   * @param profile  makeProfile() result
   * @param exitAlt  absolute exit altitude (m, LN02)
   * @param analysis analyzeAzimuth() result
   * @param azimuth  degrees, for the title row
   * @param track    optional measured curve {d: [], drop: []} (FlySight)
   */
  update(samples, profile, exitAlt, analysis, azimuth, track = null) {
    this.state = { samples, profile, exitAlt, analysis, azimuth, track };
    this.draw();
  }

  _layout() {
    const { samples, profile } = this.state;
    const pad = { l: 54, r: 14, t: 22, b: 26 };
    const w = this.canvas.clientWidth - pad.l - pad.r;
    const h = this.canvas.clientHeight - pad.t - pad.b;
    const maxD = samples.length ? samples[samples.length - 1].d : profile.maxRadius;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const s of this.state.samples) {
      if (!Number.isFinite(s.tDrop)) continue;
      const z = this.state.exitAlt - s.tDrop;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    zMax = Math.max(zMax, this.state.exitAlt);
    zMin = Math.min(zMin, this.state.exitAlt - profile.hRange);
    const zPad = (zMax - zMin) * 0.05;
    zMin -= zPad;
    zMax += zPad;
    const x = (d) => pad.l + (d / maxD) * w;
    const y = (z) => pad.t + ((zMax - z) / (zMax - zMin)) * h;
    const exag = (w / maxD) === 0 ? 1 : (h / (zMax - zMin)) / (w / maxD);
    return { pad, w, h, maxD, zMin, zMax, x, y, exag };
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
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    if (!this.state) return;

    const { samples, profile, exitAlt, analysis } = this.state;
    const L = this._layout();
    const mono = "11px 'IBM Plex Mono', monospace";
    const ui = "11px 'Archivo', sans-serif";

    // grid: recessive, round steps
    ctx.strokeStyle = INK.grid;
    ctx.fillStyle = INK.muted;
    ctx.lineWidth = 1;
    ctx.font = mono;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const zStep = niceStep((L.zMax - L.zMin) / 5);
    for (let z = Math.ceil(L.zMin / zStep) * zStep; z <= L.zMax; z += zStep) {
      ctx.beginPath();
      ctx.moveTo(L.pad.l, L.y(z));
      ctx.lineTo(L.pad.l + L.w, L.y(z));
      ctx.stroke();
      ctx.fillText(String(Math.round(z)), L.pad.l - 6, L.y(z));
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const dStep = niceStep(L.maxD / 6);
    for (let d = dStep; d <= L.maxD; d += dStep) {
      ctx.fillText(String(Math.round(d)), L.x(d), L.pad.t + L.h + 6);
    }

    // terrain silhouette
    ctx.beginPath();
    let started = false;
    for (const s of samples) {
      if (!Number.isFinite(s.tDrop)) continue;
      const px = L.x(s.d);
      const py = L.y(exitAlt - s.tDrop);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    if (started) {
      ctx.strokeStyle = INK.terrainEdge;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.lineTo(L.x(L.maxD), L.pad.t + L.h);
      ctx.lineTo(L.x(samples[0]?.d ?? 0), L.pad.t + L.h);
      ctx.closePath();
      ctx.fillStyle = INK.terrainFill;
      ctx.fill();
    }

    // trajectory
    ctx.beginPath();
    ctx.moveTo(L.x(0), L.y(exitAlt));
    for (let d = 0; d <= Math.min(L.maxD, profile.maxRadius); d += 5) {
      ctx.lineTo(L.x(d), L.y(exitAlt - profile.dropAt(d)));
    }
    ctx.strokeStyle = INK.flight;
    ctx.lineWidth = 2;
    ctx.stroke();

    // measured track curve (dashed, direct-labeled)
    const track = this.state.track;
    if (track && track.d.length > 1) {
      ctx.beginPath();
      let on = false;
      for (let i = 0; i < track.d.length; i++) {
        if (track.d[i] > L.maxD) break;
        const px = L.x(track.d[i]);
        const py = L.y(exitAlt - track.drop[i]);
        if (!on) {
          ctx.moveTo(px, py);
          on = true;
        } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = INK.track;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      const iLab = Math.min(track.d.length - 1, Math.floor(track.d.length * 0.75));
      if (track.d[iLab] <= L.maxD) {
        ctx.fillStyle = INK.track;
        ctx.font = "11px 'Archivo', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("track", L.x(track.d[iLab]) + 5, L.y(exitAlt - track.drop[iLab]) + 4);
      }
    }

    // direct labels (identity never by color alone)
    ctx.font = ui;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = INK.flight;
    const dLab = Math.min(L.maxD, profile.maxRadius) * 0.45;
    ctx.fillText("flight path", L.x(dLab) + 6, L.y(exitAlt - profile.dropAt(dLab)) - 5);
    ctx.fillStyle = INK.terrainEdge;
    const sMid = samples[Math.floor(samples.length * 0.7)];
    if (sMid && Number.isFinite(sMid.tDrop)) {
      ctx.textBaseline = "top";
      ctx.fillText("terrain", L.x(sMid.d), L.y(exitAlt - sMid.tDrop) + 8);
    }

    // verdict markers, each with a text label
    if (analysis) {
      if (analysis.minClearanceD !== null && Number.isFinite(analysis.minClearance)) {
        const d = analysis.minClearanceD;
        const zt = exitAlt - terrainAt(samples, d);
        const zf = exitAlt - profile.dropAt(d);
        const col =
          analysis.minClearance < 30
            ? STATUS.critical
            : analysis.minClearance < 100
              ? STATUS.warning
              : STATUS.good;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(L.x(d), L.y(zf));
        ctx.lineTo(L.x(d), L.y(zt));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.font = mono;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(
          `min ${Math.round(analysis.minClearance)} m`,
          L.x(d) + 6,
          (L.y(zf) + L.y(zt)) / 2
        );
      }
      if (analysis.impactD !== null && analysis.impactKind) {
        const d = analysis.impactD;
        const z = exitAlt - profile.dropAt(d);
        const isLanding = analysis.impactKind === "landing";
        const col = isLanding ? STATUS.good : STATUS.critical;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(L.x(d), L.y(z), 4, 0, Math.PI * 2);
        ctx.fill();
        // 2px surface ring so the dot reads on any background
        ctx.strokeStyle = "rgba(14,20,27,0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = ui;
        ctx.textAlign = isLanding ? "right" : "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(
          `${analysis.impactKind} ${Math.round(d)} m`,
          L.x(d) + (isLanding ? -7 : 7),
          L.y(z) - 6
        );
      }
    }

    // vertical exaggeration tag
    ctx.fillStyle = INK.muted;
    ctx.font = mono;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(`V ×${L.exag.toFixed(1)}`, L.pad.l + L.w, L.pad.t - 16);

    // crosshair
    if (this.hoverD !== null && this.hoverD !== undefined) {
      const d = this.hoverD;
      ctx.strokeStyle = INK.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(L.x(d), L.pad.t);
      ctx.lineTo(L.x(d), L.pad.t + L.h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this._L = L;
  }

  _hover(ev) {
    if (!this.state || !this._L) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const L = this._L;
    const d = Math.max(0, Math.min(L.maxD, ((px - L.pad.l) / L.w) * L.maxD));
    this.hoverD = d;
    const { samples, profile, exitAlt } = this.state;
    const tz = exitAlt - terrainAt(samples, d);
    const fz = d <= profile.maxRadius ? exitAlt - profile.dropAt(d) : null;
    const clr = fz !== null && Number.isFinite(tz) ? fz - tz : null;
    this.tooltip.style.display = "block";
    this.tooltip.style.left = `${Math.min(px + 12, rect.width - 150)}px`;
    this.tooltip.style.top = `12px`;
    this.tooltip.innerHTML =
      `<b>${Math.round(d)} m</b> out<br>` +
      (Number.isFinite(tz) ? `terrain ${Math.round(tz)} m<br>` : `terrain — <br>`) +
      (fz !== null ? `flight ${Math.round(fz)} m<br>` : ``) +
      (clr !== null ? `clearance <b>${Math.round(clr)} m</b>` : ``);
    this.draw();
  }
}

function terrainAt(samples, d) {
  if (!samples.length) return NaN;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].d < d) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (!Number.isFinite(a.tDrop) || !Number.isFinite(b.tDrop)) return NaN;
  const f = b.d === a.d ? 0 : (d - a.d) / (b.d - a.d);
  return a.tDrop + (b.tDrop - a.tDrop) * f;
}

function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}
