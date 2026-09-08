'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { CONFLICT_COLOR, CONFLICT_COLOR_DIM } from '@/lib/cesium/materials';
import { datumShift } from '@/lib/cesium/terrain';

/**
 * The result of a topology validation run, drawn on the scene.
 *
 * ONE MARKER PER FINDING, not a re-draw of the geometry that clashed. The
 * volumes involved are already on screen -- UtilitiesLayer draws the run,
 * UnitsLayer the parking bay, FloorStackLayer the basement slab -- and
 * outlining them again in red would mean maintaining a second copy of three
 * layers' layout maths, including the lane offsets and per-vertex terrain
 * reconciliation that lib/underground/layout.ts applies to every pipe. The
 * previous attempt at that in this codebase is ConflictLayer, whose header
 * comment is largely about the cost of staying coincident with the layer it
 * annotates.
 *
 * So a finding is drawn as what it is: a POINT IN SPACE where two volumes meet
 * or come too close, marked with a vertical pin that reaches up to grade so it
 * can be found from above, and a sphere at the depth itself. That is legible
 * at city scale, needs no agreement with any other layer, and is honest about
 * its own precision -- the panel carries the exact coordinates.
 *
 * RED IS THE ONLY HUE THIS APPLICATION SPENDS ON ALARM. CONFLICT_COLOR is
 * shared with ConflictLayer deliberately: a user who has learned that red
 * means "these two things are in each other's way" should not have to learn a
 * second red for the same statement arrived at a different way.
 */

/** Radius of the marker at the finding itself, metres. */
const PIN_R = 1.1;
/** How far above grade the pin's head sits, metres. */
const HEAD_ABOVE_GRADE = 6;

export default function TopologyLayer() {
  const { viewer, ground, ready } = useViewer();
  const buildings = useDataStore((s) => s.buildings);
  const findings = useViewStore((s) => s.topology.findings);
  const selected = useViewStore((s) => s.topology.selected);
  const gis2d = useViewStore((s) => s.gis2d);

  const stateRef = useRef({ selected: null as number | null, visible: true, t: 0 });
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  useEffect(() => {
    stateRef.current.selected = selected;
    stateRef.current.visible = !gis2d;
    if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
  }, [selected, gis2d, viewer]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (!findings.length) return;

    const ds = new Cesium.CustomDataSource('topology');
    dsRef.current = ds;
    viewer.dataSources.add(ds);

    // The findings carry stored (orthometric) heights, like everything else the
    // API serves. The scene is hung off sampled terrain, so they go through the
    // same reconciliation the utilities use -- one AOI-wide shift, because a
    // finding has no building of its own to be re-based against.
    const shift = datumShift(buildings, ground);

    findings.forEach((f, i) => {
      const z = f.z + shift;
      // Grade is not known per finding, so the head is placed relative to the
      // deepest thing it marks rather than to a ground sample that would be
      // wrong for half of them.
      const headZ = z + Math.abs(f.b.z_max - f.b.z_min) + HEAD_ABOVE_GRADE;

      const isSel = () => stateRef.current.selected === i;
      const anySel = () => stateRef.current.selected !== null;
      const show = () => stateRef.current.visible;

      /** Bright when selected or when nothing is; dimmed when another is. */
      const colour = () => (isSel() || !anySel() ? CONFLICT_COLOR : CONFLICT_COLOR_DIM);

      // The marker at the finding.
      const pin = ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, z),
        ellipsoid: {
          radii: new Cesium.Cartesian3(PIN_R, PIN_R, PIN_R),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(colour, false),
          ),
          outline: true,
          outlineColor: CONFLICT_COLOR,
          shadows: Cesium.ShadowMode.DISABLED,
          show: new Cesium.CallbackProperty(show, false),
        },
      });
      // Deliberately untagged. A finding is a statement ABOUT two entities that
      // are themselves pickable; making the marker pickable too would put a
      // third thing under the cursor that resolves to neither of them.
      void pin;

      // The stem, so a finding four metres under a car park can be seen from
      // the air. A clearance breach gets a thinner, dashed one: it is a warning
      // about a distance, not a report of an overlap.
      ds.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            f.lon, f.lat, z,
            f.lon, f.lat, headZ,
          ]),
          width: f.severity === 'critical' ? 3 : 2,
          material: f.severity === 'critical'
            ? new Cesium.ColorMaterialProperty(
              new Cesium.CallbackProperty(colour, false),
            )
            : new Cesium.PolylineDashMaterialProperty({
              color: new Cesium.CallbackProperty(colour, false),
              dashLength: 8,
            }),
          shadows: Cesium.ShadowMode.DISABLED,
          show: new Cesium.CallbackProperty(show, false),
        },
      });
    });

    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, ground, buildings, findings]);

  return null;
}
