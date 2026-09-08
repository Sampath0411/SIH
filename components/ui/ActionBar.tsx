'use client';

import { useViewStore } from '@/lib/store';

/**
 * Mode actions above the detail panel: step back out of the current level,
 * and toggle underground.
 *
 * Slice used to live here too, in a second copy that checked only
 * `activeBuildingId` -- so in the 2D GIS view it offered a cut the store
 * would then refuse. NavDock's copy also excludes `gis2d` and is the one
 * that survives; a toggle with two buttons and two different disable rules
 * is a bug waiting for someone to find the wrong one.
 *
 * Measure, Share and Split are gone rather than disabled. Three permanently
 * inert buttons in the panel a user looks at most is not a roadmap, it is
 * noise; nothing in the application referenced them.
 */
export default function ActionBar() {
  const mode = useViewStore((s) => s.mode);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const selectedUnitId = useViewStore((s) => s.selectedUnitId);
  const underground = useViewStore((s) => s.underground);
  const setUnderground = useViewStore((s) => s.setUnderground);
  const selectUnit = useViewStore((s) => s.selectUnit);
  const isolateFloor = useViewStore((s) => s.isolateFloor);
  const selectBuilding = useViewStore((s) => s.selectBuilding);

  const back = () => {
    if (selectedUnitId !== null) return selectUnit(null);
    if (isolatedFloor !== null) return isolateFloor(null);
    return selectBuilding(null);
  };

  const backLabel =
    selectedUnitId !== null
      ? 'Back to floor'
      : isolatedFloor !== null
        ? 'Back to building'
        : 'Back to city';

  return (
    <div data-panel="actions" className="glass pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg px-1.5 py-1">
      {mode !== 'city' ? (
        <button
          type="button"
          onClick={back}
          className="rounded px-2 py-1 text-[11px] text-[rgb(var(--ink))] tint-hover"
        >
          {backLabel}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setUnderground(!underground)}
        className={[
          'rounded px-2 py-1 text-[11px] transition-colors',
          underground
            ? 'is-active'
            : 'text-[rgb(var(--ink))] tint-hover',
        ].join(' ')}
      >
        Underground
      </button>
    </div>
  );
}
