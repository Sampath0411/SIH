/**
 * ISO 19152 mapping tests.
 *
 * Run with:  node --test lib/ladm.test.ts
 * (Node strips the type annotations natively; there is no build step.)
 *
 * Three properties are worth pinning here, and they are the three that would
 * be silently wrong rather than loudly broken:
 *
 *   1. THE IDENTIFIER. suIdForUtility() is a primary key minted in two places
 *      -- here and by ladm_utility_su_id() in db/02_functions.sql -- and the
 *      PostGIS backend and the snapshot backend must agree on it exactly.
 *      They disagreed once already, because SQL's lpad() truncates and
 *      padStart() does not.
 *
 *   2. THE DATUM. Every z stored here is orthometric; EPSG:4979 is
 *      ellipsoidal; the two differ by ~72 m at Visakhapatnam. A payload that
 *      quoted one and labelled it the other would be wrong by the height of
 *      a twenty-storey building, and nothing downstream could detect it.
 *
 *   3. WHAT THE REGISTER MAY SAY. A right that is not in the record must not
 *      appear because a card would look better with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRS_ELLIPSOIDAL, baUlpinFor, codesOfSuId, formatShare, heightRange,
  isTitledKind, jsonLd, rrrFromRegister, spatialUnitOfParcel, spatialUnitOfUnit,
  suIdForAirRights, suIdForUtility,
  type LADMParcelDoc,
} from './ladm.ts';
import type { FlatRegisterEntry, ParcelInfo, UnitInfo } from './types.ts';

/** The EGM96 separation at Siripuram's bbox centre. See lib/datum.test.ts. */
const VSKP_SEP = -72.1426065216065;

// ---------------------------------------------------------------- identifiers

test('a utility identifier pads to five digits and is left alone above that', () => {
  assert.equal(suIdForUtility('AP-VSP-3D26', 42), 'AP-VSP-3D26-UTL-00042');
  assert.equal(suIdForUtility('AP-VSP-3D26', 99999), 'AP-VSP-3D26-UTL-99999');
  /*
   * THE CASE THAT BROKE THE PRIMARY KEY.
   *
   * SQL's lpad('100000', 5, '0') returns '10000' -- it truncates a string
   * longer than the width, where padStart only ever pads up. The first
   * backfill of hyderabad-banjara mapped utility 100000 and utility 100001
   * onto the same su_id and died on the unique constraint, which is the good
   * outcome; the bad one would have been two corridors quietly becoming one.
   * Both implementations now special-case the wide id, and this is the
   * assertion that keeps them in step.
   */
  assert.equal(suIdForUtility('AP-VSP-3D26', 100000), 'AP-VSP-3D26-UTL-100000');
  assert.notEqual(
    suIdForUtility('AP-VSP-3D26', 100000),
    suIdForUtility('AP-VSP-3D26', 10000),
  );
});

test('an air-rights identifier strips punctuation out of the spec ids', () => {
  assert.equal(
    suIdForAirRights('AP-VSP-3D26', 'telugu-thalli-flyover', 'pier-07'),
    'AP-VSP-3D26-AIR-TELUGUTHALLIFLYOVER-PIER07',
  );
});

test('revenue codes read back off every identifier shape, not just ULPINs', () => {
  // A ULPIN, which lib/ulpin.ts could also parse.
  assert.deepEqual(codesOfSuId('AP-VSP-3D26-9999-001-09-901'),
    { state: 'AP', district: 'VSP', scheme: '3D26' });
  // A parcel.
  assert.deepEqual(codesOfSuId('TS-HYD-3D26-0042'),
    { state: 'TS', district: 'HYD', scheme: '3D26' });
  /*
   * The two shapes lib/ulpin.ts's codesOf() CANNOT read, because its pattern
   * requires a four-digit parcel number and everything after it. Resolving a
   * project from an identifier is the only way /api/v1/ladm/... knows which
   * AOI to ask, so a utility corridor and a flyover deck would have been
   * unaddressable if this had reused that function.
   */
  assert.deepEqual(codesOfSuId('AP-VSP-3D26-UTL-00042'),
    { state: 'AP', district: 'VSP', scheme: '3D26' });
  assert.deepEqual(codesOfSuId('AP-VSP-3D26-AIR-TTF-P07'),
    { state: 'AP', district: 'VSP', scheme: '3D26' });
  // And a string that is not an identifier at all still fails.
  assert.equal(codesOfSuId('not an identifier'), null);
  assert.equal(codesOfSuId(''), null);
});

test('a BA unit identifier is derived from the spatial unit it holds', () => {
  assert.equal(baUlpinFor('AP-VSP-3D26-9999-001-09-901'),
    'AP-VSP-3D26-9999-001-09-901-BA');
});

// --------------------------------------------------------------------- datum

test('a height range carries both datums, each against its own CRS', () => {
  const h = heightRange(55.31, 58.51, VSKP_SEP);
  assert.deepEqual(h.msl, { z_min: 55.31, z_max: 58.51 });
  assert.equal(h.ellipsoidal_crs, CRS_ELLIPSOIDAL);
  assert.ok(h.ellipsoidal, 'ellipsoidal pair is published');
  // h = H + N, so both ends shift by the separation and the SPAN is unchanged.
  assert.ok(Math.abs(h.ellipsoidal!.z_min - -16.8326065216065) < 1e-9);
  assert.ok(Math.abs(
    (h.ellipsoidal!.z_max - h.ellipsoidal!.z_min) - (58.51 - 55.31),
  ) < 1e-9);
});

test('an unmeasured separation omits the ellipsoidal pair rather than zeroing it', () => {
  /*
   * The whole point of the two-datum payload. A project with no DEM has no
   * geoid separation, and converting by 0 would assert that the geoid and the
   * ellipsoid coincide -- wrong everywhere, and wrong by 72 m here. An absent
   * field is a consumer's signal to leave the height alone; a present one
   * that happens to equal the stored value is indistinguishable from a real
   * conversion at a place where the separation is genuinely near zero.
   */
  for (const missing of [null, undefined]) {
    const h = heightRange(55.31, 58.51, missing as null);
    assert.equal(h.ellipsoidal, undefined);
    assert.equal(h.geoid_separation_m, undefined);
    // The stored pair is still served, and still labelled as orthometric.
    assert.deepEqual(h.msl, { z_min: 55.31, z_max: 58.51 });
    assert.match(h.datum_note, /orthometric/i);
  }
});

// ------------------------------------------------------------ spatial units

const FLAT: UnitInfo = {
  id: 995001,
  floor_id: 9909,
  unit_no: '901',
  level_no: 9,
  z_min: 84.71,
  z_max: 87.51,
  ring: { type: 'Polygon', coordinates: [[[83.319, 17.7233], [83.3191, 17.7233],
    [83.3191, 17.7234], [83.319, 17.7234], [83.319, 17.7233]]] },
  kind: 'flat',
  ulpin: 'AP-VSP-3D26-9999-001-09-901',
  built_m2: 178,
  carpet_m2: 128,
  owner: 'K. Sampath Kumar',
};

test('a volume carries its volumetric extent, and it is area times clear height', () => {
  const su = spatialUnitOfUnit(FLAT, VSKP_SEP);
  assert.equal(su.su_type, 'multi_storey');
  assert.equal(su.dimension, '3D');
  assert.equal(su.su_id, 'AP-VSP-3D26-9999-001-09-901');
  // The same arithmetic lib/deed/certificate.ts prints on the deed. If these
  // two ever disagree, one of them is lying to somebody holding a document.
  assert.ok(Math.abs(su.volume_m3! - 178 * (87.51 - 84.71)) < 1e-9);
});

test('a volume with no recorded area has no volume, rather than a zero one', () => {
  const { built_m2, ...noArea } = FLAT;
  void built_m2;
  const su = spatialUnitOfUnit(noArea as UnitInfo, VSKP_SEP);
  // Absent, not 0 -- 0 m³ is a claim that the volume is empty, which is a
  // different statement from "the register does not record an area".
  assert.equal(su.volume_m3, undefined);
  // The vertical extent is still known, because z is on the row itself.
  assert.ok(su.height);
});

test('a surface plot is 2D and has no vertical extent at all', () => {
  const parcel: ParcelInfo = {
    id: 9990, ulpin: 'AP-VSP-3D26-9999', area_m2: 2400, owner: 'Sampath Estates Pvt Ltd',
  };
  const su = spatialUnitOfParcel(parcel);
  assert.equal(su.su_type, 'surface');
  assert.equal(su.dimension, '2D');
  /*
   * NOT a height of zero. parcel.geom is a Polygon with no Z: the plot's
   * vertical extent is unrecorded, and a 0..0 range would say the plot is a
   * sheet of no thickness -- which would then be differenced against the
   * volumes standing on it.
   */
  assert.equal(su.height, undefined);
  assert.equal(su.volume_m3, undefined);
});

test('only separately titled kinds are titled', () => {
  for (const k of ['flat', 'retail', 'anchor']) assert.ok(isTitledKind(k), k);
  // A bay is appurtenant, a shaft is structural, and neither has a holder.
  for (const k of ['parking', 'circulation', 'atrium', 'elevator', 'stair', 'plant']) {
    assert.equal(isTitledKind(k), false, k);
  }
  // An older snapshot has no `kind` column; everything in one is a flat.
  assert.ok(isTitledKind(undefined));
});

// ------------------------------------------------------------------ shares

test('a share formats as a fraction and never as a decimal', () => {
  // 1/3 of a plot is exactly 1/3 on a document somebody keeps.
  assert.equal(formatShare({ num: 1, den: 3 }), '1/3');
  assert.equal(formatShare({ num: 1, den: 80 }), '1/80');
  // A whole holding reads as one thing, not as '1/1'.
  assert.equal(formatShare({ num: 1, den: 1 }), '1');
  assert.equal(formatShare(undefined), '1');
});

// --------------------------------------------------- the register, projected

const ENTRY: FlatRegisterEntry = {
  ownership: 'mortgaged',
  title_deed: 'DOC/2017/VSP/45738',
  registered_on: '2017-07-24',
  mortgage: {
    bank: 'State Bank of India',
    branch: 'Siripuram, Visakhapatnam',
    loan_no: 'SBI-HL-3051038',
    sanctioned_inr: 3_900_000,
    outstanding_inr: 3_159_000,
    emi_inr: 25_190,
    charge_from: '2017-07-25',
    closes_on: '2037-07-25',
  },
  tax: {
    authority: 'Greater Visakhapatnam Municipal Corporation',
    assessment_no: 'GVMC/50/1101/101',
    year: '2026-27',
    demand_inr: 14_600,
    paid_inr: 14_600,
    paid_on: '2026-08-02',
    due_on: '2026-09-30',
  },
  bills: [{
    kind: 'water', authority: 'GVMC Water Supply', account: 'GVMC-W-263380',
    period: 'Aug 2026', amount_inr: 680, paid: true,
    due_on: '2026-09-12', paid_on: '2026-09-04',
  }],
};

test('the register projects into the three LADM classes it actually contains', () => {
  const rrrs = rrrFromRegister(ENTRY);
  const types = rrrs.map((r) => `${r.rrr_class}:${r.rrr_type}`);
  assert.deepEqual(types, [
    'right:ownership',
    'restriction:mortgage',
    'responsibility:tax_demand',
  ]);
  // Every one is marked as coming from the register rather than the cadastre.
  // The two records have different owners and different update cadences, and
  // the panel says which is which.
  assert.ok(rrrs.every((r) => r.from_register === true));

  const charge = rrrs[1];
  assert.equal(charge.party?.name, 'State Bank of India');
  assert.equal(charge.party?.role, 'bank');
  assert.equal(charge.reference, 'SBI-HL-3051038');
  // The OUTSTANDING amount, not the sanctioned one: a charge is worth what is
  // still owed under it.
  assert.equal(charge.amount_inr, 3_159_000);

  // The property tax demand id the requirement asks for is the assessment no.
  assert.equal(rrrs[2].reference, 'GVMC/50/1101/101');
});

test('a bill is not a right, and is not projected into LA_RRR', () => {
  /*
   * ENTRY carries a water bill. A quarterly bill is a payment against a
   * service, not a right, restriction or responsibility IN the property, and
   * forcing it into LA_RRR to make the card look fuller would misuse the
   * class. The panel renders bills from their own record, as it already did.
   */
  const rrrs = rrrFromRegister(ENTRY);
  assert.equal(rrrs.length, 3);
  assert.ok(!rrrs.some((r) => /water|bill/i.test(r.description ?? '')));
});

test('a flat with no charge and no tax yields only the title it does have', () => {
  const bare: FlatRegisterEntry = {
    ownership: 'owned',
    title_deed: 'DOC/2023/VSP/41730',
    registered_on: '2023-11-20',
  };
  const rrrs = rrrFromRegister(bare);
  assert.equal(rrrs.length, 1);
  assert.equal(rrrs[0].rrr_type, 'ownership');
  assert.equal(rrrs[0].reference, 'DOC/2023/VSP/41730');
});

// ---------------------------------------------------------------- JSON-LD

test('the JSON-LD framing names the ISO classes and keeps the disclaimer', () => {
  const doc: LADMParcelDoc = {
    su: spatialUnitOfUnit(FLAT, VSKP_SEP),
    ba_unit: {
      ba_ulpin: 'AP-VSP-3D26-9999-001-09-901-BA',
      name: 'Flat 901',
      ba_type: 'condominium_unit',
      members: [
        {
          su_id: 'AP-VSP-3D26-9999-001-09-901',
          member_role: 'principal',
          share: { num: 1, den: 1 },
          su_type: 'multi_storey',
        },
        {
          su_id: 'AP-VSP-3D26-9999',
          member_role: 'undivided_share',
          share: { num: 1, den: 80 },
          su_type: 'surface',
        },
      ],
    },
    rrrs: rrrFromRegister(ENTRY),
    parties: [{ name: 'K. Sampath Kumar', party_type: 'natural_person', role: 'owner' }],
    easements: [],
    project: { slug: 'siripuram', name: 'Siripuram, Visakhapatnam' },
    disclaimer: 'Not an official government identifier.',
    issued_at: '2026-09-08T00:00:00.000Z',
  };
  const ld = jsonLd(doc);
  assert.equal(ld['@type'], 'LA_SpatialUnit');
  assert.equal(ld['@id'], 'urn:ulpin:AP-VSP-3D26-9999-001-09-901');
  const ba = ld.baUnit as Record<string, unknown>;
  assert.equal(ba['@type'], 'LA_BAUnit');
  // The share survives as a fraction into the serialised document.
  const members = ba.members as Array<Record<string, unknown>>;
  assert.equal(members[1].share, '1/80');
  // Both CRS are named, so a consumer can tell which height it is holding.
  const crs = ld.referenceSystem as Record<string, string>;
  assert.equal(crs.ellipsoidal, CRS_ELLIPSOIDAL);
  assert.match(crs.stored, /5773/);
  // The disclaimer rides on the document, exactly as it does on the deed.
  assert.match(String(ld.disclaimer), /not an official/i);
});
