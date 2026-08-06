/**
 * Trajectory capture surface: a surface of revolution of the two-phase
 * profile, built as one Cesium Primitive with one GeometryInstance per
 * azimuth sector so each sector can carry its own verdict color.
 * Geometry is in a local east-north-up frame at the exit; the primitive's
 * modelMatrix places it in the world.
 */

const NEUTRAL = () => Cesium.Color.fromCssColorString("#8ba3b8").withAlpha(0.30);

export class TrajectorySurface {
  constructor(viewer) {
    this.viewer = viewer;
    this.primitive = null;
    this.contours = [];
    this.sectors = 72;
  }

  clear() {
    if (this.primitive) {
      this.viewer.scene.primitives.remove(this.primitive);
      this.primitive = null;
    }
    for (const c of this.contours) this.viewer.entities.remove(c);
    this.contours = [];
  }

  /**
   * (Re)build at `exitCartesian` for `profile`. `colors` is an optional
   * array of css color strings per sector (verdicts); missing/null entries
   * render neutral. Rebuilding is cheap (~6k vertices), so verdict updates
   * re-call this rather than mutating per-instance attributes (which race
   * with requestRenderMode's lazy first render).
   */
  build(exitCartesian, profile, colors = null) {
    this.clear();
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(exitCartesian);

    // Ring drops: dense through the dive (where curvature lives), coarser in
    // the glide, and always include the exact transition drop.
    const drops = [0];
    for (let h = 8; h < profile.hTrans; h += 8) drops.push(h);
    drops.push(profile.hTrans);
    for (let h = profile.hTrans + 40; h < profile.hRange; h += 40) drops.push(h);
    drops.push(profile.hRange);
    const rings = drops.map((h) => ({ r: profile.radiusAt(h), z: -h }));

    const instances = [];
    const twoPi = Math.PI * 2;
    for (let s = 0; s < this.sectors; s++) {
      // Sector s is centred on the analysis ray azimuth s/sectors*360°.
      const a0 = ((s - 0.5) / this.sectors) * twoPi;
      const a1 = ((s + 0.5) / this.sectors) * twoPi;
      // azimuth 0 = north = +y in ENU; clockwise toward east (+x)
      const dir0 = [Math.sin(a0), Math.cos(a0)];
      const dir1 = [Math.sin(a1), Math.cos(a1)];
      const positions = new Float64Array(rings.length * 2 * 3);
      for (let i = 0; i < rings.length; i++) {
        const { r, z } = rings[i];
        positions.set([dir0[0] * r, dir0[1] * r, z, dir1[0] * r, dir1[1] * r, z], i * 6);
      }
      const indices = new Uint16Array((rings.length - 1) * 6);
      for (let i = 0; i < rings.length - 1; i++) {
        const b = i * 2;
        indices.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
      }
      instances.push(
        new Cesium.GeometryInstance({
          // Plain-number id: getGeometryInstanceAttributes matches by ===
          id: s,
          geometry: new Cesium.Geometry({
            attributes: new Cesium.GeometryAttributes({
              position: new Cesium.GeometryAttribute({
                componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                componentsPerAttribute: 3,
                values: positions,
              }),
            }),
            indices,
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)),
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              colors?.[s]
                ? Cesium.Color.fromCssColorString(colors[s]).withAlpha(0.38)
                : NEUTRAL()
            ),
          },
        })
      );
    }

    this.primitive = this.viewer.scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
          closed: false,
          renderState: { cull: { enabled: false } },
        }),
        modelMatrix: enu,
        asynchronous: false,
      })
    );

    // Contour rings every 200 m of drop — makes the surface readable in 3D.
    for (let h = 200; h <= profile.hRange; h += 200) {
      const r = profile.radiusAt(h);
      const pts = [];
      for (let i = 0; i <= 90; i++) {
        const a = (i / 90) * twoPi;
        pts.push(
          Cesium.Matrix4.multiplyByPoint(
            enu,
            new Cesium.Cartesian3(Math.sin(a) * r, Math.cos(a) * r, -h),
            new Cesium.Cartesian3()
          )
        );
      }
      this.contours.push(
        this.viewer.entities.add({
          polyline: {
            positions: pts,
            width: 1.2,
            material: Cesium.Color.WHITE.withAlpha(0.35),
          },
        })
      );
    }
  }

}
