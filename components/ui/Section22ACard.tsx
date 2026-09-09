'use client';

import { useMemo } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import { codesOf, generate } from '@/lib/ulpin';
import { SECTION_22A_HEX } from '@/lib/cesium/materials';
import {
  acresOf, extentsDisagree, SECTION_22A_CATEGORY_LABEL,
  SECTION_22A_CATEGORY_NOTE, SECTION_22A_DISCLAIMER, SECTION_22A_MOCK_NOTE,
  type Section22AProps,
} from '@/lib/section22a/types';
import { Row, Section } from './DetailPanel';
import UlpinCard from './UlpinCard';

/**
 * The Section 22A card body.
 *
 * A separate component rather than a tenth branch inside DetailPanel, for the
 * reason LadmTab is one: DetailPanel is already 2,000 lines and this card has
 * an argument to make in a particular order. It borrows `Row` and `Section`
 * from there so the typography cannot drift from every other card.
 *
 * THE ORDER IS THE ARGUMENT, and it is the reverse of the survey parcel card's.
 * There the reader is looking at a polygon and the first question is what the
 * polygon IS. Here the reader has clicked something marked as prohibited, and
 * the first question is what is claimed and by whom -- so the status comes
 * first, the register's own identifiers next, and the caveats last, where they
 * qualify a claim the reader has already read rather than pre-empting one they
 * have not.
 *
 * WHAT THIS CARD MAY NOT SAY. It may not say a plot is legally restricted. It
 * says the register lists it, names the register, and says whether that
 * register is the government's. While it is not -- which is the case for
 * everything this repository ships -- SECTION_22A_MOCK_NOTE appears above the
 * standard disclaimer, because "verify the latest records" implies there is an
 * official record behind what you are reading, and for a demonstration dataset
 * there is not.
 */

/** m² with an acre figure beside it. Acres are the unit revenue records use. */
function extent(sqm: number): string {
  return `${Math.round(sqm).toLocaleString()} m² (${acresOf(sqm).toFixed(2)} ac)`;
}

function isoDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export default function Section22ACard({ props }: { props: Section22AProps }) {
  const register = useDataStore((s) => s.section22a?.register ?? null);
  const buildings = useDataStore((s) => s.buildings);
  const gis2d = useViewStore((s) => s.gis2d);
  const setActiveSurveyParcel = useViewStore((s) => s.setActiveSurveyParcel);

  /**
   * The revenue codes to mint the parcel identifier under.
   *
   * Read off an identifier the SERVER already minted, not from ulpin.ts's
   * defaults, which are AP/VSP -- a Hyderabad parcel would otherwise be
   * labelled AP-VSP-3D26-0042 on a card that also carries a disclaimer, which
   * is a specific and expensive kind of wrong. The survey parcel card takes the
   * same value the same way.
   */
  const codes = useMemo(
    () => codesOf(buildings?.features[0]?.properties.ulpin ?? ''),
    [buildings],
  );

  const authoritative = register?.authoritative ?? false;
  const disagrees = extentsDisagree(props.extent_sqm, props.mapped_extent_sqm);

  return (
    <>
      {/*
        The status, first and unmissable.

        --danger is the one hue sanctioned in this application's chrome
        (scripts/shoot.mjs fails any other inside a .glass subtree), and a
        prohibition on dealing with land is precisely what it is reserved for.
        The swatch beside it is inline-styled -- the documented exemption from
        that audit -- so the card carries the same crimson the map does and the
        reader can tie the two together without a legend.
      */}
      <div className="flex items-center gap-2 rounded border border-danger/60 px-2 py-1.5">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1 ring-[rgb(var(--edge-strong))]"
          style={{ background: SECTION_22A_HEX }}
        />
        <span className="text-[12px] font-semibold text-dangerInk">Restricted</span>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-wide text-[rgb(var(--muted))]">
          Section 22A
        </span>
      </div>

      <p className="row-label mt-1.5 leading-snug">
        {authoritative
          ? `Listed in ${register?.source_label ?? 'the government register'}.`
          : 'Listed in a demonstration register. Not a government list.'}
      </p>

      {/* The parcel-level identifier, on the card that carries the disclaimer.
          Built with generate() rather than concatenated, so it round-trips
          through parse() by construction -- the property check_gis2d.mjs
          already asserts for the survey card. Absent when the register brought
          its own boundary and named no parcel of ours: there is then no
          cadastre row for an identifier to describe. */}
      {props.parcel_label ? (
        <div className="mt-2">
          <UlpinCard
            ulpin={generate(
              Number(props.parcel_label), undefined, undefined, undefined,
              codes ?? undefined,
            )}
          />
        </div>
      ) : null}

      <div className="mt-2">
        <Row label="Survey number" value={props.survey_no} source="reference" />
        {props.ulpin_14 ? (
          <Row label="Bhu-Aadhaar" value={props.ulpin_14} source="reference" />
        ) : null}
        <Row
          label="Category"
          value={SECTION_22A_CATEGORY_LABEL[props.category]}
          source="reference"
        />
        {props.clause ? <Row label="Clause" value={props.clause} source="reference" /> : null}
        {props.extent_sqm !== null ? (
          <Row label="Extent" value={extent(props.extent_sqm)} source="reference" />
        ) : null}
        {/* Shown ONLY when the two disagree by more than 5%. A register extent
            that does not match the boundary on screen is information the reader
            needs before acting on either number; printing both every time would
            bury that signal in noise. */}
        {disagrees && props.mapped_extent_sqm !== null ? (
          <Row
            label="Mapped extent"
            value={extent(props.mapped_extent_sqm)}
            source="derived"
          />
        ) : null}
      </div>

      <p className="mt-1 text-[10px] leading-snug text-[rgb(var(--muted))]">
        {SECTION_22A_CATEGORY_NOTE[props.category]}
      </p>

      <Section title="Location">
        <Row label="Village" value={props.location.village || '—'} source="reference" />
        <Row label="Mandal" value={props.location.mandal || '—'} source="reference" />
        <Row label="District" value={props.location.district || '—'} source="reference" />
        {props.location.state ? (
          <Row label="State" value={props.location.state} source="reference" />
        ) : null}
      </Section>

      <Section title="Register entry">
        <Row label="Entry" value={<span className="font-mono">{props.id}</span>} />
        {props.authority ? (
          <Row label="Authority" value={props.authority} source="reference" />
        ) : null}
        {props.reference ? (
          <Row
            label="Reference"
            value={<span className="font-mono">{props.reference}</span>}
            source="reference"
          />
        ) : null}
        {props.listed_on ? (
          <Row label="Listed on" value={isoDate(props.listed_on)} source="reference" />
        ) : null}
        <Row label="Source" value={register?.source_label ?? 'unknown'} />
        {/* Which boundary the reader is looking at. The derived/sourced split
            this application makes on every other entity, made here too: the
            marking is the register's, the outline usually is not. */}
        <Row
          label="Boundary"
          value={props.geometry_source === 'register'
            ? 'As published by the register'
            : 'Matched to the cadastral parcel'}
          source={props.geometry_source === 'register' ? 'reference' : 'derived'}
        />
        {props.remarks ? (
          <p className="mt-1 text-[11px] leading-snug text-[rgb(var(--ink))]">
            {props.remarks}
          </p>
        ) : null}
      </Section>

      {/* The way back to the cadastral card for the same ground. Only in the 2D
          view, which is the only place the survey parcel card can be reached:
          two cards for one plot with no route between them is a dead end, and
          the reader who wants to know what is ON the restricted land should not
          have to guess that clicking the same polygon twice is how to find out. */}
      {gis2d && props.parcel_id !== null ? (
        <button
          type="button"
          onClick={() => setActiveSurveyParcel(props.parcel_id as number)}
          className="mt-2 w-full rounded border border-[rgb(var(--edge))] px-2 py-1 text-left text-[11px] text-[rgb(var(--ink))] tint-hover"
        >
          Open cadastral parcel {props.parcel_label ?? props.parcel_id} →
        </button>
      ) : null}

      <p className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
        {authoritative ? null : <>{SECTION_22A_MOCK_NOTE}{' '}</>}
        {SECTION_22A_DISCLAIMER}
      </p>
    </>
  );
}
