/**
 * node --test lib/section22a.test.ts
 *
 * The guarantees the Section 22A layer makes, asserted rather than commented.
 *
 * Two of them matter more than the rest:
 *
 *   1. A 22A RECORD NEVER MODIFIES THE LAND. The ring a restricted parcel is
 *      drawn with is the cadastre's own ring, deep-equal to it and reachable
 *      from it -- not a simplified, buffered or re-wound copy. This is the same
 *      property lib/underground.test.ts asserts about the display layout, and
 *      for the same reason: the viewer may highlight a plot, it may never
 *      redraw one.
 *   2. THE SHIPPED REGISTER NEVER CLAIMS TO BE THE GOVERNMENT'S. Every record
 *      in this repository is a demonstration entry. If one of these files ever
 *      arrives marked authoritative, the interface stops printing the note that
 *      says so, and the application starts asserting that real plots are
 *      legally restricted. That is the most damaging thing this feature could
 *      do, so it is a test and not a review item.
 *
 * The last two blocks read the COMMITTED files, like lib/survey-parcel.test.ts:
 * these are properties of the data that shipped, not of an algorithm.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveSection22A, ringAreaSqm } from './section22a/resolve.ts';
import { coerceRecord } from './section22a/source.ts';
import {
  acresOf, extentsDisagree, SECTION_22A_CATEGORY_LABEL,
  SECTION_22A_CATEGORY_NOTE, SECTION_22A_DISCLAIMER, SECTION_22A_MOCK_NOTE,
  SQM_PER_ACRE, type Section22ACategory, type Section22ARecord,
} from './section22a/types.ts';
import type { GeoFC, SurveyParcelProps } from './types.ts';

const ROOT = process.cwd();

/** A square roughly 100 m x 100 m near the Siripuram AOI. */
const SQUARE: number[][] = [
  [83.320, 17.723],
  [83.3209434, 17.723],
  [83.3209434, 17.7239041],
  [83.320, 17.7239041],
  [83.320, 17.723],
];

function parcel(id: number, label: string, ring: number[][]) {
  return {
    type: 'Feature' as const,
    id,
    geometry: { type: 'Polygon' as const, coordinates: [ring] },
    properties: {
      id,
      label,
      ts_no: null,
      lpm_no: null,
      ulpin_14: null,
      extent_sqm: 10000,
      classification: null,
      provenance: 'derived' as const,
      source: null,
      source_date: null,
      building_count: 0,
      building_ids: [],
    },
  };
}

const PARCELS = {
  type: 'FeatureCollection',
  features: [parcel(42, '0042', SQUARE)],
} as unknown as GeoFC<SurveyParcelProps>;

function record(over: Partial<Section22ARecord> = {}): Section22ARecord {
  return {
    id: '22A-TEST-0001',
    status: '22A_RESTRICTED',
    category: 'GOVERNMENT_LAND',
    clause: '22A(1)(a)',
    survey_no: '104/2',
    ulpin_14: null,
    extent_sqm: 10000,
    location: {
      village: 'Siripuram',
      mandal: 'Visakhapatnam (Urban)',
      district: 'Visakhapatnam',
      state: 'Andhra Pradesh',
    },
    authority: 'District Collectorate, Visakhapatnam',
    reference: 'RC/VSP/22A/2019/1184',
    listed_on: '2019-06-14',
    remarks: null,
    parcel_ref: { kind: 'survey_parcel', id: 42 },
    geometry: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('a record with only a parcel reference borrows that parcel geometry, unchanged', () => {
  const { features, unlocated } = resolveSection22A([record()], PARCELS);
  assert.equal(unlocated.length, 0);
  assert.equal(features.length, 1);

  const f = features[0];
  assert.equal(f.properties.geometry_source, 'cadastre_match');
  assert.equal(f.properties.parcel_id, 42);
  assert.equal(f.properties.parcel_label, '0042');
  // THE GUARANTEE: byte-for-byte the cadastre's own ring.
  assert.deepEqual(f.geometry, PARCELS.features[0].geometry);
});

test('resolution does not mutate the parcel collection it read', () => {
  const before = JSON.stringify(PARCELS);
  resolveSection22A([record()], PARCELS);
  assert.equal(JSON.stringify(PARCELS), before);
});

test("a register that carries its own boundary keeps it, and the cadastre does not overrule it", () => {
  const own = {
    type: 'Polygon' as const,
    coordinates: [[
      [83.321, 17.724], [83.322, 17.724], [83.322, 17.725],
      [83.321, 17.725], [83.321, 17.724],
    ]],
  };
  const { features } = resolveSection22A(
    [record({ geometry: own })],
    PARCELS,
  );
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.geometry_source, 'register');
  assert.deepEqual(features[0].geometry, own);
  // The parcel is still named, so the card can still link to it -- but it did
  // not supply the boundary.
  assert.equal(features[0].properties.parcel_id, 42);
  assert.equal(features[0].properties.parcel_label, null);
});

test('a record naming no parcel and carrying no geometry is reported, not drawn', () => {
  const orphan = record({ id: '22A-TEST-ORPHAN', parcel_ref: null });
  const { features, unlocated } = resolveSection22A([record(), orphan], PARCELS);
  assert.equal(features.length, 1);
  assert.equal(unlocated.length, 1);
  assert.equal(unlocated[0].id, '22A-TEST-ORPHAN');
  assert.ok(!features.some((f) => f.properties.id === '22A-TEST-ORPHAN'));
});

test('a record naming a parcel this project does not hold is unlocated', () => {
  const { features, unlocated } = resolveSection22A(
    [record({ parcel_ref: { kind: 'survey_parcel', id: 999999 } })],
    PARCELS,
  );
  assert.equal(features.length, 0);
  assert.equal(unlocated.length, 1);
});

test('the mapped extent is measured from the drawn ring, not copied from the register', () => {
  const { features } = resolveSection22A([record({ extent_sqm: 1 })], PARCELS);
  const mapped = features[0].properties.mapped_extent_sqm;
  assert.ok(mapped !== null);
  // Very nearly the 100 m square SQUARE describes: its sides are 99.4 m and
  // 100.0 m at this latitude, so 9,933 m² is the right answer and 10,000 is
  // the round number the coordinates were picked to approximate.
  assert.ok(Math.abs((mapped as number) - 9933) < 5, `mapped ${mapped}`);
  // The register's own claim survives beside it, untouched.
  assert.equal(features[0].properties.extent_sqm, 1);
});

test('a degenerate ring measures as unknown rather than as zero area', () => {
  assert.equal(ringAreaSqm([[83.32, 17.72], [83.32, 17.72]]), null);
  assert.equal(ringAreaSqm(SQUARE) !== null, true);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('a row with no id or no survey number is dropped', () => {
  assert.equal(coerceRecord({ survey_no: '1/1' }), null);
  assert.equal(coerceRecord({ id: 'x' }), null);
  assert.equal(coerceRecord(null), null);
  assert.equal(coerceRecord('nope'), null);
});

test('a row with an unknown status is dropped, never relabelled as a prohibition', () => {
  const row = { id: 'x', survey_no: '1/1', status: 'CLEARED' };
  assert.equal(coerceRecord(row), null);
});

test('an unrecognised category falls back to OTHER rather than dropping the prohibition', () => {
  const r = coerceRecord({ id: 'x', survey_no: '1/1', category: 'MYSTERY' });
  assert.equal(r?.category, 'OTHER');
});

// ---------------------------------------------------------------------------
// Wording and units
// ---------------------------------------------------------------------------

test('every category has a label and an explanation', () => {
  const categories: Section22ACategory[] = [
    'GOVERNMENT_LAND', 'ASSIGNED_LAND', 'ENDOWMENT_LAND', 'WAKF_LAND',
    'BHOODAN_LAND', 'CEILING_SURPLUS', 'COURT_ORDER', 'OTHER',
  ];
  for (const c of categories) {
    assert.ok(SECTION_22A_CATEGORY_LABEL[c], `no label for ${c}`);
    assert.ok(SECTION_22A_CATEGORY_NOTE[c], `no note for ${c}`);
  }
  assert.equal(Object.keys(SECTION_22A_CATEGORY_LABEL).length, categories.length);
  assert.equal(Object.keys(SECTION_22A_CATEGORY_NOTE).length, categories.length);
});

test('the disclaimer tells the reader to verify the official record', () => {
  assert.match(SECTION_22A_DISCLAIMER, /verify the latest official land records/i);
  assert.match(SECTION_22A_MOCK_NOTE, /NOT the Registration & Stamps/);
});

test('acres convert against the statutory figure', () => {
  assert.equal(acresOf(SQM_PER_ACRE), 1);
  assert.ok(Math.abs(acresOf(9506.7) - 2.349) < 0.001);
});

test('extents are only called into question when they differ by more than 5%', () => {
  assert.equal(extentsDisagree(10000, 10400), false);
  assert.equal(extentsDisagree(10000, 12000), true);
  // Nothing to compare is not a disagreement.
  assert.equal(extentsDisagree(null, 10000), false);
  assert.equal(extentsDisagree(10000, null), false);
});

// ---------------------------------------------------------------------------
// The registers that actually ship
// ---------------------------------------------------------------------------

const SHIPPED = ['siripuram', 'hyderabad-banjara'];

for (const slug of SHIPPED) {
  const register = JSON.parse(readFileSync(
    path.join(ROOT, 'data', 'projects', slug, 'section-22a.json'), 'utf-8',
  ));
  const parcels = JSON.parse(readFileSync(
    path.join(ROOT, 'data', 'api', slug, 'survey_parcels.json'), 'utf-8',
  ));

  test(`${slug}: every parcel reference names a parcel that exists`, () => {
    const ids = new Set(parcels.features.map(
      (f: { properties: { id: number } }) => f.properties.id,
    ));
    for (const r of register.records) {
      if (!r.parcel_ref) continue;
      assert.ok(
        ids.has(r.parcel_ref.id),
        `${r.id} references survey parcel ${r.parcel_ref.id}, which ${slug} does not have`,
      );
    }
  });

  test(`${slug}: the shipped register does not present itself as the government list`, () => {
    // No record and no header may claim authority. The source that reads this
    // file is hard-coded non-authoritative (lib/section22a/source.ts), and this
    // asserts the file agrees rather than relying on that alone.
    assert.equal(register.authoritative, undefined);
    assert.match(String(register._note), /NOT the Registration & Stamps/);
    assert.match(String(register.source_label), /not a government list/i);
    for (const r of register.records) {
      assert.equal(r.status, '22A_RESTRICTED');
      assert.ok(r.authority, `${r.id} names no authority`);
    }
  });

  test(`${slug}: every record parses and the located ones resolve`, () => {
    const records = register.records.map(coerceRecord);
    assert.ok(records.every(Boolean), 'a shipped record failed to parse');
    const { features, unlocated } = resolveSection22A(
      records as Section22ARecord[], parcels,
    );
    assert.equal(
      features.length + unlocated.length, register.records.length,
      'a record was neither drawn nor reported',
    );
    assert.ok(features.length > 0, 'nothing in this register can be drawn');
    for (const f of features) {
      assert.ok(f.properties.survey_no, `${f.properties.id} has no survey number`);
      assert.ok(f.properties.location.village, `${f.properties.id} has no village`);
      assert.ok(f.properties.location.mandal, `${f.properties.id} has no mandal`);
      assert.ok(f.properties.location.district, `${f.properties.id} has no district`);
    }
  });
}
