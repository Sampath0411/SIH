'use client';

import { useEffect, useRef, useState } from 'react';
import { DISCLAIMER, parse } from '@/lib/ulpin';

/**
 * The ULPIN card.
 *
 * Renders the identifier broken into its segments so the hierarchy is legible,
 * and carries the disclaimer inline -- not in a tooltip -- because presenting an
 * invented identifier in the visual language of a government one, without
 * saying so, is precisely the failure mode worth avoiding here.
 */

const SEGMENT_LABELS = ['State', 'District', 'Scheme', 'Parcel', 'Bldg', 'Floor', 'Unit'];

export default function UlpinCard({ ulpin }: { ulpin: string }) {
  const [copied, setCopied] = useState(false);
  // 'any' codes: this card renders an identifier the server has already
  // minted for the project on screen. Asserting the demo project's district
  // here would blank the card for every other AOI.
  const parts = parse(ulpin, 'any');
  const segments = ulpin.split('-');

  // The 1.4 s "Copied" acknowledgement must not fire setCopied on an
  // unmounted card if the user dismissed it within the window. The
  // unmount cleanup below clears the timer; the reschedule path also
  // clears the prior one, so a second click resets the window instead
  // of stacking.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ulpin);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked; the identifier is selectable on screen anyway */
    }
  };

  return (
    <div className="glass-soft rounded-md p-2.5">
      <div className="flex items-center justify-between">
        <span className="panel-title">ULPIN</span>
        <button
          type="button"
          onClick={copy}
          className="rounded px-1.5 py-0.5 text-[10px] text-[rgb(var(--muted))] tint-hover hover:text-[rgb(var(--ink))]"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-end gap-x-1 gap-y-1 font-mono text-[13px] leading-none text-[rgb(var(--ink))]">
        {segments.map((seg, i) => (
          <span key={`${seg}-${i}`} className="flex flex-col items-center gap-0.5">
            <span className="text-[8px] uppercase tracking-wide text-[rgb(var(--muted))]">
              {SEGMENT_LABELS[i] ?? ''}
            </span>
            <span
              className={
                i >= 3
                  ? 'rounded bg-[rgb(var(--tint)/0.15)] px-1 py-0.5 text-[rgb(var(--ink))]'
                  : 'px-0.5 py-0.5'
              }
            >
              {seg}
            </span>
          </span>
        ))}
      </div>

      {parts ? (
        <div className="mt-1.5 text-[10px] text-[rgb(var(--muted))]">
          parcel {parts.parcel}
          {parts.building !== undefined ? ` · building ${parts.building}` : ''}
          {parts.floor !== undefined ? ` · level ${parts.floor}` : ''}
          {parts.unit !== undefined ? ` · unit ${parts.unit}` : ''}
        </div>
      ) : null}

      <p className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-1.5 text-[9px] leading-snug text-muted">
        {DISCLAIMER}
      </p>
    </div>
  );
}
