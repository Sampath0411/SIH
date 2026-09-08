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
import {
  deedBoundsRows, deedParkingRows, deedRows, ladmRows, type DeedDoc,
} from './certificate.ts';

/** A4 portrait, in millimetres. */
const PAGE = { w: 210, h: 297 };
const MARGIN = 18;
// Room for the footer line, which sits at PAGE.h - 12. Content must stop above
// it rather than run underneath it.
const BOTTOM_MARGIN = 20;
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
  doc.text('Scan for the ISO 19152 record', qrX, y + QR_MM + 3, { maxWidth: QR_MM });

  // ---- the record -------------------------------------------------------
  const tableW = contentW - QR_MM - 8;
  y = table(doc, 'Record', deedRows(deed), MARGIN, y, tableW);

  // Past the QR block before the full-width section below.
  y = Math.max(y, MARGIN + QR_MM + 24);

  // ---- appurtenant parking ----------------------------------------------
  // Between the record and the extent: it is part of what the title carries,
  // and it names a second identifier, so it sits under the first and is
  // headed as what it is.
  const parking = deedParkingRows(deed);
  if (parking.length) {
    y = breakIfNeeded(doc, y + 2, 24);
    y = table(doc, 'Appurtenant parking', parking, MARGIN, y, contentW);
  }

  // ---- spatial extent ---------------------------------------------------
  y = breakIfNeeded(doc, y + 2, 30);
  y = table(doc, 'Spatial extent', deedBoundsRows(deed), MARGIN, y, contentW);

  // ---- ISO 19152 --------------------------------------------------------
  // Omitted entirely when the volume is not in the registry, rather than
  // printed as a heading over nothing: a certificate that shows an empty
  // "Legal and spatial rights" block asserts that a holding has none.
  const ladm = ladmRows(deed);
  if (ladm.length) {
    y = breakIfNeeded(doc, y + 2, 24);
    y = table(doc, 'Legal and spatial rights (ISO 19152 LADM)', ladm,
      MARGIN, y, contentW);
  }

  // ---- provenance -------------------------------------------------------
  y = breakIfNeeded(doc, y, 26);
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
  // ON EVERY PAGE, not only the last. The footer carries "not an instrument of
  // title", and a second page without it would be a page of a
  // title-document-shaped PDF that does not say what it is -- which is the
  // failure lib/deed/certificate.ts is written against. Cheap insurance now
  // that the document can run to two pages.
  const stamp = `Generated ${new Date(deed.issued_at).toISOString()
    .replace('T', ' ').slice(0, 19)} UTC · not an instrument of title`;
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(pages > 1 ? `${stamp} · page ${i} of ${pages}` : stamp,
      MARGIN, PAGE.h - 12);
  }

  return doc.output('blob');
}

/**
 * Start a new page if `need` millimetres will not fit below `y`.
 *
 * THE DOCUMENT USED TO BE ONE PAGE WITH NO GUARD AT ALL: renderDeed walked a
 * monotonically increasing y and never called addPage(), so anything past the
 * bottom margin was written off the sheet and simply did not exist in the
 * output -- silently, with a valid PDF either side of it. One flat's rights,
 * bundle and stakeholders are enough to reach that edge, so the guard arrives
 * with the section that needs it.
 */
function breakIfNeeded(
  doc: import('jspdf').jsPDF, y: number, need: number,
): number {
  if (y + need <= PAGE.h - BOTTOM_MARGIN) return y;
  doc.addPage();
  return MARGIN;
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
    // Values can be long (an address, a CRS statement, a bundled asset with
    // its share), so they wrap into the remaining width rather than running
    // off the page.
    const lines = doc.splitTextToSize(v, w - labelW) as string[];

    // BETWEEN ROWS, NOT ONLY BETWEEN TABLES. The ISO 19152 block is the first
    // section here whose length depends on the data rather than on the layout
    // -- a holding with a bundle, four rights and three stakeholders is much
    // longer than one without -- so a guard that only fires before a heading
    // would still write the tail of a long table off the sheet.
    const rowH = Math.max(1, lines.length) * 4.2;
    if (y + rowH > PAGE.h - BOTTOM_MARGIN) {
      doc.addPage();
      y = MARGIN;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...INK);
      // Continued, so a reader meeting page two knows what they are reading.
      doc.text(`${heading} (continued)`, x, y);
      y += 4;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
    }

    doc.setTextColor(...MUTED);
    doc.text(k, x, y);
    doc.setTextColor(...INK);
    doc.text(lines, x + labelW, y);
    y += rowH;
  }
  return y;
}

/** Filename for the download: the identifier, or the title if it has none. */
export function deedFilename(deed: DeedDoc): string {
  const stem = (deed.ulpin ?? deed.title).replace(/[^A-Za-z0-9._-]+/g, '-');
  return `3d-deed-${stem}.pdf`;
}
