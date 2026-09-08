'use client';

import { useEffect, useRef, useState } from 'react';
import { buildDeed } from '@/lib/deed/certificate';
import { datumNote } from '@/lib/datum';
import type { BuildingDetail, Project, UnitInfo } from '@/lib/types';

/**
 * "Generate 3D Property Deed" -- the export button on the unit card.
 *
 * Sits in the Panel header as an `action`, the same slot the building card's
 * Edit button uses, so the two read as the same kind of control.
 *
 * THE WORK HAPPENS ON CLICK, NOT ON RENDER. jspdf and qrcode are a few hundred
 * kilobytes between them and this button is not pressed in most sessions, so
 * lib/deed/pdf.ts is behind a dynamic import that only resolves here. Nothing
 * about the PDF stack is in the initial chunk.
 *
 * NOT OFFERED for a volume the caller may not read. A citizen is shown a
 * neighbour's flat as geometry with its register stripped
 * (filterDetailForCaller); exporting a document for it would hand back in a
 * file exactly what the server refused to serve. `buildDeed` refuses a
 * restricted unit too -- two gates, because one of them is the whole point.
 */
export default function DeedButton({
  unit, detail, project, title, kicker, titled,
}: {
  unit: UnitInfo;
  detail: BuildingDetail;
  project: Project | null;
  /** The wording the panel already chose, so deed and card cannot disagree. */
  title: string;
  kicker: string;
  titled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // The server strips a neighbour's register and leaves the geometry; there is
  // nothing here to put on a deed, and offering the button would suggest
  // otherwise.
  if (unit.restricted || !project) return null;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const deed = buildDeed({
        unit,
        detail,
        slug: project.slug,
        origin: window.location.origin,
        title,
        kicker,
        titled,
        datumNote: datumNote(project.geoid_sep_m),
      });
      if (!deed) throw new Error('this volume has no record to print');

      const { renderDeed, deedFilename } = await import('@/lib/deed/pdf');
      const blob = await renderDeed(deed);

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = deedFilename(deed);
      // Hidden rather than merely off-screen, so appending it cannot shift
      // the panel's layout for the frame it exists.
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();

      /**
       * THE ANCHOR AND THE BLOB URL BOTH HAVE TO OUTLIVE THE CLICK.
       *
       * `a.click()` on a `download` link starts an ASYNCHRONOUS fetch of the
       * blob. Removing the element on the next statement -- which is what this
       * did -- pulls the download's own initiator out of the document while it
       * is still starting, and Chrome cancels it. The symptom is the worst
       * kind: the PDF is built correctly, the browser reports the right
       * filename and byte count, and then nothing arrives. Revoking the object
       * URL early does the same thing for the same reason.
       *
       * So both are torn down on a later task instead. The delay is long
       * enough for the browser to have taken its own reference to the blob and
       * short enough that nothing accumulates across repeated clicks.
       */
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not generate the deed');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setError(null), 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title="Download a PDF deed for this volume: 3D ULPIN, owner, bounding coordinates, volume and a QR code to the parcel API"
        className="shrink-0 rounded px-2 py-1 text-[11px] text-[rgb(var(--muted))] tint-hover hover:text-[rgb(var(--ink))] disabled:opacity-50"
      >
        {busy ? 'Generating…' : 'Generate 3D Property Deed'}
      </button>
      {error ? (
        <span className="max-w-[150px] text-right text-[10px] leading-tight text-[rgb(var(--danger))]">
          {error}
        </span>
      ) : null}
    </div>
  );
}
