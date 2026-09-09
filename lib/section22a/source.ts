/**
 * Where the 22A register comes from. The seam the real dataset arrives through.
 *
 * THE POINT OF THIS FILE. The prohibited-property list is published by the
 * Registration & Stamps department, and this repository does not have it. What
 * it ships instead is a demonstration register, in a committed file, that is
 * marked as such everywhere it surfaces. Replacing it must be ONE module and no
 * change anywhere in components/ -- so everything downstream of here (lib/db.ts,
 * the route, the store, the layer, the card) is written against
 * `Section22ASource` and never against a file path.
 *
 * To connect the real list later:
 *
 *   1. write `apIgrsSection22ASource` (or whatever it is called) implementing
 *      the interface below, mapping the department's rows into
 *      Section22ARecord and setting `authoritative: true`;
 *   2. return it from `section22aSourceFor()`;
 *   3. delete data/projects/<slug>/section-22a.json.
 *
 * Nothing else moves. The card's wording changes on its own, because it keys
 * off `authoritative`.
 *
 * WHY A FILE AND NOT A TABLE. The same reason `flatRegister()` in lib/db.ts is
 * a file: it is read on BOTH backends, so PostGIS and the committed snapshot
 * cannot disagree about it. A `section_22a` table would be empty on every
 * existing volume, `viaDb()` would succeed with zero rows, the snapshot
 * fallback would never fire, and the layer would draw nothing with docker up
 * while drawing the register with docker down. HANDOFF.md records that
 * split-brain twice; this feature is not going to add a third.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isValidSlug, PROJECTS_DIR } from '../projects.ts';
import type { Section22ARecord } from './types.ts';

export interface Section22AListing {
  records: Section22ARecord[];
  /** ISO date the register was read from its publisher. */
  retrieved_on: string | null;
}

export interface Section22ASource {
  /** Stamped on the response as `x-ulpin-22a-source`. */
  id: string;
  /** Shown on the card and in the legend, as the register's own name. */
  label: string;
  /**
   * Is this the government's list?
   *
   * FALSE for anything this repository ships. Every surface that shows a 22A
   * result adds SECTION_22A_MOCK_NOTE while it is false, so the honesty of the
   * interface is a property of the data rather than of someone remembering.
   */
  authoritative: boolean;
  /**
   * The register for one project.
   *
   * May throw, and may return an empty listing. Both mean the same thing to the
   * caller -- there is no register for this project -- and lib/db.ts turns
   * either into an empty FeatureCollection rather than an error, because a
   * project with no register is a normal state and not a failure.
   */
  list(slug: string): Promise<Section22AListing>;
}

/** Shape of the committed file. `records` is the only required key. */
interface RegisterFile {
  source_label?: string;
  retrieved_on?: string | null;
  records?: unknown;
}

/**
 * The MVP register: data/projects/<slug>/section-22a.json.
 *
 * Sits beside flat-register.json and residents.json, which are the other two
 * per-project records that are not cadastre. A project with no file simply has
 * no register -- that is the flat-register contract, and it is why an absent
 * file is not an error here.
 *
 * Records are validated structurally rather than with zod, matching the rest of
 * the data layer (only the two login routes use zod). A row missing a required
 * field is DROPPED rather than defaulted: a 22A entry with no survey number and
 * no parcel reference cannot be shown honestly, and inventing a placeholder for
 * it would put words into a register's mouth.
 */
export const fileSection22ASource: Section22ASource = {
  id: 'mock-file',
  label: 'Demonstration 22A register (not a government list)',
  authoritative: false,

  async list(slug: string): Promise<Section22AListing> {
    if (!isValidSlug(slug)) return { records: [], retrieved_on: null };
    let raw: string;
    try {
      raw = await fs.readFile(
        path.join(PROJECTS_DIR, slug, 'section-22a.json'),
        'utf-8',
      );
    } catch {
      // No register for this project. Not an error: see above.
      return { records: [], retrieved_on: null };
    }

    let parsed: RegisterFile;
    try {
      parsed = JSON.parse(raw) as RegisterFile;
    } catch (err) {
      console.error(`[ulpin-22a] ${slug}/section-22a.json is not valid JSON:`, err);
      return { records: [], retrieved_on: null };
    }

    const rows = Array.isArray(parsed.records) ? parsed.records : [];
    const records: Section22ARecord[] = [];
    for (const row of rows) {
      const record = coerceRecord(row);
      if (record) records.push(record);
    }
    return { records, retrieved_on: parsed.retrieved_on ?? null };
  },
};

const CATEGORIES = new Set([
  'GOVERNMENT_LAND', 'ASSIGNED_LAND', 'ENDOWMENT_LAND', 'WAKF_LAND',
  'BHOODAN_LAND', 'CEILING_SURPLUS', 'COURT_ORDER', 'OTHER',
]);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * One row of the file -> a record, or null if it cannot be one.
 *
 * Exported so lib/section22a.test.ts can assert the drop rules directly rather
 * than by writing malformed fixtures onto disk.
 */
export function coerceRecord(row: unknown): Section22ARecord | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;

  const id = str(r.id);
  const survey_no = str(r.survey_no);
  if (!id || !survey_no) return null;

  // A register that grows a second status is a register this application does
  // not understand yet, and the safe reading of an unknown status is NOT
  // "prohibited". Dropped and logged rather than coerced, because relabelling
  // somebody else's classification as a prohibition is the one error here that
  // would be actively harmful.
  if (r.status !== undefined && r.status !== '22A_RESTRICTED') {
    console.error(`[ulpin-22a] record ${id} has unknown status ${String(r.status)}; dropped`);
    return null;
  }

  const category = typeof r.category === 'string' && CATEGORIES.has(r.category)
    ? (r.category as Section22ARecord['category'])
    : 'OTHER';

  const loc = (r.location ?? {}) as Record<string, unknown>;
  const location = {
    village: str(loc.village) ?? '',
    mandal: str(loc.mandal) ?? '',
    district: str(loc.district) ?? '',
    state: str(loc.state) ?? '',
  };

  const ref = r.parcel_ref as { kind?: unknown; id?: unknown } | null | undefined;
  const parcel_ref = ref && ref.kind === 'survey_parcel' && typeof ref.id === 'number'
    ? { kind: 'survey_parcel' as const, id: ref.id }
    : null;

  const geom = r.geometry as { type?: unknown; coordinates?: unknown } | null | undefined;
  const geometry = geom && geom.type === 'Polygon' && Array.isArray(geom.coordinates)
    ? (geom as Section22ARecord['geometry'])
    : null;

  return {
    id,
    status: '22A_RESTRICTED',
    category,
    clause: str(r.clause),
    survey_no,
    ulpin_14: str(r.ulpin_14),
    extent_sqm: typeof r.extent_sqm === 'number' && r.extent_sqm > 0
      ? r.extent_sqm : null,
    location,
    authority: str(r.authority),
    reference: str(r.reference),
    listed_on: str(r.listed_on),
    remarks: str(r.remarks),
    parcel_ref,
    geometry,
  };
}

/**
 * Which register serves a project.
 *
 * One lookup, so connecting the real dataset is an edit HERE and nowhere else.
 * Per-project rather than global because the two states in this repository
 * publish their lists separately, and a Telangana project must not be served
 * Andhra Pradesh's register the day one of them is connected.
 */
export function section22aSourceFor(slug: string): Section22ASource {
  void slug;
  return fileSection22ASource;
}
