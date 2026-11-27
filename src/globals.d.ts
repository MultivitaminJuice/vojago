// Type declarations for values that exist at runtime but not in the JavaScript sources
// (ADR-001). Only for `tsc --checkJs`; not part of the build.

/** Injected by esbuild `define` in scripts/build-site.mjs (empty string without a key). */
declare const __CARTO_API_KEY__: string | undefined;

interface Window {
  /** MapLibre GL, loaded as a separate module next to app.js (see scripts/build-site.mjs). */
  maplibregl: any;
}

interface Navigator {
  /** iOS Safari: true when the PWA runs from the home screen. */
  standalone?: boolean;
}

declare module "*.css";
