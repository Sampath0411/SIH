'use client';

import { useDataStore, useViewStore } from '@/lib/store';
import { utilityAssetLabel } from '@/lib/cesium/materials';

/**
 * Names the conflicts found by ST_3DIntersects while underground mode is on.
 *
 * The deliberate one -- a sewer routed straight through a basement, flagged
 * `unauthorised alignment` by the pipeline -- is surfaced first, because it is
 * the case the 3D test exists to catch.
 */
export default function ConflictBanner() {
  const underground = useViewStore((s) => s.underground);
  const selectUtility = useViewStore((s) => s.selectUtility);
  const selectedUtilityId = useViewStore((s) => s.selectedUtilityId);
  const conflicts = useDataStore((s) => s.conflicts);

  if (!underground || conflicts.length === 0) return null;

  // Unauthorised alignments first, then by id for stability.
  const ordered = [...conflicts].sort((a, b) => {
    const au = a.status === 'operational' ? 1 : 0;
    const bu = b.status === 'operational' ? 1 : 0;
    if (au !== bu) return au - bu;
    return a.id - b.id;
  });
  const lead = ordered[0];

  return (
    <div
      data-panel="conflict"
      role="status"
      aria-live="polite"
      className="glass pointer-events-auto w-full max-w-[560px] rounded-lg border-danger/60 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="pulse-conflict inline-block h-2 w-2 shrink-0 rounded-full bg-danger" />
        <span className="text-[12px] font-semibold text-dangerInk">
          {conflicts.length} utility/basement conflict
          {conflicts.length > 1 ? 's' : ''} detected
        </span>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-wide text-[rgb(var(--muted))]">
          ST_3DIntersects
        </span>
      </div>

      <p className="mt-1 text-[11px] leading-snug text-[rgb(var(--ink))]">
        {utilityAssetLabel(lead.asset_type)} #{lead.utility_id} (
        {lead.authority}) at {lead.depth_m.toFixed(1)} m passes through basement
        level {lead.level_no} of{' '}
        <span className="font-mono">{lead.building_ulpin}</span>
        {lead.status !== 'operational' ? (
          <span className="text-dangerInk"> — {lead.status}</span>
        ) : null}
        .
      </p>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {ordered.slice(0, 8).map((c) => (
          <button
            key={c.id}
            type="button"
            // The click selects a utility (by id) and the visible text is
            // the building ULPIN. Earlier versions had `aria-label="Select
            // utility <building_ulpin>"` which read as if the building
            // were the utility; a screen reader user following the spoken
            // label landed on the wrong entity. The label now names both,
            // and matches the visible text.
            aria-label={`Select utility ${c.utility_id} in ${c.building_ulpin}`}
            onClick={() => selectUtility(c.utility_id)}
            className={[
              'rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors',
              selectedUtilityId === c.utility_id
                ? 'bg-danger text-white'
                : 'bg-danger/15 text-dangerInk hover:bg-danger/30',
            ].join(' ')}
          >
            {c.building_ulpin}
          </button>
        ))}
        {ordered.length > 8 ? (
          <span className="px-1 py-0.5 text-[9px] text-[rgb(var(--muted))]">
            +{ordered.length - 8} more
          </span>
        ) : null}
      </div>
    </div>
  );
}
