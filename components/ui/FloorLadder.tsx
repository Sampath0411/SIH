'use client';
import { useMemo } from 'react';

import { useEnsureDetail, useViewStore } from '@/lib/store';
import { levelLabel } from '@/lib/ulpin';

/**
 * Vertical floor ladder: R, 6, 5 ... G, B1, B2.
 *
 * A UI control, so it is allowed to write to the store -- it calls
 * isolateFloor() and nothing else. It does not touch the camera; CameraDirector
 * reacts to the store change and drops the view to the chosen level.
 */
export default function FloorLadder({
  /**
   * Compact layouts lay the ladder along the bottom instead of down the side.
   * A prop rather than a second component: there must be exactly ONE ladder in
   * the document, because scripts/verify_ui.mjs finds rungs by scanning every
   * button for /^(G|[0-9]{1,2}|B[0-9])$/ and a hidden duplicate would be found
   * first and clicked instead.
   */
  orientation = 'vertical',
}: {
  orientation?: 'vertical' | 'horizontal';
} = {}) {
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const isolateFloor = useViewStore((s) => s.isolateFloor);
  const citizen = useViewStore((s) => s.session.role === 'citizen');
  const detail = useEnsureDetail(mode === 'city' ? null : activeBuildingId);
  // Subscribed, not read off getState(): a citizen's floor marker has to
  // follow the session if it is refreshed after mount.
  const sessionFloor = useViewStore((s) => s.session.floor);
  // Units grouped by level, once per document, rather than four passes over
  // every unit for every rung on every render.
  const unitsByLevel = useMemo(() => {
    const m = new Map<number, NonNullable<typeof detail>['units']>();
    for (const u of detail?.units ?? []) {
      const on = m.get(u.level_no);
      if (on) on.push(u); else m.set(u.level_no, [u]);
    }
    return m;
  }, [detail]);

  if (mode === 'city' || !detail || detail.floors.length === 0) return null;

  // Top of the building first, basements last -- the way a lift panel reads.
  const floors = [...detail.floors].sort((a, b) => b.level_no - a.level_no);
  // The building's real top, for the 'R' label -- not the top of whatever
  // subset of floors the caller was served.
  const top = detail.building.floors ?? floors[0]?.level_no ?? 0;

  const horizontal = orientation === 'horizontal';

  /** A rung's tooltip: what is on the level, and how deep it is if below. */
  const tooltipFor = (level: number): string => {
    const on = unitsByLevel.get(level) ?? [];
    const flats = on.filter((u) => (u.kind ?? 'flat') === 'flat').length;
    const bays = on.filter((u) => u.kind === 'parking').length;
    const what = flats ? `${flats} flat${flats === 1 ? '' : 's'}`
      : bays ? `${bays} parking bay${bays === 1 ? '' : 's'}`
        : on.some((u) => u.kind === 'plant') ? 'plant and tankage'
          : level === 0 ? 'entrance lobby' : 'no units';
    const f = detail.floors.find((x) => x.level_no === level);
    const depth = f && level < 0 && detail.building.ground_elev !== undefined
      ? ` · ${(detail.building.ground_elev - f.z_min).toFixed(1)} m below ground`
      : '';
    return `Level ${levelLabel(level, top)} · ${what}${depth}`;
  };

  // A citizen walks every level of their building; only the register behind
  // the neighbours' doors is withheld, and that is the server's job, not the
  // ladder's. Their own floor is marked so it can be found again.
  const ownLevel = citizen ? sessionFloor : null;

  return (
    <div
      data-panel="floors"
      className={[
        'glass pointer-events-auto rounded-lg p-1.5',
        horizontal ? 'flex items-center gap-2' : '',
      ].join(' ')}
    >
      <div
        className={[
          'text-[9px] uppercase tracking-widest text-[rgb(var(--muted))]',
          horizontal ? 'shrink-0 pl-1' : 'px-1 pb-1 text-center',
        ].join(' ')}
      >
        Level
      </div>
      <div
        className={
          horizontal
            ? 'flex gap-[3px] overflow-x-auto overscroll-contain pb-0.5'
            : 'flex max-h-[46vh] flex-col gap-[3px] overflow-y-auto pr-0.5'
        }
      >
        {floors.map((f) => {
          const active = isolatedFloor === f.level_no;
          const basement = f.level_no < 0;
          return (
            <button
              key={f.id}
              type="button"
              title={f.level_no === ownLevel
                ? `Your floor · ${tooltipFor(f.level_no)}`
                : tooltipFor(f.level_no)}
              aria-label={`Level ${levelLabel(f.level_no, top)}`}
              aria-pressed={active}
              onClick={() => isolateFloor(active ? null : f.level_no)}
              className={[
                'shrink-0 rounded text-[11px] font-medium transition-colors',
                // 44px on the scroll axis for a touch target; the vertical
                // ladder keeps its compact 24px rungs on a mouse-driven rail.
                horizontal ? 'h-9 w-11' : 'h-6 w-9',
                active
                  ? 'is-active'
                  : basement
                    ? 'bg-[rgb(var(--tint)/0.06)] text-[rgb(var(--muted))] tint-hover'
                    : 'bg-[rgb(var(--tint)/0.06)] text-[rgb(var(--ink))] tint-hover',
              ].join(' ')}
            >
              {levelLabel(f.level_no, top)}
              {f.level_no === ownLevel && !active ? (
                <span aria-hidden className="ml-0.5 text-[8px] align-top">●</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {isolatedFloor !== null ? (
        <button
          type="button"
          aria-label="Show all levels"
          onClick={() => isolateFloor(null)}
          className={[
            'shrink-0 rounded bg-[rgb(var(--tint)/0.06)] text-[9px] text-[rgb(var(--muted))] tint-hover',
            horizontal ? 'h-9 w-11' : 'mt-1 w-9 py-0.5',
          ].join(' ')}
        >
          all
        </button>
      ) : null}
    </div>
  );
}
