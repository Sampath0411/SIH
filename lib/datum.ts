/**
 * Vertical datum conversion: orthometric (EGM96 / MSL) <-> ellipsoidal (WGS84).
 *
 * WHY THIS EXISTS. Every height this application stores is ORTHOMETRIC. The
 * NRSC CartoDEM tile it samples is ellipsoidal, and scripts/dem.py converts
 * each sample down to EGM96 at ingest (EPSG:4979 -> EPSG:4326+5773), recording
 * `elev_datum: 'msl_egm96'` on the project. Cesium, on the other hand, is
 * ellipsoidal throughout: Cesium World Terrain, `Cartesian3.fromDegrees`'s
 * height argument and the camera's own height are all metres above the WGS84
 * ellipsoid. At Visakhapatnam the geoid sits about 65 m BELOW the ellipsoid,
 * so handing a stored 55.31 m to Cesium unconverted puts the building 65 m
 * into the ground.
 *
 * The app has been getting away with it because lib/cesium/terrain.ts re-hangs
 * every stack off sampled terrain -- `toSceneZ` keeps only the height ABOVE the
 * building's own recorded ground, so the datum cancels. That works whenever
 * there is a terrain sample. Without one there is nothing to cancel against,
 * and that is the branch this module serves.
 *
 * THE SEPARATION IS A PER-PROJECT CONSTANT, not a field. EGM96 is a long-
 * wavelength model; across an AOI of a few kilometres its undulation varies by
 * centimetres, far below the metre-scale accuracy of anything else here. So
 * scripts/dem.py evaluates it once at the project's bbox centre and records
 * `projects.geoid_sep_m`, and this module is arithmetic over that number.
 *
 * NULL IS NOT ZERO. A project with no DEM has no separation, and the honest
 * response is to leave the height alone and say so -- not to convert by zero,
 * which is an assertion that the geoid and the ellipsoid coincide. Every
 * function here returns the input unchanged when the separation is unknown,
 * and `hasDatum()` lets a caller tell the two apart.
 *
 * Pure and dependency-free, so it runs under `node --test`.
 */

/** The vertical datum stored heights are measured against. */
export const EGM96_DATUM = 'msl_egm96';

/** What to call each datum on screen. */
export const DATUM_LABEL: Record<string, string> = {
  msl_egm96: 'EGM96 orthometric (MSL)',
  ellipsoidal: 'WGS84 ellipsoidal',
};

/**
 * A geoid separation, or null when the project never recorded one.
 *
 * Negative where the geoid sits below the ellipsoid, which is the case over
 * all of peninsular India.
 */
export type GeoidSeparation = number | null | undefined;

/** True when `sep` is a usable separation rather than an absent one. */
export function hasDatum(sep: GeoidSeparation): sep is number {
  return typeof sep === 'number' && Number.isFinite(sep);
}

/**
 * Orthometric (MSL) -> ellipsoidal:  h = H + N.
 *
 * This is the direction the renderer needs. `H` is what the cadastre stores;
 * `h` is what Cesium wants. With N = -65 m, a building at 55.31 m MSL is at
 * -9.69 m ellipsoidal, which is where the globe actually puts that ground.
 *
 * Returns `H` unchanged when the separation is unknown.
 */
export function orthometricToEllipsoidal(H: number, sep: GeoidSeparation): number {
  if (!Number.isFinite(H) || !hasDatum(sep)) return H;
  return H + sep;
}

/**
 * Ellipsoidal -> orthometric (MSL):  H = h - N.
 *
 * The ingest direction, and the one a survey or drone deliverable arrives in.
 * It is the same conversion scripts/dem.py applies with pyproj; this is here so
 * that a height entering through the API rather than through the DEM pipeline
 * is normalised to the datum the rest of the system stores, instead of being
 * written straight into a column whose neighbours mean something else.
 *
 * Returns `h` unchanged when the separation is unknown.
 */
export function ellipsoidalToOrthometric(h: number, sep: GeoidSeparation): number {
  if (!Number.isFinite(h) || !hasDatum(sep)) return h;
  return h - sep;
}

/**
 * How to describe a converted height in one line, for the panel.
 *
 * Says what was done rather than only the result, because a reader comparing
 * this number against a survey sheet needs to know which datum they are
 * looking at -- the whole reason the two differ by 65 m here.
 */
export function datumNote(sep: GeoidSeparation): string {
  if (!hasDatum(sep)) {
    return 'Heights are orthometric (EGM96). No geoid separation recorded for '
      + 'this project, so no ellipsoidal conversion is applied.';
  }
  return `Heights are orthometric (EGM96). Geoid separation ${sep.toFixed(2)} m; `
    + `ellipsoidal height is ${sep < 0 ? sep.toFixed(2) : `+${sep.toFixed(2)}`} m `
    + 'against the stored value.';
}
