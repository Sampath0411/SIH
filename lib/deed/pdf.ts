/**
 * Render a DeedDoc to a PDF, client-side.
 *
 * jspdf and qrcode are loaded with dynamic `import()` inside `renderDeed`
 * rather than at module scope. Together they are a few hundred kilobytes, and
 * this is a button most sessions never press -- next to a Cesium bundle that
 * is already the dominant cost, adding them to the initial chunk for a feature
 * used once would be the wrong trade. Nothing else in this module is loaded
 * until the click happens.
 *
 * LAYOUT IS DELIBERATELY PLAIN. A4, one column, no logo, no seal, no
 * ornament. This document must be readable as what it is -- a printout of the
 * cadastre's record of one volume -- and must NOT be dressable up into
 * something that could be mistaken for an instrument issued by a revenue
 * department. The disclaimer sits under the identifier, in the body, not in a
 * footnote.
 */
import { deedBoundsRows, deedRows, type DeedDoc } from './certificate.ts';

/** A4 portrait, in millimetres. */
const PAGE = { w: 210, h: 297 };
const MARGIN = 18;
// Greys, as explicit RGB triples: jspdf's typings take a single argument as a
// CSS colour STRING, so a bare number is a type error rather than a grey.
const INK: [number, number, number] = [17, 17, 17];
const MUTED: [number, number, number] = [110, 110, 110];

/** Wrap text and return the y after it. */
function paragraph(
  doc: import('jspdf').jsPDF,
  text: string, x: number, y: number, w: number, lineH = 4.2,
): number {
  const lines = doc.splitTextToSize(text, w) as string[];
  doc.text(lines, x, y);
  return y + lines.length * lineH;
}

/**
 * Build the PDF and hand it back as a Blob.
 *
 * Returns the Blob rather than saving it, so the caller decides -- the panel
 * triggers a download, and a test or a future server route could do something
 * else with the same bytes.
 */
export async function renderDeed(deed: DeedDoc): Promise<Blob> {
  const [{ jsPDF }, QR] = await Promise.all([
    import('jspdf'),
    import('qrcode'),
  ]);

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const contentW = PAGE.w - MARGIN * 2;
  let y = MARGIN;

  // ---- title ------------------------------------------------------------
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...INK);
  doc.text('3D Property Deed', MARGIN, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(`${deed.title} · ${deed.kicker}`, MARGIN, y);
  y += 7;

  // ---- the identifier ---------------------------------------------------
  if (deed.ulpin) {
    doc.setDrawColor(200, 200, 200);
    doc.setFillColor(246, 246, 246);
    doc.rect(MARGIN, y - 4.5, contentW, 11, 'FD');
    doc.setFont('courier', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text(deed.ulpin, MARGIN + 3, y + 2.5);
    y += 11;
  }

  // ---- the disclaimer, in the body -------------------------------------
  // Directly under the identifier and above every figure on the page. It is
  // the first thing a reader meets after the number itself, which is where a
  // statement about what that number IS has to be.
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  y = paragraph(doc, deed.disclaimer, MARGIN, y + 1, contentW, 3.6) + 3;

  // ---- QR ---------------------------------------------------------------
  // Encodes the parcel API endpoint, so the document resolves back to the
  // record it was printed from rather than to a marketing page.
  const qrPng = await QR.toDataURL(deed.api_url, {
    margin: 0, width: 320, errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
  const QR_MM = 30;
  const qrX = PAGE.w - MARGIN - QR_MM;
  doc.addImage(qrPng, 'PNG', qrX, y, QR_MM, QR_MM);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...MUTED);
  doc.text('Scan for the parcel API record', qrX, y + QR_MM + 3, { maxWidth: QR_MM });

  // ---- the record -------------------------------------------------------
  const tableW = contentW - QR_MM - 8;
  y = table(doc, 'Record', deedRows(deed), MARGIN, y, tableW);

  // Past the QR block before the full-width section below.
  y = Math.max(y, MARGIN + QR_MM + 24);

  // ---- spatial extent ---------------------------------------------------
  y = table(doc, 'Spatial extent', deedBoundsRows(deed), MARGIN, y + 2, contentW);

  // ---- provenance -------------------------------------------------------
  y += 3;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  doc.text('Provenance', MARGIN, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  y = paragraph(doc, deed.provenance, MARGIN, y, contentW, 3.8);
  y = paragraph(doc, deed.datum_note, MARGIN, y + 1, contentW, 3.8);

  // ---- footer -----------------------------------------------------------
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  doc.text(
    `Generated ${new Date(deed.issued_at).toISOString().replace('T', ' ').slice(0, 19)} UTC`
    + ' · not an instrument of title',
    MARGIN, PAGE.h - 12,
  );

  return doc.output('blob');
}

/** One label/value table. Returns the y after it. */
function table(
  doc: import('jspdf').jsPDF,
  heading: string, rows: [string, string][], x: number, y0: number, w: number,
): number {
  let y = y0;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  doc.text(heading, x, y);
  y += 4;

  const labelW = 34;
  for (const [k, v] of rows) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(k, x, y);

    doc.setTextColor(...INK);
    // Values can be long (an address, a CRS statement), so they wrap into the
    // remaining width rather than running off the page.
    const lines = doc.splitTextToSize(v, w - labelW) as string[];
    doc.text(lines, x + labelW, y);
    y += Math.max(1, lines.length) * 4.2;
  }
  return y;
}

/** Filename for the download: the identifier, or the title if it has none. */
export function deedFilename(deed: DeedDoc): string {
  const stem = (deed.ulpin ?? deed.title).replace(/[^A-Za-z0-9._-]+/g, '-');
  return `3d-deed-${stem}.pdf`;
}
