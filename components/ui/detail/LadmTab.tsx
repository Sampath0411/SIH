'use client';

import { Row, Section, SkeletonBar } from '@/components/ui/DetailPanel';
import { useEnsureLadm } from '@/lib/store';
import {
  LADM_CLASS_LABEL, formatShare, memberRoleLabel, partyRoleLabel,
  rrrTypeLabel, suTypeLabel,
  type LADMBAUnitMember, type LADMParty, type LADMRRR, type LADMSpatialUnit,
} from '@/lib/ladm';

/**
 * The "LADM Legal & Spatial Rights" tab.
 *
 * Four cards, one per ISO 19152 core class, each labelled with the class name
 * it renders -- LA_SpatialUnit, LA_BAUnit, LA_RRR, LA_Party. The label is not
 * decoration: it is what lets a reader check this panel against the standard
 * rather than against our wording for it.
 *
 * WHAT THIS TAB MAY SAY. The same rule the rest of the panel keeps and
 * lib/deed/certificate.ts states outright: every figure here comes from the
 * cadastre or is derived from it by arithmetic named on the row, and where the
 * register has no answer the row is ABSENT rather than printed as a plausible
 * blank. An unregistered volume says so in a sentence. A volume the caller may
 * not read says THAT, in a different sentence -- "not yours to read" and
 * "nothing is registered here" are opposite facts and must never render alike.
 *
 * MONOCHROME, because scripts/shoot.mjs audits `.glass` for unsanctioned
 * chroma and this renders inside one.
 *
 * Row, Section and SkeletonBar come from DetailPanel rather than being
 * restated here, so this tab is typographically indistinguishable from the one
 * beside it.
 */
export default function LadmTab({ suId }: { suId: string | null }) {
  const { doc, pending } = useEnsureLadm(suId);

  if (!suId) {
    return (
      <p className="py-2 text-[11px] leading-snug text-[rgb(var(--muted))]">
        This selection has no spatial-unit identifier, so there is no LADM
        record to show.
      </p>
    );
  }

  if (pending && !doc) {
    return (
      <>
        <Section title={`Spatial unit · ${LADM_CLASS_LABEL.spatial_unit}`}>
          <Row label="3D ULPIN" value={<SkeletonBar w="w-40" />} />
          <Row label="Class" value={<SkeletonBar w="w-24" />} />
          <Row label="Volumetric extent" value={<SkeletonBar w="w-16" />} />
        </Section>
        <Section title={`Legal unit · ${LADM_CLASS_LABEL.ba_unit}`}>
          <Row label="Bundle" value={<SkeletonBar w="w-28" />} />
        </Section>
      </>
    );
  }

  if (!doc) {
    return (
      <p className="py-2 text-[11px] leading-snug text-[rgb(var(--muted))]">
        This volume is not in the ISO 19152 registry. Either the project was
        seeded before the LADM tables existed, or{' '}
        <span className="font-mono">ladm_backfill()</span> has not been run for
        it. The cadastre still holds its geometry; nothing has been lost.
      </p>
    );
  }

  return (
    <>
      <SpatialUnitCard su={doc.su} />
      {doc.restricted ? (
        <RedactionNotice note={doc.redaction_note} />
      ) : (
        <>
          <BaUnitCard doc={doc} />
          <RrrCard rrrs={doc.rrrs} />
          <PartyCard parties={doc.parties} />
        </>
      )}
      <EasementCard easements={doc.easements} />
      <p className="mt-2 text-[9px] leading-snug text-[rgb(var(--muted))]">
        {doc.disclaimer}
      </p>
    </>
  );
}

/**
 * LA_SpatialUnit: the identifier, what kind of volume it is, its m³ and its
 * vertical extent in BOTH datums.
 *
 * BOTH DATUMS, ALWAYS, and each labelled. Every z this cadastre stores is
 * orthometric (EGM96); the ellipsoidal pair is what EPSG:4979 and Cesium mean
 * by a height, and at Visakhapatnam the two are 72 m apart. Printing one
 * number under an ambiguous label is how a reader ends up quoting a height
 * that is wrong by the building's own height. Where no geoid separation is
 * recorded the ellipsoidal row is simply absent -- "not known" is a fact, and
 * converting by zero would assert that the geoid and the ellipsoid coincide.
 */
function SpatialUnitCard({ su }: { su: LADMSpatialUnit }) {
  const h = su.height;
  return (
    <Section title={`Spatial unit · ${LADM_CLASS_LABEL.spatial_unit}`}>
      {su.su_id ? (
        <Row label="3D ULPIN" value={<span className="font-mono">{su.su_id}</span>} />
      ) : null}
      <Row label="Class" value={suTypeLabel(su.su_type)} />
      <Row label="Dimension" value={su.dimension} />
      {su.volume_m3 !== undefined ? (
        <Row
          label="Volumetric extent"
          value={`${su.volume_m3.toFixed(1)} m³`}
          source="derived"
        />
      ) : null}
      {h ? (
        <>
          <Row
            label="Height (MSL)"
            value={`${h.msl.z_min.toFixed(2)} – ${h.msl.z_max.toFixed(2)} m`}
          />
          {h.ellipsoidal ? (
            <Row
              label="Height (ellipsoidal)"
              value={
                `${h.ellipsoidal.z_min.toFixed(2)} – `
                + `${h.ellipsoidal.z_max.toFixed(2)} m`
              }
              source="derived"
            />
          ) : null}
          <p className="mt-1 text-[10px] leading-snug text-[rgb(var(--muted))]">
            {h.datum_note}
            {h.ellipsoidal
              ? ' Ellipsoidal heights are EPSG:4979, converted through the '
                + `project's geoid separation (${h.geoid_separation_m?.toFixed(2)} m).`
              : ' No geoid separation is recorded for this project, so no '
                + 'ellipsoidal height is stated.'}
          </p>
        </>
      ) : su.dimension === '2D' ? (
        <p className="mt-1 text-[10px] leading-snug text-[rgb(var(--muted))]">
          A surface plot is recorded in plan only. Its vertical extent is not
          on record — which is a different statement from a height of zero.
        </p>
      ) : null}
      <Row label="Provenance" value={su.provenance} />
    </Section>
  );
}

/** LA_BAUnit: the bundle, and every asset in it with the share it is held on. */
function BaUnitCard({ doc }: { doc: { ba_unit?: { ba_ulpin: string; name: string; ba_type: string; ulpin_14?: string; members: LADMBAUnitMember[] } } }) {
  const ba = doc.ba_unit;
  if (!ba) {
    return (
      <Section title={`Legal unit · ${LADM_CLASS_LABEL.ba_unit}`}>
        <p className="py-1 text-[11px] leading-snug text-[rgb(var(--muted))]">
          No administrative record covers this volume on its own. That is the
          normal answer for common and structural space — a staircase, a lift
          shaft, a lobby — and for a parking bay, which is appurtenant to a
          flat rather than separately titled.
        </p>
      </Section>
    );
  }
  return (
    <Section title={`Legal unit · ${LADM_CLASS_LABEL.ba_unit}`}>
      <Row label="Bundle" value={ba.name} />
      <Row
        label="BA identifier"
        value={<span className="font-mono text-[11px]">{ba.ba_ulpin}</span>}
      />
      <Row
        label="Type"
        value={ba.ba_type === 'condominium_unit' ? 'Condominium unit' : 'Basic administrative unit'}
      />
      {ba.ulpin_14 ? (
        <Row
          label="ULPIN (14-digit)"
          value={<span className="font-mono text-[11px]">{ba.ulpin_14}</span>}
        />
      ) : null}
      <div className="mt-1.5 rounded border border-[rgb(var(--edge))] bg-[rgb(var(--surface-2))] p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--muted))]">
          Bundled assets
        </div>
        <div className="mt-1 space-y-1">
          {ba.members.map((m) => (
            <div key={m.su_id} className="text-[11px] leading-snug">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[rgb(var(--ink))]">
                  {m.label ?? m.su_id}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-[rgb(var(--ink))]">
                  {formatShare(m.share)}
                </span>
              </div>
              <div className="text-[10px] text-[rgb(var(--muted))]">
                {memberRoleLabel(m.member_role)} · {suTypeLabel(m.su_type)}
              </div>
              <div className="font-mono text-[9px] text-[rgb(var(--muted))]">
                {m.su_id}
              </div>
            </div>
          ))}
        </div>
        {/*
          The undivided share is OUR ARITHMETIC, not a register entry: no deed
          in this database states a fraction. It is one over the number of
          titled volumes in the building, so a building's shares sum to one.
          Saying so is the same discipline the provenance row keeps everywhere
          else in this panel.
        */}
        {ba.members.some((m) => m.member_role === 'undivided_share') ? (
          <p className="mt-1.5 text-[10px] leading-snug text-[rgb(var(--muted))]">
            The undivided share is derived — one part per separately titled
            volume in the building. No deed here states a fraction.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

/** LA_RRR: rights, restrictions and responsibilities against the bundle. */
function RrrCard({ rrrs }: { rrrs: LADMRRR[] }) {
  return (
    <Section title={`Rights & restrictions · ${LADM_CLASS_LABEL.rrr}`}>
      {rrrs.length === 0 ? (
        <p className="py-1 text-[11px] leading-snug text-[rgb(var(--muted))]">
          No rights, restrictions or responsibilities are recorded against this
          spatial unit.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rrrs.map((r, i) => (
            <div
              key={r.rrr_id ?? `${r.rrr_type}-${i}`}
              className="rounded border border-[rgb(var(--edge))] bg-[rgb(var(--surface-2))] p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-semibold text-[rgb(var(--ink))]">
                  {rrrTypeLabel(r.rrr_type)}
                </span>
                <span className="chip tint-soft text-[rgb(var(--muted))]">
                  {r.rrr_class}
                </span>
              </div>
              {r.party ? (
                <Row label="Held by" value={r.party.name} />
              ) : null}
              {r.reference ? (
                <Row
                  label="Reference"
                  value={<span className="font-mono text-[11px]">{r.reference}</span>}
                />
              ) : null}
              {r.amount_inr !== undefined ? (
                <Row label="Amount" value={inr(r.amount_inr)} />
              ) : null}
              {r.share ? <Row label="Share" value={formatShare(r.share)} /> : null}
              {r.from || r.to ? (
                <Row
                  label="In force"
                  value={`${r.from ?? '—'} → ${r.to ?? 'open'}`}
                />
              ) : null}
              {r.description ? (
                <p className="mt-1 text-[10px] leading-snug text-[rgb(var(--muted))]">
                  {r.description}
                </p>
              ) : null}
              {/*
                Which RECORD this right came from. The cadastre and the flat
                register have different owners and different update cadences,
                and a reader deciding whether to act on a charge needs to know
                which of the two is asserting it.
              */}
              {r.from_register ? (
                <p className="mt-1 text-[9px] leading-snug text-[rgb(var(--muted))]">
                  From the flat register, not the cadastre.
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** LA_Party: the holders and authorities named by those rights. */
function PartyCard({ parties }: { parties: LADMParty[] }) {
  return (
    <Section title={`Stakeholders · ${LADM_CLASS_LABEL.party}`}>
      {parties.length === 0 ? (
        <p className="py-1 text-[11px] leading-snug text-[rgb(var(--muted))]">
          No party is on record for this spatial unit.
        </p>
      ) : (
        parties.map((p) => (
          <Row
            key={`${p.name}-${p.role}`}
            label={partyRoleLabel(p.role)}
            value={
              <span>
                {p.name}
                {p.authority_code ? (
                  <span className="ml-1 font-mono text-[10px] text-[rgb(var(--muted))]">
                    {p.authority_code}
                  </span>
                ) : null}
              </span>
            }
          />
        ))
      )}
    </Section>
  );
}

/**
 * The subterranean runs crossing this unit.
 *
 * RESOLVED PER REQUEST, not stored: which plots a corridor burdens is a
 * spatial question, and a stored answer would be stale the moment a run moved.
 * The panel says so, because a reader should know whether they are looking at
 * a record or at a computation.
 */
function EasementCard({ easements }: { easements: LADMSpatialUnit[] }) {
  if (easements.length === 0) return null;
  return (
    <Section title="Subterranean easements">
      {easements.map((e) => (
        <Row
          key={e.su_id}
          label={e.label ?? e.su_id}
          value={
            e.height
              ? `${e.height.msl.z_min.toFixed(1)} – ${e.height.msl.z_max.toFixed(1)} m`
              : '—'
          }
          source="derived"
        />
      ))}
      <p className="mt-1 text-[10px] leading-snug text-[rgb(var(--muted))]">
        Corridors whose swept envelope meets this unit, computed on request
        from the recorded centreline and radius.
      </p>
    </Section>
  );
}

/**
 * Why the cards below are missing.
 *
 * A DIFFERENT SENTENCE from "nothing is registered here", because they are
 * opposite facts. The server has already withheld the rights and the parties;
 * this is the panel refusing to let that read as an empty register.
 */
function RedactionNotice({ note }: { note?: string }) {
  return (
    <div className="mt-2 rounded border border-[rgb(var(--edge-strong))] bg-[rgb(var(--surface-2))] px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--muted))]">
        Rights withheld
      </div>
      <p className="mt-1 text-[11px] leading-snug text-[rgb(var(--ink))]">
        {note
          ?? 'The rights and parties on this volume are not yours to read.'}
      </p>
    </div>
  );
}

/** Indian digit grouping, matching the formatter DetailPanel uses. */
function inr(v: number): string {
  return `₹${v.toLocaleString('en-IN')}`;
}
