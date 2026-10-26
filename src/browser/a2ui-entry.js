// Bundle entry for the browser: the official A2UI v0.9 Lit renderer.
// Built to public/vendor/a2ui.js by `npm run build:ui` (esbuild).
import '@a2ui/lit'; // registers <a2ui-surface>
export { basicCatalog } from '@a2ui/lit/v0_9';
export { MessageProcessor } from '@a2ui/web_core/v0_9';
