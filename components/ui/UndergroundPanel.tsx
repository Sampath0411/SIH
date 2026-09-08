'use client';
import { useMemo } from 'react';

import { useDataStore, useViewStore } from '@/lib/store';
import {
  UNDERGROUND_LAYERS, categoryOfAssetType, formatBand, type UtilityCategory,
} from '@/lib/underground/categories';
import type { UtilityProps } from '@/lib/types';
import Check from './Check';

/**
 * The underground layer switches.
 *
 * WHY THIS PANEL EXISTS. Underground used to be one boolean: every buried
 * network at once, in one colour scheme, at one depth per class, or nothing.
 * With four networks in the scene that was already unreadable, and it offered
 * no way to answer the question the mode is actually for -- "what is under
 * this road" -- because there was no way to look at one thing.
 *
 * Every row here is generated from lib/underground/categories.ts. Adding a
 * category is an edit to that array and nothing else: no checkbox, no colour
 * and no depth is written down twice. The depths this panel prints used to be
 * a hardcoded map in Legend.tsx that had already drifted from the generator's.
 *
 * A category with no runs in this project is shown, disabled, with a count of
 * zero -- rather than hidden. "This project has no telecom data" is an answer;
 * a missing row is not.
 */
export default function UndergroundPanel() {
  const underground = useViewStore((s) => s.underground);
  const setUnderground = useViewStore((s) => s.setUnderground);
  const strata = useViewStore((s) => s.undergroundLayers);
  const toggle = useViewStore((s) => s.toggleUndergroundLayer);
  const setStrata = useViewStore((s) => s.setUndergroundLayers);
  const utilities = useDataStore((s) => s.utilities);
  const buildings = useDataStore((s) => s.buildings);

  // Counted from the data, per DISPLAY category, so the number beside a row is
  // the number of things that row will draw.
  // Memoised on the collections: every strata checkbox re-renders this panel,
  // and the three scans below are of the whole utility network and cadastre.
  const counts = useMemo(() => {
    const m = new Map<UtilityCategory, number>();
    for (const f of utilities?.features ?? []) {
      const cat = categoryOfAssetType((f.properties as UtilityProps).asset_type);
      if (cat) m.set(cat, (m.get(cat) ?? 0) + 1);
    }
    // Foundations are derived from the cadastre rather than served as utility
    // runs, so they are counted from the thing they are derived from.
    m.set(
      'foundations',
      (buildings?.features ?? []).filter((f) => f.properties.basements >= 1).length,
    );
    return m;
  }, [utilities, buildings]);

  const available = UNDERGROUND_LAYERS.filter((l) => (counts.get(l.key) ?? 0) > 0);
  const anyOn = available.some((l) => strata[l.key]);

  /**
   * Whether this project's utility records declare themselves demonstration
   * data. Read from the records rather than assumed, so the notice describes
   * what is loaded and would go away on its own if real survey data replaced
   * it.
   */
  const demo = useMemo(() => (utilities?.features ?? []).some(
    (f) => (f.properties as UtilityProps).provenance === 'demonstration',
  ), [utilities]);

  const setAll = (on: boolean) => {
    const next: Partial<Record<UtilityCategory, boolean>> = {};
    for (const l of available) next[l.key] = on;
    setStrata(next);
  };

  return (
    <div
      data-panel="underground"
      className="glass pointer-events-auto w-full rounded-lg p-3"
    >
      {/*
        Title and switch on SEPARATE rows.

        Side by side they fit the 288 px rail and not the 210 px column: the
        heading wrapped to two lines and the button sat on top of the second
        one. A panel that has to be read at the narrowest layout is laid out
        for that layout.
      */}
      <div className="panel-title">Underground infrastructure</div>
      <button
        type="button"
        aria-pressed={underground}
        onClick={() => setUnderground(!underground)}
        className={[
          'mt-1.5 w-full rounded px-2 py-1 text-[11px] transition-colors',
          underground ? 'is-active' : 'text-[rgb(var(--ink))] tint-hover',
        ].join(' ')}
        title={
          underground
            ? 'Return to the surface view.'
            : 'Fade the ground and the buildings, and drop the camera among '
              + 'the buried services.'
        }
      >
        {/*
          Not the exact string "Underground". scripts/verify_ui.mjs finds the
          mode button with an exact-match on button text, and would otherwise
          pick whichever of the two panels came first in the DOM.
        */}
        {underground ? 'Underground mode · on' : 'Underground mode'}
      </button>

      <div className="mt-1.5">
        {UNDERGROUND_LAYERS.map((l) => {
          const n = counts.get(l.key) ?? 0;
          if (n === 0) {
            return (
              <div key={l.key} className="is-disabled">
                <Check
                  label={l.label}
                  swatch={l.colour}
                  checked={false}
                  onChange={() => {}}
                  meta="—"
                  title={`No ${l.label.toLowerCase()} records in this project.`}
                />
              </div>
            );
          }
          return (
            <Check
              key={l.key}
              label={l.label}
              swatch={l.colour}
              checked={strata[l.key]}
              onChange={() => toggle(l.key)}
              meta={formatBand(l.band)}
              title={`${n} run${n === 1 ? '' : 's'} · drawn ${formatBand(l.band)} below local ground`}
            />
          );
        })}
      </div>

      {available.length > 1 ? (
        <div className="mt-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => setAll(true)}
            className="rounded px-2 py-[2px] text-[10px] text-[rgb(var(--ink))] tint-hover"
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setAll(false)}
            disabled={!anyOn}
            className="rounded px-2 py-[2px] text-[10px] text-[rgb(var(--ink))] tint-hover disabled:opacity-40"
          >
            None
          </button>
        </div>
      ) : null}

      <p className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2 text-[9px] leading-snug text-[rgb(var(--muted))]">
        {demo
          ? 'DEMONSTRATION DATA. No utility survey was consulted for this '
            + 'project. Alignments, depths and attributes are illustrative.'
          : 'Alignments derived by offsetting OSM road centrelines — '
            + 'representative service corridors, not as-built utility records.'}
        {' '}
        Each network is drawn in its own corridor and at its own depth so that
        several can be read at once; the stored coordinates are never changed,
        and selecting a run reports where it really is.
      </p>
    </div>
  );
}
