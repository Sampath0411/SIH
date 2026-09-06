'use client';

/**
 * The panel checkbox.
 *
 * Lifted out of LayerPanel when the underground panel needed the same control:
 * two visually identical checkboxes with two implementations is how one of
 * them ends up half a pixel out of line with the other, and how one of them
 * quietly loses a behaviour the other has.
 *
 * IT MUST STAY A <label>. scripts/smoke.mjs finds a layer toggle with
 *
 *     [...document.querySelectorAll('button, label, input')]
 *       .find((el) => /parcels/i.test(el.innerText || ...))
 *
 * so re-rooting this on a div -- which is what a role="checkbox" rewrite
 * naturally wants -- would make the toggles invisible to the acceptance
 * harness while looking identical on screen.
 *
 * Not a real <input type="checkbox">: the tick is drawn, and a native input
 * would either show through the box or need clipping that breaks at the sizes
 * this chrome uses. The handler is on the label rather than on the two inner
 * spans, so the whole row is the target and not just the box and the word.
 */
export default function Check({
  checked,
  onChange,
  label,
  /** Optional right-hand annotation: a depth, a count. */
  meta,
  /** A colour swatch before the label, for a layer that has one. */
  swatch,
  title,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  meta?: React.ReactNode;
  swatch?: string;
  title?: string;
}) {
  return (
    <label
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      tabIndex={0}
      title={title}
      onClick={onChange}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange();
        }
      }}
      className="flex cursor-pointer items-center gap-2 py-[3px] text-[12px] text-[rgb(var(--ink))] outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--accent))]"
    >
      <span
        className={[
          'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border transition-colors',
          checked
            ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent))]'
            : 'border-[rgb(var(--edge))] bg-transparent',
        ].join(' ')}
      >
        {checked ? (
          <svg viewBox="0 0 10 10" className="h-2 w-2" aria-hidden>
            <path
              d="M1 5l2.5 2.5L9 2"
              fill="none"
              stroke="black"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>

      {swatch ? (
        // Ringed: the panel is near-black and the darkest corridor tone (sewer
        // brown) would otherwise sit on it with almost no edge of its own.
        <span
          className="h-2 w-3 shrink-0 rounded-full ring-1 ring-[rgb(var(--edge-strong))]"
          style={{ background: swatch }}
        />
      ) : null}

      <span className="flex-1 truncate">{label}</span>

      {meta !== undefined ? (
        <span className="shrink-0 font-mono text-[10px] text-[rgb(var(--muted))]">
          {meta}
        </span>
      ) : null}
    </label>
  );
}
