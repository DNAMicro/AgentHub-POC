// Renders A2UI messages with the official Lit renderer inside jsdom (the same
// approach @a2ui/lit uses for its own tests).
import { JSDOM } from 'jsdom';

let dom;
export async function setupDom() {
  dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  for (const name of ['window', 'document', 'Document', 'HTMLElement', 'customElements', 'Element', 'Node', 'Event',
    'InputEvent', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSSStyleSheet', 'ShadowRoot']) {
    globalThis[name] = dom.window[name];
  }
  // Import after globals exist: Lit elements register custom elements at module load.
  await import('@a2ui/lit');
  const { basicCatalog } = await import('@a2ui/lit/v0_9');
  const { MessageProcessor } = await import('@a2ui/web_core/v0_9');
  return { basicCatalog, MessageProcessor };
}

export const settle = () => new Promise((r) => setTimeout(r, 30));

// Walk light DOM and open shadow roots.
export function queryAllDeep(root, selector) {
  const found = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) found.push(...queryAllDeep(el.shadowRoot, selector));
  return found;
}
