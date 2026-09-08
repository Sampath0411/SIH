/**
 * The underground layer registry: what categories exist, where each one sits,
 * and how far it must stay from its neighbours.
 *
 * WHY THIS FILE EXISTS. The depth of a service used to be stated in three
 * unrelated places -- the VALUES list in scripts/utilities.sql, a hardcoded
 * DEPTHS map in the Legend, and the per-feature depth_m in every snapshot --
 * and they had already drifted apart from each other. This is the one place,
 * and the builder, the layer panel, the legend and the detail panel all read
 * it, so they agree by construction rather than by discipline.
 *
 * DEPTHS ARE RELATIVE TO LOCAL GROUND, not to a datum. That distinction is
 * the whole point of the redesign: the generator baked one AOI-wide mean
 * ground elevation into every vertex of every run, so over Siripuram's 63 m of
 * relief nearly half of the "1 m deep" network was drawn in mid-air. A band
 * here means "this many metres below whatever the ground is at that point",
 * and lib/underground/ground-field.ts is what supplies the ground.
 *
 * The hierarchy is DATA, not code. Changing the order, the depths or the
 * corridors is an edit to the array below and nothing else -- no geometry, no
 * UI and no material has a number of its own.
 */

/**
 * The categories the viewer can draw.
 *
 * Deliberately NOT `AssetType` from lib/types.ts. That union mirrors the
 * CHECK constraint on `utility.asset_type` and must not be widened to describe
 * something the database has no column for; this one is the DISPLAY taxonomy,
 * and `categoryOfAssetType` maps between them. Keeping them apart is what lets
 * the two existing projects keep rendering with no data migration at all.
 */
export type UtilityCategory =
  | 'telecom'
  | 'electrical'
  | 'water'
  | 'drainage'
  | 'sewer'
  | 'foundations';

/**
 * A depth band, in metres BELOW LOCAL GROUND. Both bounds are negative and
 * `min` is the deeper one, so `min <= nominal <= max` reads in the same
 * direction as the numbers do.
 */
export interface DepthBand {
  /** Deepest the category may be drawn. More negative than `max`. */
  min: number;
  /** Shallowest the category may be drawn. */
  max: number;
  /** Where a run with no usable recorded depth is placed. */
  nominal: number;
}

export interface UndergroundLayer {
  key: UtilityCategory;
  /** What the layer panel and the legend call the NETWORK. */
  label: string;
  /**
   * What the detail card and the conflict banner call ONE ASSET of it.
   *
   * Separate from `label` because they are different nouns: the checkbox that
   * shows every buried cable says "Electrical", and the card for the one the
   * user clicked says "Power duct". Collapsing them made one or the other
   * read wrongly.
   */
  assetLabel: string;
  /**
   * The colour, as hex.
   *
   * Stated here rather than as a Cesium.Color because this module is
   * deliberately Cesium-free -- the layer panel is prerendered, and importing
   * Cesium touches `window` at module scope. lib/cesium/materials.ts is what
   * turns these into Colors, and remains the only place that constructs one.
   */
  colour: string;
  /** Display depth band, metres below local ground. */
  band: DepthBand;
  /**
   * Lateral corridor offset from the centreline, metres, positive to the
   * right of the direction of travel.
   *
   * This is what stops six services occupying one line in plan view. The
   * generator's own offsets put water at +3.0 and power at +5.0 -- the same
   * verge, 2 m apart, at 0.25 and 0.20 m radii, which from the 70-130 m
   * underground camera is a single smear. These are spread far wider and
   * alternate sides, the way services are actually laid.
   *
   * Zero for the one category that is not a road corridor: foundations
   * belong to a building rather than to a verge.
   */
  lane: number;
  /**
   * Minimum VERTICAL clear distance to the category above, metres.
   *
   * Sized for the case where the lanes give no help -- two services that end
   * up over one another -- so it is a tube-clearance figure, not a spacing
   * policy. Deliberately small: the lateral lanes below already hold the
   * corridors 8-14 m apart, and requiring metres of vertical gap on top of
   * that would displace correctly-recorded depths for no visual gain.
   *
   * resolveCategoryDepths() is what applies it, and any depth it has to move
   * is reported to the user as a display offset rather than silently drawn.
   */
  clearance: number;
  /**
   * Resolution and draw order, shallowest first.
   *
   * Also the tie-break that makes the layout deterministic: when two runs
   * conflict it is always the lower-ordered (deeper) one that gives way.
   */
  order: number;
}

/**
 * The hierarchy.
 *
 * INVARIANT: the bands are pairwise disjoint. That is what guarantees two
 * categories cannot occupy the same space no matter what depths the data
 * carries, and lib/underground.test.ts asserts it -- so a later edit that
 * quietly reintroduces an overlap fails the suite rather than the demo.
 *
 * The colours that already existed (water blue, sewer brown, electrical
 * amber) are kept at their exact previous values so the two shipped projects
 * look unchanged. The new categories take hues clear of those, clear of the
 * built-form green, and clear of CONFLICT_COLOR's red.
 *
 * METRO IS NOT IN THIS LIST. Visakhapatnam has no metro, and a violet tunnel
 * 14 m under the demonstration AOI was the most confidently wrong thing in
 * the scene. categoryOfAssetType() refuses the stored type rather than the
 * snapshots being rewritten -- see the note there.
 */
export const UNDERGROUND_LAYERS: readonly UndergroundLayer[] = [
  {
    key: 'telecom',
    label: 'Telecom',
    assetLabel: 'Telecom duct',
    colour: '#F472B6',
    band: { min: -0.9, max: -0.5, nominal: -0.7 },
    lane: 8.0,
    clearance: 0.3,
    order: 0,
  },
  {
    key: 'electrical',
    label: 'Electrical',
    assetLabel: 'Power duct',
    colour: '#FACC15',
    band: { min: -1.4, max: -1.0, nominal: -1.2 },
    lane: 5.5,
    clearance: 0.3,
    order: 1,
  },
  {
    key: 'water',
    label: 'Water',
    assetLabel: 'Water main',
    colour: '#38BDF8',
    band: { min: -2.0, max: -1.5, nominal: -1.8 },
    lane: -3.0,
    clearance: 0.4,
    order: 2,
  },
  {
    key: 'drainage',
    label: 'Drainage',
    assetLabel: 'Storm drain',
    colour: '#2DD4BF',
    band: { min: -2.8, max: -2.2, nominal: -2.4 },
    lane: 2.5,
    clearance: 0.4,
    order: 3,
  },
  {
    /**
     * WIDER THAN THE REST, ON PURPOSE.
     *
     * Water and sewer are the two categories that come on by default, so they
     * are the pair a user sees first and the pair that has to read as two
     * things. At the recorded depths -- water -1.5 m, sewer -3.0 m -- and the
     * old -6.5 m lane they sat 1.5 m apart vertically and 3.5 m apart in
     * plan, which from the 70-130 m underground camera is one smear.
     *
     * The 2.5 m clearance is what separates them: resolveCategoryDepths()
     * pushes sewer down to 2.5 m clear of whatever sits above it, and the
     * band floor at -4.4 m is what lets it (it still clears the -4.5 m
     * foundations ceiling, so the bands stay pairwise disjoint). The lane
     * widening does the same job in plan. Both are DISPLAY offsets and both
     * are already disclosed by the detail panel's "Drawn for clarity" box --
     * the stored depth and coordinates are untouched.
     */
    key: 'sewer',
    label: 'Sewerage',
    assetLabel: 'Sewer main',
    colour: '#B45309',
    band: { min: -4.4, max: -3.0, nominal: -3.4 },
    lane: -9.0,
    clearance: 2.5,
    order: 4,
  },
  {
    // Not a corridor: the envelope of a building's basements, derived from the
    // cadastre rather than supplied as a utility run. Its band spans the depth
    // a basement stack can actually reach.
    key: 'foundations',
    label: 'Foundations',
    assetLabel: 'Foundation',
    colour: '#94A3B8',
    band: { min: -12.0, max: -4.5, nominal: -6.0 },
    lane: 0,
    clearance: 0.8,
    order: 5,
  },
];

export const UNDERGROUND_BY_KEY: Record<UtilityCategory, UndergroundLayer> =
  Object.fromEntries(
    UNDERGROUND_LAYERS.map((l) => [l.key, l]),
  ) as Record<UtilityCategory, UndergroundLayer>;

/** Every key, shallowest first. The order the panel and the legend list them in. */
export const UNDERGROUND_ORDER: readonly UtilityCategory[] =
  UNDERGROUND_LAYERS.map((l) => l.key);

/**
 * Which categories are on when nothing has said otherwise.
 *
 * Water and sewer. They are the two networks anyone opening this mode is
 * actually asking about -- what runs under this road, and what is it going to
 * hit -- and they are the pair the layout is tuned to separate (see the
 * sewer entry above). Everything else stays off: underground is a specialist
 * mode and five networks at once is the clutter this redesign exists to
 * remove, so the user turns on the rest of what they came to look at.
 */
export const UNDERGROUND_DEFAULTS: Record<UtilityCategory, boolean> = {
  telecom: false,
  electrical: false,
  water: true,
  drainage: false,
  sewer: true,
  foundations: false,
};

/**
 * Map a stored `asset_type` onto a display category.
 *
 * The legacy union is 'water' | 'sewer' | 'power' | 'metro'; 'power' is what
 * this taxonomy calls 'electrical'. The three new names are accepted too, so
 * a project seeded after db/migrations/004 widened the CHECK constraint reads
 * back without a second mapping table.
 *
 * Returns null for a type this build does not know, rather than guessing.
 * Filing an unrecognised asset under the nearest category would put a pipe on
 * screen in the wrong colour at the wrong depth, stated as fact -- the caller
 * skips it and says how many it skipped instead.
 */
export function categoryOfAssetType(t: string): UtilityCategory | null {
  switch (t) {
    case 'water': return 'water';
    case 'sewer': return 'sewer';
    case 'power': return 'electrical';
    case 'electrical': return 'electrical';
    // Visakhapatnam has no metro. The stored runs are left in the snapshots
    // and in the CHECK constraint -- this is the DISPLAY taxonomy and the
    // cadastre is not being migrated -- but nothing draws them, which is what
    // returning null means everywhere else in this switch.
    case 'metro': return null;
    case 'telecom': return 'telecom';
    case 'drainage': return 'drainage';
    case 'foundation':
    case 'foundations': return 'foundations';
    default: return null;
  }
}

/** How the panel and the legend print a band. */
export function formatBand(band: DepthBand): string {
  if (band.max - band.min > 2) {
    return `${band.max.toFixed(1)} … ${band.min.toFixed(1)} m`;
  }
  return `${band.nominal.toFixed(1)} m`;
}
