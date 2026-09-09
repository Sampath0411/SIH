/**
 * Register entries -> drawable features. The ONLY place 22A geometry is decided.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a 22A record never modifies the land.
 * It either brings its own boundary, or it borrows the cadastre's by reference.
 * The ring handed back for a matched record is the SAME ARRAY the parcel
 * carries -- not a transformed, simplified, buffered or re-wound copy -- and
 * lib/section22a.test.ts asserts that by deep comparison, the way
 * lib/underground.test.ts asserts the display layout never touches the record.
 *
 * Pure: no Cesium, no pg, no fs. Given the same records and the same parcels it
 * returns the same features, which is what makes it testable and what lets the
 * server call it on both the PostGIS and the snapshot path.
 */
import type { GeoFC, SurveyParcelProps } from '../types.ts';
import type {
  Section22AFeature, Section22AProps, Section22ARecord,
} from './types.ts';

/** Metres per degree of latitude. The value lib/geo.ts and the tests use. */
const M_PER_DEG_LAT = 110574;

/**
 * Area of a lon/lat ring in m².
 *
 * Shoelace on a local equirectangular plane centred on the ring's own first
 * vertex. Over a parcel a few hundred metres across this is accurate to well
 * under a square metre, which is the same approximation scripts/project.py,
 * lib/geo.test.ts and lib/survey-parcel.test.ts all make for the same reason.
 *
 * Returns null for a degenerate ring rather than 0: "we could not measure it"
 * and "it has no area" are different answers, and the card must not print a
 * confident zero for a boundary it failed to read.
 */
export function ringAreaSqm(ring: number[][]): number | null {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const lat0 = ring[0][1];
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] * mPerDegLon;
    const yi = ring[i][1] * M_PER_DEG_LAT;
    const xj = ring[j][0] * mPerDegLon;
    const yj = ring[j][1] * M_PER_DEG_LAT;
    sum += xj * yi - xi * yj;
  }
  const area = Math.abs(sum) / 2;
  return Number.isFinite(area) && area > 0 ? area : null;
}

/** The outer ring of a GeoJSON Polygon geometry, or null if it is not one. */
function outerRing(geometry: unknown): number[][] | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g || g.type !== 'Polygon') return null;
  const rings = g.coordinates as number[][][] | undefined;
  const ring = Array.isArray(rings) ? rings[0] : undefined;
  return Array.isArray(ring) && ring.length >= 4 ? ring : null;
}

export interface Section22AResolution {
  features: Section22AFeature[];
  /**
   * Records nothing could be drawn for.
   *
   * Returned, not swallowed. The caller counts them onto the register meta so
   * the legend can say "1 record not located" -- because the alternative is a
   * map that silently under-reports a list of prohibitions.
   */
  unlocated: Section22ARecord[];
}

/**
 * Attach geometry to register entries.
 *
 * Resolution order, and the reason for it:
 *
 *   1. `record.geometry` WINS. A government register that publishes its own
 *      boundary is the authority on where its land is; our survey parcels are
 *      Voronoi cells derived from OpenStreetMap footprints. Letting a derived
 *      cell overrule a sourced boundary would be this application correcting a
 *      department's own record, which it is in no position to do.
 *   2. Otherwise `parcel_ref` is matched against the cadastre and that parcel's
 *      ring is borrowed, byte-identical, and its label carried so the card can
 *      mint the parcel ULPIN with the same generate() the survey card uses.
 *   3. Neither -> `unlocated`. NOT drawn at the district centroid, not drawn at
 *      a guessed location, not dropped in silence. A prohibition on land we
 *      cannot place is reported as exactly that.
 *
 * Matching is by parcel id and never by survey number. `survey_no` in the mock
 * register is a plausible revenue number, and this repository holds NO official
 * survey numbers at all (`SurveyParcelProps.ts_no` is null in every shipped
 * row) -- so a string match would either never fire or, worse, fire on a
 * coincidence and paint a prohibition onto somebody else's plot.
 */
export function resolveSection22A(
  records: Section22ARecord[],
  parcels: GeoFC<SurveyParcelProps>,
): Section22AResolution {
  const byId = new Map<number, (typeof parcels.features)[number]>();
  for (const f of parcels.features ?? []) {
    const id = (f.properties as SurveyParcelProps | null)?.id;
    if (typeof id === 'number') byId.set(id, f);
  }

  const features: Section22AFeature[] = [];
  const unlocated: Section22ARecord[] = [];

  for (const record of records) {
    const { geometry, ...rest } = record;

    const own = outerRing(geometry);
    if (own) {
      const props: Section22AProps = {
        ...rest,
        parcel_id: record.parcel_ref?.id ?? null,
        parcel_label: null,
        mapped_extent_sqm: ringAreaSqm(own),
        geometry_source: 'register',
      };
      features.push({
        type: 'Feature',
        id: record.id,
        // The register's own geometry object, passed through untouched.
        geometry: geometry as Section22AFeature['geometry'],
        properties: props,
      });
      continue;
    }

    const parcel = record.parcel_ref ? byId.get(record.parcel_ref.id) : undefined;
    const borrowed = parcel ? outerRing(parcel.geometry) : null;
    if (!parcel || !borrowed) {
      unlocated.push(record);
      continue;
    }

    const parcelProps = parcel.properties as SurveyParcelProps;
    const props: Section22AProps = {
      ...rest,
      parcel_id: parcelProps.id,
      parcel_label: parcelProps.label,
      mapped_extent_sqm: ringAreaSqm(borrowed),
      geometry_source: 'cadastre_match',
    };
    features.push({
      type: 'Feature',
      id: record.id,
      // The parcel's own geometry object. Borrowed by reference on purpose:
      // there is then no copy that could drift from the cadastre, and the
      // "geometry is never modified" guarantee is structural rather than
      // maintained by review.
      geometry: parcel.geometry,
      properties: props,
    });
  }

  return { features, unlocated };
}
