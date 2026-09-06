'use client';

import { useSiteIndex, useSitePending, useViewStore } from '@/lib/store';

/**
 * The project's named infrastructure, as a place to go.
 *
 * WHY IT IS A LIST OF PLACES AND NOT A LAYER TOGGLE. A site is not a category
 * of thing scattered across the AOI, it is one structure in one location — so
 * the useful control is "take me there", not "show me all of them". Opening
 * one is also what fetches and builds it, which is why exactly one can be
 * active: the alternative is a project that loads every structure it has in
 * order to display a checkbox.
 *
 * Renders NOTHING for a project with no sites. Every project but one has none,
 * and an empty panel that says "no infrastructure" is chrome that costs a slot
 * in the left column forever to report an absence.
 */
export default function SiteNavigator() {
  const sites = useSiteIndex();
  const activeSiteId = useViewStore((s) => s.activeSiteId);
  const selectSite = useViewStore((s) => s.selectSite);

  if (sites.length === 0) return null;

  return (
    <div
      data-panel="sites"
      className="glass pointer-events-auto w-full rounded-lg p-3"
    >
      <div className="panel-title">Infrastructure</div>

      <div className="mt-1.5 flex flex-col gap-1">
        {sites.map((s) => (
          <SiteButton
            key={s.id}
            id={s.id}
            name={s.name}
            summary={s.summary}
            components={s.components}
            active={activeSiteId === s.id}
            // Clicking the open site closes it, so the control is its own way
            // back out and the list never needs a separate "clear" button.
            onClick={() => selectSite(activeSiteId === s.id ? null : s.id)}
          />
        ))}
      </div>

      <p className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2 text-[9px] leading-snug text-[rgb(var(--muted))]">
        Locations and the facts on each card are sourced and cited. The modelled
        arrangement — dimensions, spacing, component identifiers — is derived
        for this demonstration and is not a survey.
      </p>
    </div>
  );
}

function SiteButton({
  id, name, summary, components, active, onClick,
}: {
  id: string;
  name: string;
  summary: string;
  components: number;
  active: boolean;
  onClick: () => void;
}) {
  const pending = useSitePending(id);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'w-full rounded px-2 py-1.5 text-left transition-colors',
        active ? 'is-active' : 'tint-hover',
      ].join(' ')}
    >
      {/*
        Colours INHERIT from the button rather than being pinned to --ink and
        --muted. `.is-active` flips the background to the accent and the text
        to --on-accent; a hardcoded --ink on the name made it the same tone as
        the active background, so opening a site made its own title disappear.
        The secondary text is dimmed with opacity, which reads correctly
        against either background.
      */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium">{name}</span>
        <span className="shrink-0 font-mono text-[9px] opacity-60">
          {pending ? 'loading…' : `${components} parts`}
        </span>
      </div>
      <div className="mt-[1px] text-[10px] leading-snug opacity-75">
        {summary}
      </div>
    </button>
  );
}
