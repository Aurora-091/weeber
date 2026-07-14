/** Shared film-grain texture overlay — extracted from landing.tsx's
 * original inline `GrainOverlay` (byte-identical, only the file moved) so
 * every marketing page gets the same subtle texture. */
export function GrainOverlay() {
  return (
    <div className="grain-overlay" aria-hidden="true">
      <svg width="100%" height="100%">
        <filter id="grain-filter">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={3} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain-filter)" />
      </svg>
    </div>
  );
}
