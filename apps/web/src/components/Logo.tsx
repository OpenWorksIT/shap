/**
 * Shap brand mark: the shaka – a closed hand with thumb and pinky out, the easy
 * "howzit, all good" greeting you see on every South African building site.
 * Source files live in docs/brand.
 */
export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <g transform="translate(50 50) scale(0.9) rotate(-20) translate(-50 -56)" fill="var(--brand-orange)">
        <path d="M41 76 L41.5 91" stroke="var(--brand-orange)" strokeWidth="21" strokeLinecap="round" />
        <path d="M37 44 L23 19" stroke="var(--brand-orange)" strokeWidth="16" strokeLinecap="round" />
        <path d="M60 69 L86 69" stroke="var(--brand-orange)" strokeWidth="13" strokeLinecap="round" />
        <path d="M29 47 C29 37 34 33 43 33 L59 33 C66 33 68 37 67 41 C72 42 73 46 72.5 49 C72 52 70 54 67 54.5 C71 55.5 72.5 58 72 61 C71.5 64 69 66 66 66 L66 69 C66 76 61 80 53 80 L41 80 C33 80 29 75 29 67 Z" />
        <path d="M45 43.5 L64 43.5 M47 54.5 L64 54.5 M49 65 L60 65" stroke="var(--brand-crease)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}

/** Mark + wordmark. `tagline` adds the small descriptor under the name. */
export function Logo({ size = 36, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <span className="logo" style={{ ['--logo-size' as string]: `${size}px` }}>
      <LogoMark size={size} />
      <span className="logo-text">
        <span className="logo-word">Shap</span>
        {tagline && <span className="logo-tag">Jobs · labour · books</span>}
      </span>
    </span>
  );
}
