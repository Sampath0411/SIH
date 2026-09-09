'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useEnsureSection22A, useViewStore } from '@/lib/store';
import { MATERIALS, SECTION_22A_HEX, SECTION_22A_VIEW } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { restrictedHatch } from '@/lib/cesium/textures';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import { flatLonLat, ringPoleOfInaccessibility } from '@/lib/geo';
import type { Section22AProps } from '@/lib/section22a/types';

/**
 * Section 22A restricted lands, draped on the ground.
 *
 * WHAT THESE POLYGONS ARE, AND ARE NOT. Every boundary drawn here is the
 * CADASTRE'S OWN -- the ring of the survey parcel the register entry names,
 * borrowed by reference and never modified (lib/section22a/resolve.ts asserts
 * that, and lib/section22a.test.ts asserts the assertion). This layer draws a
 * marking ON a plot; it does not draw a plot. The one exception is a register
 * that publishes its own boundary, and then that boundary is used instead of
 * ours, because a department is the authority on where its own land is.
 *
 * The register that ships with this repository is a DEMONSTRATION register.
 * The card, the legend and the API response all say so, and the layer draws it
 * identically either way: a highlight that got quieter for mock data would make
 * the honest state the invisible one.
 *
 * WHY IT IS NOT HIDDEN IN THE 2D GIS VIEW, unlike ParcelsLayer. Scene.tsx's
 * rule is that anything drawn ABOVE the ground stands down in 2D and anything
 * DRAPED ON it stays under the user's control. This is draped, it is off unless
 * the user asked for it, and restricted land over a cadastral sheet is exactly
 * what a GIS is for -- turning it off there would be the view overruling a
 * deliberate choice. It is mounted after SurveyParcelsLayer so it draws on top
 * of the cadastral fill rather than under it.
 *
 * ONE DATA SOURCE, NOT A BUCKET GRID. The parcel layers bucket 326 and 1,634
 * polygons so the frustum can cull them; a register is tens of entries, and a
 * grid of sixteen data sources for eight polygons is machinery with nothing to
 * do. If a real register ever runs to thousands, the swap is `createBucketGrid`
 * exactly as SurveyParcelsLayer uses it -- the build is already incremental and
 * the visibility sweep already matches on a name prefix.
 */

/** Data source names, so the visibility sweep and the checks agree on them. */
const DS_NAME = 'section-22a';
const DS_HALO = 'section-22a-halo';

export default function Section22ALayer() {
  const { viewer, ready } = useViewer();
  const show = useViewStore((s) => s.layers.section22a);
  const activeId = useViewStore((s) => s.activeSection22aId);

  // Nothing is fetched until the layer is first switched on, and nothing is
  // re-fetched when it is switched off and on again.
  const register = useEnsureSection22A(show);

  /**
   * The live visibility, readable from inside the build.
   *
   * The data source is created DURING the incremental build, which is after the
   * visibility effect below has run. Without this it would be born with
   * Cesium's default `show: true` and a register fetched while the layer was
   * being switched off would paint itself onto the map. Same ref, same reason,
   * as SurveyParcelsLayer's showRef and UtilitiesLayer's visibleRef.
   */
  const showRef = useRef(show);
  showRef.current = show;

  const features = useMemo(() => register?.features ?? [], [register]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (features.length === 0) return;

    const ds = new Cesium.CustomDataSource(DS_NAME);
    ds.show = showRef.current;
    viewer.dataSources.add(ds);

    // ONE condition object and ONE scalar shared by every label, not one each:
    // a constant property keeps Cesium's static geometry path, and identical
    // allocations per entity would achieve nothing. The idiom every layer here
    // uses.
    const labelCondition = new Cesium.DistanceDisplayCondition(
      0, SECTION_22A_VIEW.LABEL_MAX_DISTANCE_M,
    );
    const labelScale = new Cesium.NearFarScalar(
      SECTION_22A_VIEW.LABEL_SCALE_NEAR_M, 1.0,
      SECTION_22A_VIEW.LABEL_SCALE_FAR_M, SECTION_22A_VIEW.LABEL_SCALE_FAR,
    );

    // One material for the whole layer. Cesium batches ground polygons per
    // distinct material and ImageMaterialProperty compares its image by
    // reference, so sharing this is what collapses the register into a single
    // primitive instead of one per parcel.
    const hatch = new Cesium.ImageMaterialProperty({
      image: restrictedHatch(SECTION_22A_HEX),
      transparent: true,
    });

    /**
     * A numeric pick handle per feature.
     *
     * A 22A entry is identified by a string, EntityTag.id is a number, and a
     * hash of the string could collide -- which would open the card for the
     * wrong parcel. A counter cannot. The string travels in `tag.ref`, which is
     * what the Picker actually reads.
     */
    let handle = 0;

    const addFeature = (feature: (typeof features)[number]) => {
      const props = feature.properties as Section22AProps;
      const ring = (feature.geometry as { coordinates?: number[][][] })
        .coordinates?.[0];
      if (!ring) return;
      const flat = flatLonLat(ring);
      if (flat.length < 6) return;

      handle += 1;
      const positions = Cesium.Cartesian3.fromDegreesArray(flat);

      // The tint. A ground-classified polygon is also what makes the plot
      // pickable across its whole area rather than only on its outline.
      const face = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: new Cesium.ColorMaterialProperty(MATERIALS.section22aFill),
          // Cesium cannot outline a ground-clamped polygon -- it disables the
          // outline and warns every frame. The boundary is the polyline below,
          // which is the supported path and the one both parcel layers take.
          outline: false,
          // BOTH, not TERRAIN: in Photoreal mode the globe surface is hidden
          // and the ground the user sees is Google's mesh. A TERRAIN-only
          // classification would drape this onto a surface that is not being
          // drawn and the marking would vanish under the tiles.
          classificationType: Cesium.ClassificationType.BOTH,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(face, { kind: 'section22a', id: handle, ref: props.id });

      // The hatch, as a second draped polygon over the tint. Separate from the
      // fill rather than replacing it: the tint holds the plot at any zoom and
      // over any basemap, the hatch is what makes it read as a restriction.
      ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: hatch,
          outline: false,
          classificationType: Cesium.ClassificationType.BOTH,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });

      // The boundary, and the prominent element of the whole treatment. A plain
      // number for the width, never a CallbackProperty: a non-constant width
      // puts the polyline on Cesium's DYNAMIC updater and rebuilds every ground
      // polyline on every frame -- the trap RoadsLayer documents. The heavier
      // stroke for the selected plot is a separate halo entity below.
      ds.entities.add({
        polyline: {
          positions,
          width: SECTION_22A_VIEW.OUTLINE_PX,
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
          material: new Cesium.ColorMaterialProperty(MATERIALS.section22aOutline),
          zIndex: 3,
        },
      });

      // The marking's own label. At the pole of inaccessibility rather than the
      // centroid, for the reason SurveyParcelsLayer gives: a plot clipped around
      // a junction is often an L, and the average of its vertices lands on the
      // neighbour's land -- which for a restriction label would be a false
      // statement about someone else's property.
      const at = ringPoleOfInaccessibility(ring);
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat),
        label: {
          text: '22A',
          font: SECTION_22A_VIEW.LABEL_FONT,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: MATERIALS.section22aLabelFill,
          outlineColor: MATERIALS.section22aLabelOutline,
          outlineWidth: SECTION_22A_VIEW.LABEL_OUTLINE_PX,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Clamped, so the label sits on the terrain under it rather than at
          // ellipsoid height -- over Siripuram's 63 m of relief the difference
          // is a label floating above the far side of the ward.
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: labelCondition,
          scaleByDistance: labelScale,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    };

    const cancelBuild = buildIncrementally({
      items: features,
      step: addFeature,
      firstSlice: 40,
      // The viewer runs in requestRenderMode: without asking for a frame the
      // slices would only appear when something else happened to trigger one.
      onSlice: () => {
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
    });

    return () => {
      cancelBuild();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, features]);

  /**
   * The heavier boundary for the selected plot: one entity, created when there
   * is one to show and destroyed when there is not.
   *
   * The idiom ParcelsLayer, SurveyParcelsLayer and RoadsLayer all use, and for
   * the same reason: polyline width cannot animate on a static polyline, and a
   * per-frame callback on every plot would be N closures computing "not me".
   */
  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (!show || activeId === null) return;
    const feature = features.find((f) => f.properties.id === activeId);
    if (!feature) return;
    const ring = (feature.geometry as { coordinates?: number[][][] })
      .coordinates?.[0];
    if (!ring) return;
    const flat = flatLonLat(ring);
    if (flat.length < 6) return;

    const ds = new Cesium.CustomDataSource(DS_HALO);
    viewer.dataSources.add(ds);
    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(flat),
        width: SECTION_22A_VIEW.OUTLINE_ACTIVE_PX,
        clampToGround: true,
        classificationType: Cesium.ClassificationType.BOTH,
        material: new Cesium.ColorMaterialProperty(MATERIALS.section22aActive),
        zIndex: 4,
      },
    });
    viewer.scene.requestRender();

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, features, show, activeId]);

  /** Show or hide the layer. A flip, never a rebuild. */
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === DS_NAME || ds.name === DS_HALO) ds.show = show;
    }
    viewer.scene.requestRender();
  }, [viewer, show, features]);

  return null;
}
