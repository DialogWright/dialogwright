/**
 * The panel's stylesheet, inside its shadow root (a site's CSS cannot reach in, and this cannot
 * reach out). A site themes it with custom properties on the host element (`dialogwright-chat`):
 * --dw-accent, --dw-bg, --dw-fg, --dw-user-bg, --dw-agent-bg, --dw-radius, --dw-font, --dw-z. Those
 * it leaves unset follow the visitor's colour scheme; motion is only for those who have not asked
 * for less.
 */
export const STYLES = `
:host {
  --_accent: var(--dw-accent, #2f5bd3);
  --_bg: var(--dw-bg, #ffffff);
  --_fg: var(--dw-fg, #1d1d1f);
  --_user-bg: var(--dw-user-bg, #e8eefc);
  --_agent-bg: var(--dw-agent-bg, #f1f1f3);
  --_muted: #5f6368;
  --_radius: var(--dw-radius, 12px);
  all: initial;
  font-family: var(--dw-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  font-size: 15px;
  line-height: 1.4;
  color: var(--_fg);
  z-index: var(--dw-z, 2147483000);
}
@media (prefers-color-scheme: dark) {
  :host {
    --_accent: var(--dw-accent, #7aa2ff);
    --_bg: var(--dw-bg, #1f2023);
    --_fg: var(--dw-fg, #f1f1f3);
    --_user-bg: var(--dw-user-bg, #2c3b63);
    --_agent-bg: var(--dw-agent-bg, #2e2f33);
    --_muted: #a8abb2;
  }
}
:host([data-position="bottom-right"]), :host([data-position="bottom-left"]) {
  position: fixed;
  bottom: 16px;
  display: flex;
  flex-direction: column-reverse;
  gap: 12px;
}
:host([data-position="bottom-right"]) { right: 16px; align-items: flex-end; }
:host([data-position="bottom-left"]) { left: 16px; align-items: flex-start; }
:host([data-position="inline"]) { display: block; position: relative; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
button, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 3px solid var(--_accent); outline-offset: 2px; }
.launcher {
  border: 0; border-radius: 999px; padding: 12px 20px;
  background: var(--_accent); color: var(--_bg); font-weight: 600;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}
.panel {
  position: relative;
  display: flex; flex-direction: column;
  width: min(380px, calc(100vw - 32px));
  height: min(560px, calc(100vh - 96px));
  background: var(--_bg); color: var(--_fg);
  border-radius: var(--_radius);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
:host([data-position="inline"]) .panel { width: 100%; height: 100%; min-height: 320px; box-shadow: none; border: 1px solid var(--_agent-bg); }
h2 { margin: 0; padding: 14px 48px 14px 16px; font-size: 1.05em; border-bottom: 1px solid var(--_agent-bg); }
.close {
  position: absolute; top: 8px; right: 8px; width: 32px; height: 32px;
  border: 0; border-radius: 50%; background: transparent; font-size: 20px; line-height: 1;
}
.log { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.line { max-width: 85%; padding: 8px 12px; border-radius: var(--_radius); white-space: pre-wrap; overflow-wrap: anywhere; }
.row { display: flex; flex-direction: column; }
.row.user { align-items: flex-end; }
.row.user .line { background: var(--_user-bg); }
.row.agent .line { background: var(--_agent-bg); }
.row.notice .line { max-width: 100%; align-self: center; background: transparent; color: var(--_muted); font-size: 0.9em; text-align: center; padding: 2px 8px; }
.status { margin: 0; padding: 0 16px; min-height: 1.4em; color: var(--_muted); font-size: 0.9em; }
.composer { display: flex; gap: 8px; padding: 8px 12px 12px; align-items: flex-end; }
textarea {
  flex: 1; resize: none; min-height: 40px; max-height: 120px; padding: 9px 12px;
  border: 1px solid var(--_muted); border-radius: var(--_radius); background: var(--_bg);
}
.send, .signin {
  border: 0; border-radius: var(--_radius); padding: 9px 14px; background: var(--_accent); color: var(--_bg); font-weight: 600;
}
.signin { margin: 0 12px 12px; background: transparent; color: var(--_accent); border: 1px solid var(--_accent); }
button:disabled, textarea:disabled { opacity: 0.5; cursor: not-allowed; }
@media (prefers-reduced-motion: no-preference) {
  .panel { transition: opacity 160ms ease, transform 160ms ease; }
  .launcher { transition: transform 120ms ease; }
  .launcher:hover { transform: translateY(-1px); }
}
`;
