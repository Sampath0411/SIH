'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useEnsureDetail, useViewStore } from '@/lib/store';
import { FLOOR_VIEW, MATERIALS } from '@/lib/cesium/materials';
import { liftFor } from '@/lib/cesium/explode';
import { sectionedRing } from '@/lib/cesium/section';
import { tagEntity } from '@/lib/cesium/tag';
import { toSceneZ } from '@/lib/cesium/terrain';
import { basementLift, depthBelowGround, depthCaption } from '@/lib/cesium/basement-lift';
import { ringCentroid, slicePlane, type HalfPlane } from '@/lib/geo';
import { levelLabel } from '@/lib/ulpin';

/**
 * The active building's floor stack: one translucent slab per level, basements
 * in solid grey.
 *
 * AN ISOLATED BASEMENT IS LIFTED INTO THE LIGHT. Below grade the level sits
 * inside the terrain, where the globe is opaque and the camera would have to
 * go under the surface to see it; the user isolated B2 and saw a hillside.
 * So when a basement is the isolated level (and the underground view, which
 * has its own way of showing the ground, is off) its plate, shell and
 * contents are drawn FLOOR_VIEW.BASEMENT_LIFT_CLEAR_M above the ground, in
 * a cooler grey than a storey, with a ring at true ground level, a dashed
 * tie-line down to where the plate really is, and a caption that quotes the
 * stored depth. The lift is computed once, in lib/cesium/basement-lift.ts,
 * and UnitsLayer and CameraDirector take the same number from the same
 * function, so the bays stand on the plate and the camera frames it.
 *
 * ISOLATED LEVEL. A level that is isolated is drawn as TWO surfaces, not one:
 *
 *   - a thin base plate (FLOOR_VIEW.PLATE_THICKNESS_M) at the level's base Z,
 *     which is the floor the flats stand on and the surface a click resolves to
 *     as "the floor" -- the level's own space, i.e. corridors and common areas;
 *   - a translucent shell spanning the level's FULL Z extent, so the height
 *     envelope is still readable instead of the level flattening to a sheet.
 *
 * The shell is the geometry that used to swallow the unit volumes when it was
 * drawn solid. It stops doing that on two counts: FLOOR_VIEW.SHELL_ALPHA is low
 * enough that the flats inside read straight through it, and Picker drills for
 * a unit tag before it will accept a floor tag, so the shell no longer wins the
 * pick ray either. Both halves of that fix are load-bearing -- dropping either
 * one brings the original defect back.
 *
 * The explode slider, the isolate state and the section plane are read through
 * CallbackProperty closures rather than by rebuilding entities, so dragging any
 * of them animates at frame rate instead of thrashing the entity collection.
 */

interface StackState {
  explodeT: number;
  isolated: number | null;
  visible: boolean;
  /**
   * Every above-ground level collapses to its base plate, not just the isolated
   * one. Set while a whole building is being sectioned: a full-thickness slab
   * would enclose the flats standing on it and hide them from the cut, which is
   * the same defect the isolated floor's plate exists to avoid.
   */
  plateAll: boolean;
  /**
   * Underground mode is on.
   *
   * Above-grade slabs are surface detail the mode is not about, and a stack of
   * them standing over the buried services is exactly the clutter the cutaway
   * exists to remove. Basements stay: a sewer through a basement is the thing
   * the user came down here to look at.
   *
   * Suppression is DERIVED from the mode rather than written back into
   * `layers.floors`, so leaving underground restores whatever the user had --
   * the same discipline BuildingsLayer's fade follows.
   */
  underground: boolean;
  /** Bumped whenever the section plane moves; see lib/cesium/section.ts. */
  sliceVersion: number;
  plane: HalfPlane | null;
}

export default function FloorStackLayer() {
  const { viewer, ground, ready } = useViewer();
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const mode = useViewStore((s) => s.mode);
  const explodeT = useViewStore((s) => s.explodeT);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const showFloors = useViewStore((s) => s.layers.floors);
  const underground = useViewStore((s) => s.underground);
  const slice = useViewStore((s) => s.slice);
  const buildings = useDataStore((s) => s.buildings);
  const detail = useEnsureDetail(mode === 'city' ? null : activeBuildingId);

  const stateRef = useRef<StackState>({
    explodeT: 0, isolated: null, visible: true, plateAll: false,
    underground: false, sliceVersion: 0, plane: null,
  });
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  const footprint = buildings?.features.find(
    (f) => f.properties.id === activeBuildingId,
  );

  useEffect(() => {
    stateRef.current.explodeT = explodeT;
    stateRef.current.isolated = isolatedFloor;
    // The slabs are shown when a level is isolated (FLOOR or UNIT mode), and
    // additionally in BUILDING mode while a section is being cut: the
    // architectural model steps aside for the slice (see BuildingModelLayer),
    // and the stack is what a section through a whole building is a section OF.
    stateRef.current.visible =
      showFloors && (mode === 'floor' || mode === 'unit'
        || (mode === 'building' && slice.enabled));
    stateRef.current.plateAll = mode === 'building' && slice.enabled;
    stateRef.current.underground = underground;
  }, [explodeT, isolatedFloor, showFloors, mode, slice.enabled, underground]);

  // The section plane is derived from the active footprint, so it is recomputed
  // when the slider moves rather than per frame. Bumping the version is what
  // tells every sectionedRing in the layer that its cached hierarchy is stale.
  useEffect(() => {
    const ring = footprint
      ? (footprint.geometry.coordinates as number[][][])[0]
      : null;
    stateRef.current.plane =
      slice.enabled && ring ? slicePlane(ring, slice.axis, slice.offset) : null;
    stateRef.current.sliceVersion += 1;
    if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
  }, [footprint, slice.enabled, slice.axis, slice.offset, viewer]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (!detail || mode === 'city' || activeBuildingId === null) return;

    const bprops = footprint?.properties;
    if (!bprops) return;

    const terrainH = ground.get(activeBuildingId);
    const ds = new Cesium.CustomDataSource('floor-stack');
    dsRef.current = ds;
    viewer.dataSources.add(ds);

    const readSection = () => ({
      version: stateRef.current.sliceVersion,
      plane: stateRef.current.plane,
    });

    const floors = [...detail.floors].sort((a, b) => a.level_no - b.level_no);
    const groundZ = toSceneZ(bprops.ground_elev, bprops.ground_elev, terrainH);
    const topLevel = Math.max(...floors.map((f) => f.level_no));

    // ---- ground-level ring, for the lifted basements ----------------------
    // One ring for the building, drawn at the true ground surface around the
    // footprint while any basement is lifted above it. It is the datum the
    // caption's depth is measured from, and the reason the lifted plate reads
    // as "brought up" rather than as another storey.
    const anyBasementLifted = () => {
      const s = stateRef.current;
      return s.visible && !s.underground && s.isolated !== null && s.isolated < 0;
    };
    {
      const fp = (detail.building.footprint.coordinates as number[][][])[0];
      if (fp && fp.length >= 4) {
        const ringZ = groundZ + 0.06;
        const flat: number[] = [];
        for (const [x, y] of fp) flat.push(x, y, ringZ);
        ds.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
            width: 2.5,
            material: new Cesium.ColorMaterialProperty(MATERIALS.groundRing),
            clampToGround: false,
            show: new Cesium.CallbackProperty(anyBasementLifted, false),
          },
        });
        // Its caption, at the north-east corner so it does not fight the
        // depth caption on the south edge.
        let ne = fp[0];
        for (const p of fp) if (p[0] + p[1] > ne[0] + ne[1]) ne = p;
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(ne[0], ne[1], ringZ),
          label: {
            text: 'Ground level',
            font: FLOOR_VIEW.LABEL_BAY_FONT,
            style: Cesium.LabelStyle.FILL,
            fillColor: MATERIALS.unitLabelFill,
            showBackground: true,
            backgroundColor: MATERIALS.depthLabelBg,
            backgroundPadding: new Cesium.Cartesian2(
              FLOOR_VIEW.LABEL_PADDING_PX[0], FLOOR_VIEW.LABEL_PADDING_PX[1],
            ),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            pixelOffset: new Cesium.Cartesian2(6, -6),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            show: new Cesium.CallbackProperty(anyBasementLifted, false),
          },
        });
      }
    }

    floors.forEach((fl, index) => {
      const ring = (fl.ring.coordinates as number[][][])[0];
      if (ring.length < 4) return;

      const z0 = toSceneZ(fl.z_min, bprops.ground_elev, terrainH);
      const z1 = toSceneZ(fl.z_max, bprops.ground_elev, terrainH);
      const isBasement = fl.level_no < 0;
      const level = fl.level_no;

      /** This basement is the isolated level and is being shown above ground. */
      const liftedBasement = () => {
        const s = stateRef.current;
        return isBasement && s.isolated === level && !s.underground;
      };
      // Basements must not lift with the explode slider: they are below grade
      // and lifting them through the ground reads as a rendering fault. The
      // one lift they take is the isolate lift, into the light.
      const lift = () => (isBasement
        ? (liftedBasement() ? basementLift(z0, groundZ, FLOOR_VIEW.BASEMENT_LIFT_CLEAR_M) : 0)
        : liftFor(index, stateRef.current.explodeT));
      const isolated = () => stateRef.current.isolated === level
        && (!isBasement || liftedBasement());
      /** Drawn as the thin base plate the flats stand on, rather than as a slab. */
      const asPlate = () => (isBasement
        ? liftedBasement()
        : (stateRef.current.isolated === level || stateRef.current.plateAll));

      // ---- slab / base plate ------------------------------------------------
      const slab = sectionedRing(ring, readSection);
      const entity = ds.entities.add({
        polygon: {
          hierarchy: slab.hierarchy,
          height: new Cesium.CallbackProperty(() => z0 + lift(), false),
          // Isolated, the slab collapses to the thin base plate the flats stand
          // on; the shell below carries the level's height instead.
          extrudedHeight: new Cesium.CallbackProperty(() => {
            const top = asPlate()
              ? z0 + FLOOR_VIEW.PLATE_THICKNESS_M
              : z1 - FLOOR_VIEW.SLAB_GAP_M;
            return top + lift();
          }, false),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              if (isBasement) {
                return liftedBasement() ? MATERIALS.basementPlate : MATERIALS.basementSlab;
              }
              if (asPlate()) return MATERIALS.floorPlate;
              return MATERIALS.floorSlab;
            }, false),
          ),
          outline: true,
          outlineColor: new Cesium.CallbackProperty(
            () => (isolated() ? MATERIALS.floorActiveOutline : MATERIALS.floorOutline),
            false,
          ) as unknown as Cesium.Color,
          shadows: Cesium.ShadowMode.DISABLED,
          show: new Cesium.CallbackProperty(() => {
            const s = stateRef.current;
            if (!s.visible) return false;
            // Underground keeps the basements and drops the rest.
            if (s.underground && !isBasement) return false;
            // Isolate hides every level but the chosen one. A section through
            // the whole building is the exception: nothing is isolated there,
            // and every slab is part of the cut.
            if (s.isolated !== null && s.isolated !== level) return false;
            return slab.survives();
          }, false),
        },
      });
      tagEntity(entity, { kind: 'floor', id: fl.id, level });

      // ---- height envelope --------------------------------------------------
      // Only ever drawn for the isolated level: at city or building scale a
      // shell per storey is a stack of fog, and the slabs already carry the
      // stack's shape.
      const shell = sectionedRing(ring, readSection);
      const shellEntity = ds.entities.add({
        polygon: {
          hierarchy: shell.hierarchy,
          height: new Cesium.CallbackProperty(() => z0 + lift(), false),
          extrudedHeight: new Cesium.CallbackProperty(() => z1 + lift(), false),
          material: new Cesium.ColorMaterialProperty(
            isBasement ? MATERIALS.basementShell : MATERIALS.floorShell,
          ),
          outline: true,
          outlineColor: MATERIALS.floorShellOutline,
          shadows: Cesium.ShadowMode.DISABLED,
          show: new Cesium.CallbackProperty(
            () => stateRef.current.visible && !stateRef.current.underground
              && isolated() && shell.survives(),
            false,
          ),
        },
      });
      // Tagged as the floor, like the plate: clicking the level's empty volume
      // is a statement about the level, and Picker prefers a unit whenever the
      // ray finds one first.
      tagEntity(shellEntity, { kind: 'floor', id: fl.id, level });

      // Isolated-floor rim: a bright polyline around the slab's top edge so
      // the highlight survives viewing angles where the translucent fill and
      // the outline are nearly edge-on. Rides the explode lift like the slab.
      const rim: number[] = [];
      for (let i = 0; i < ring.length - 1; i += 1) rim.push(ring[i][0], ring[i][1], 0);
      ds.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            const l = lift();
            const z = isolated() ? z1 + l + 0.03 : -1e6; // parked below ground
            const out: number[] = [];
            for (let v = 0; v < rim.length; v += 3) {
              out.push(rim[v], rim[v + 1], z);
            }
            return Cesium.Cartesian3.fromDegreesArrayHeights(out);
          }, false) as unknown as Cesium.PositionProperty,
          width: 3,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(
              () => (isolated()
                ? (isBasement ? MATERIALS.basementRim : MATERIALS.floorActiveOutline)
                : Cesium.Color.TRANSPARENT),
              false,
            ),
          ),
          clampToGround: false,
        },
      });

      // ---- depth indicator, basements only --------------------------------
      // A dashed tie-line from the LIFTED plate's south edge straight down to
      // where the level really is, and a caption at the top of it quoting the
      // stored depth. The line is what makes the lift honest: the plate is up
      // here, and this is how far down it actually sits.
      if (isBasement) {
        const c = ringCentroid(ring);
        let south = ring[0][1];
        for (const p of ring) if (p[1] < south) south = p[1];
        const tieLon = c.lon;
        const tieLat = south;
        const depthM = depthBelowGround(bprops.ground_elev, fl.z_min);
        ds.entities.add({
          polyline: {
            positions: new Cesium.CallbackProperty(() => {
              const top = z0 + lift();
              return Cesium.Cartesian3.fromDegreesArrayHeights([
                tieLon, tieLat, top,
                tieLon, tieLat, z0,
              ]);
            }, false) as unknown as Cesium.PositionProperty,
            width: 2,
            material: new Cesium.PolylineDashMaterialProperty({
              color: MATERIALS.depthLine,
              dashLength: 12,
            }),
            clampToGround: false,
            show: new Cesium.CallbackProperty(() => liftedBasement() && slab.survives(), false),
          },
        });
        ds.entities.add({
          position: new Cesium.CallbackProperty(
            () => Cesium.Cartesian3.fromDegrees(tieLon, tieLat, z0 + lift() + 0.2),
            false,
          ) as unknown as Cesium.PositionProperty,
          label: {
            text: depthCaption(levelLabel(level, topLevel), depthM),
            font: FLOOR_VIEW.LABEL_FONT,
            style: Cesium.LabelStyle.FILL,
            fillColor: MATERIALS.unitLabelFill,
            showBackground: true,
            backgroundColor: MATERIALS.depthLabelBg,
            backgroundPadding: new Cesium.Cartesian2(
              FLOOR_VIEW.LABEL_PADDING_PX[0], FLOOR_VIEW.LABEL_PADDING_PX[1],
            ),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            pixelOffset: new Cesium.Cartesian2(0, -8),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            show: new Cesium.CallbackProperty(() => liftedBasement() && slab.survives(), false),
          },
        });
      }
    });

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, ground, detail, activeBuildingId, mode, footprint]);

  return null;
}
