/**
 * Heading dial: north-up ring of verdict-colored sectors, with a needle for
 * the selected heading. Click or drag to select a heading for the profile
 * view. Mirrors the colors painted on the 3D surface.
 */

export class HeadingDial {
  /**
   * @param canvas   <canvas> element (square)
   * @param onSelect callback(azimuthDeg) when the user picks a heading
   */
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.colors = null; // array of css colors per sector
    this.sectors = 72;
    this.selected = null; // degrees
    this.enabled = false;

    const pick = (ev) => {
      if (!this.enabled) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left - rect.width / 2;
      const y = ev.clientY - rect.top - rect.height / 2;
      if (Math.hypot(x, y) < rect.width * 0.12) return; // dead centre
      let az = (Math.atan2(x, -y) * 180) / Math.PI;
      if (az < 0) az += 360;
      this.onSelect(az);
    };
    canvas.addEventListener("pointerdown", (ev) => {
      pick(ev);
      const move = (e) => pick(e);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  update({ colors = this.colors, selected = this.selected, enabled = this.enabled } = {}) {
    this.colors = colors;
    this.selected = selected;
    this.enabled = enabled;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const size = c.clientWidth;
    if (c.width !== size * dpr) {
      c.width = size * dpr;
      c.height = size * dpr;
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    const rOuter = size * 0.46;
    const rInner = size * 0.30;

    const twoPi = Math.PI * 2;
    for (let s = 0; s < this.sectors; s++) {
      // sector s covers azimuth [s, s+1) * 5°; canvas angle = az - 90°
      const a0 = ((s / this.sectors) * twoPi) - Math.PI / 2 - twoPi / (this.sectors * 2);
      const a1 = a0 + twoPi / this.sectors;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, a0 + 0.004, a1 - 0.004);
      ctx.arc(cx, cy, rInner, a1 - 0.004, a0 + 0.004, true);
      ctx.closePath();
      ctx.fillStyle = this.colors?.[s] ?? "rgba(139,163,184,0.25)";
      ctx.fill();
    }

    // cardinal ticks + labels
    ctx.fillStyle = "rgba(242,244,241,0.85)";
    ctx.font = `600 ${size * 0.075}px 'Archivo', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [az, label] of [[0, "N"], [90, "E"], [180, "S"], [270, "W"]]) {
      const a = ((az - 90) * Math.PI) / 180;
      ctx.fillText(label, cx + Math.cos(a) * rInner * 0.72, cy + Math.sin(a) * rInner * 0.72);
    }

    if (this.selected !== null) {
      const a = ((this.selected - 90) * Math.PI) / 180;
      ctx.strokeStyle = "#F2F4F1";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rInner * 0.35, cy + Math.sin(a) * rInner * 0.35);
      ctx.lineTo(cx + Math.cos(a) * (rOuter + 2), cy + Math.sin(a) * (rOuter + 2));
      ctx.stroke();
      ctx.fillStyle = "#F2F4F1";
      ctx.font = `500 ${size * 0.085}px 'IBM Plex Mono', monospace`;
      ctx.fillText(`${Math.round(this.selected)}°`, cx, cy);
    } else if (!this.enabled) {
      ctx.fillStyle = "rgba(242,244,241,0.4)";
      ctx.font = `500 ${size * 0.06}px 'Archivo', sans-serif`;
      ctx.fillText("no exit set", cx, cy);
    }
  }
}
