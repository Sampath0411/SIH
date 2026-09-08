'use client';

import { useEffect, useRef, useState } from 'react';
import { buildDeed } from '@/lib/deed/certificate';
import { datumNote } from '@/lib/datum';
import type { BuildingDetail, Project, UnitInfo } from '@/lib/types';
import type { LADMParcelDoc } from '@/lib/ladm';

/**
 * "Export ISO 19152 Certificate" -- the export button on the unit card.
 *
 * IT USED TO READ "Generate 3D Property Deed", and the rename is not cosmetic:
 * the document now carries the LADM classes -- the spatial unit, the bundle it
 * belongs to, the rights against it and the parties holding them -- and its QR
 * code resolves to the live ISO 19152 record rather than to the building
 * document. Calling it a deed while it is a standards-shaped certificate would
 * undersell what a reader is being handed, and this panel's whole discipline is
 * that a thing is named what it is.
 *
 * STILL ONE BUTTON. A second control beside it would mean two documents about
 * one volume that could disagree, which is the failure lib/deed/certificate.ts
 * exists to prevent -- so the existing deed grew the section instead.
 *
 * Sits in the panel BODY, directly under the ULPIN card it exports -- see the
 * comment on the markup below for why it is not in the header.
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
      /*
       * THE LADM RECORD IS FETCHED HERE, ON CLICK, and never at render.
       *
       * Same reasoning as the dynamic import below: most sessions never press
       * this button, and a request fired on every unit selection to fill a
       * section of a document nobody asked for is a request nobody asked for.
       *
       * A FAILURE IS NOT FATAL. If the endpoint is unreachable, or the volume
       * predates the registry, the certificate is issued without its ISO
       * 19152 section rather than not issued at all -- the deed's other
       * fields come from the cadastre and are still true. Printing the
       * section as blanks would be the alternative, and that would assert a
       * holding has no rights.
       */
      let ladm: LADMParcelDoc | null = null;
      if (unit.ulpin) {
        try {
          const res = await fetch(
            `/api/p/${project.slug}/ladm/spatial-unit/${encodeURIComponent(unit.ulpin)}`,
          );
          if (res.ok) {
            const feature = await res.json() as {
              geometry?: unknown;
              properties?: { spatial_unit?: unknown } & Record<string, unknown>;
            };
            const props = feature.properties;
            if (props?.spatial_unit) {
              const { spatial_unit: su, '@class': _cls, ...rest } = props;
              ladm = { ...rest, su } as unknown as LADMParcelDoc;
            }
          }
        } catch {
          /* no LADM section on this certificate; see above */
        }
      }

      const deed = buildDeed({
        unit,
        detail,
        slug: project.slug,
        origin: window.location.origin,
        title,
        kicker,
        titled,
        datumNote: datumNote(project.geoid_sep_m),
        ladm,
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

  /*
   * A FILLED, FULL-WIDTH CONTROL, not a text link in the panel header.
   *
   * This first shipped in the header's `action` slot, styled like the building
   * card's Edit button -- muted text, no border, no fill. That reads as a
   * control when it is one short word next to a title. At five words it reads
   * as a caption, and it was reported as missing by someone looking straight
   * at it.
   *
   * So it sits in the body under the identifier it exports, at full width and
   * with a background, which is the same affordance the theme and view-mode
   * buttons use. Monochrome, because scripts/shoot.mjs audits `.glass` for
   * unsanctioned chroma; the only colour here is --danger on a failure, which
   * is the one hue this palette spends on a state the reader must not miss.
   */
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title="Download a PDF deed for this volume: 3D ULPIN, owner, bounding coordinates, volume in m³, its ISO 19152 rights and parties, and a QR code to the live LADM record"
        className={[
          'w-full rounded py-1.5 text-[11px] transition-colors',
          busy
            ? 'is-disabled bg-[rgb(var(--tint)/0.06)]'
            : 'bg-[rgb(var(--tint)/0.1)] text-[rgb(var(--ink))] tint-hover',
        ].join(' ')}
      >
        {busy ? 'Generating certificate…' : '↓  Export ISO 19152 Certificate'}
      </button>
      {error ? (
        <p className="mt-1 text-[10px] leading-snug text-[rgb(var(--danger))]">
          {error}
        </p>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-[rgb(var(--muted))]">
          PDF with the 3D ULPIN, bounding coordinates, volumetric extent, the
          ISO 19152 rights and parties, and a QR code to the live LADM record.
        </p>
      )}
    </div>
  );
}
