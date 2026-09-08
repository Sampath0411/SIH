'use client';

import { useUiStore, type DetailTab } from '@/lib/ui-store';

/**
 * The detail panel's two-tab strip: what this thing IS, and who holds it.
 *
 * THE IDIOM IS Sheet.tsx's, deliberately. That component is the only tablist
 * this application had, and inventing a second look for the same control would
 * leave two things that behave alike and do not read alike. Same roles, same
 * aria wiring, same `is-active` treatment, same `[...].join(' ')` conditional
 * classes.
 *
 * LABELS ARE WORDS, NEVER NUMBERS. scripts/verify_ui.mjs locates floor-ladder
 * rungs by matching any button whose trimmed innerText is
 * /^(G|[0-9]{1,2}|B[0-9])$/, and takes the first match in the DOM; a numeric
 * tab would silently hijack that selector. 'Details' rather than 'Detail' for
 * a related reason: in the compact regime this strip is mounted INSIDE the
 * sheet's own 'Detail' tab, and two buttons reading the same word would make
 * the harness's first-match lookups ambiguous exactly where both are on
 * screen.
 *
 * MONOCHROME. scripts/shoot.mjs audits `.glass` subtrees for unsanctioned
 * chroma, and this sits inside one.
 */
const TABS: { id: DetailTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'ladm', label: 'Legal' },
];

export default function DetailTabs() {
  const tab = useUiStore((s) => s.detailTab);
  const setTab = useUiStore((s) => s.setDetailTab);

  return (
    <div
      role="tablist"
      aria-label="Property record"
      data-panel="detail-tabs"
      className="mt-2 flex gap-1 border-b border-[rgb(var(--edge))] pb-1.5"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`detail-panel-${t.id}`}
          onClick={() => setTab(t.id)}
          className={[
            'min-h-[28px] flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            tab === t.id ? 'is-active' : 'text-[rgb(var(--muted))] tint-hover',
          ].join(' ')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
