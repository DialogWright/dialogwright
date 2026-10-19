/**
 * The full-size conversation's stylesheet (mountConversation), inside its shadow root. A page themes it
 * with custom properties on the host element (`dialogwright-conversation`): --dw-accent, --dw-accent-fg,
 * --dw-bg, --dw-fg, --dw-muted, --dw-user-bg, --dw-user-fg, --dw-border, --dw-radius, --dw-font,
 * --dw-size (the line's words), --dw-shadow and --dw-height (the conversation's most height). Those it
 * leaves unset follow the visitor's colour scheme; motion only for those who have not asked for less.
 */
export const CONVERSATION_STYLES = `
:host {
  --_accent: var(--dw-accent, #2f5bd3);
  --_on-accent: var(--dw-accent-fg, #ffffff);
  --_bg: var(--dw-bg, #ffffff);
  --_fg: var(--dw-fg, #1d1d1f);
  --_muted: var(--dw-muted, #5f6368);
  --_user-bg: var(--dw-user-bg, #e8eefc);
  --_user-fg: var(--dw-user-fg, var(--_fg));
  --_border: var(--dw-border, rgba(0, 0, 0, 0.1));
  --_radius: var(--dw-radius, 20px);
  --_size: var(--dw-size, 1.15rem);
  all: initial;
  display: block;
  font-family: var(--dw-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  font-size: 16px;
  line-height: 1.5;
  color: var(--_fg);
}
@media (prefers-color-scheme: dark) {
  :host {
    --_bg: var(--dw-bg, #1b1d22);
    --_fg: var(--dw-fg, #eef0f3);
    --_muted: var(--dw-muted, #a2a8b3);
    --_user-bg: var(--dw-user-bg, #2c3b5c);
    --_border: var(--dw-border, rgba(255, 255, 255, 0.12));
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
button, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 3px solid var(--_accent); outline-offset: 2px; }
.conversation { background: var(--_bg); border: 1px solid var(--_border); border-radius: var(--_radius); box-shadow: var(--dw-shadow, 0 18px 48px rgba(0, 0, 0, 0.18)); overflow: hidden; }
.head { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--_border); font-size: 0.85rem; color: var(--_muted); }
.status { display: inline-flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--_muted); }
.dot.on { background: #2fbf71; }
.dot.wait { background: #e8b53c; }
.restart { background: none; border: 0; padding: 4px 0; color: var(--_muted); font-size: 0.85rem; }
.restart:hover { color: var(--_fg); text-decoration: underline; }
.log { max-height: var(--dw-height, min(55vh, 540px)); min-height: 160px; overflow-y: auto; padding: 20px clamp(16px, 4vw, 32px) 6px; }
.turn { margin: 0 0 16px; }
.turn.agent { position: relative; padding-left: 20px; font-size: var(--_size); max-width: 94%; }
.turn.agent::before { content: ""; position: absolute; left: 0; top: 0.55em; width: 9px; height: 9px; background: var(--_accent);
  clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%); }
.turn.agent.old { color: var(--_muted); font-size: 1rem; }
.turn.agent p { margin: 0; }
.turn.agent p + p, .turn.agent ul, .turn.agent ol { margin: 0.5em 0 0; }
.turn.agent ul, .turn.agent ol { padding-left: 1.1em; }
.turn.agent li { margin-top: 0.35em; }
.turn.agent li::marker { color: var(--_accent); }
.turn.you { margin-left: auto; width: fit-content; max-width: 80%; padding: 9px 15px; border-radius: 16px 16px 4px 16px; background: var(--_user-bg); color: var(--_user-fg); }
.turn.note { color: var(--_muted); font-size: 0.9rem; font-style: italic; }
.thinking { display: none; gap: 6px; padding: 0 0 16px clamp(16px, 4vw, 32px); }
.thinking.on { display: flex; }
.thinking span { width: 7px; height: 7px; border-radius: 50%; background: var(--_muted); opacity: 0.4; animation: blink 1.2s infinite; }
.thinking span:nth-child(2) { animation-delay: 0.2s; }
.thinking span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
.replies { display: flex; flex-wrap: wrap; gap: 8px; margin: -4px 0 16px 20px; }
.starters { display: flex; flex-wrap: wrap; gap: 8px; padding: 2px clamp(16px, 4vw, 32px) 12px; }
.chip { padding: 8px 14px; border-radius: 999px; border: 1px solid var(--_accent); background: transparent; color: var(--_fg); font-size: 0.92rem; }
.chip:hover { background: var(--_accent); color: var(--_on-accent); }
.again { display: block; margin: 0 auto 16px; padding: 9px 16px; border-radius: 999px; border: 1px solid var(--_accent); background: none; }
.composer { display: flex; gap: 10px; padding: 12px clamp(12px, 3vw, 20px) 16px; border-top: 1px solid var(--_border); }
.composer textarea { flex: 1; resize: none; min-height: 48px; max-height: 140px; padding: 12px 16px; border-radius: 24px; border: 1px solid var(--_border); background: transparent; line-height: 1.4; }
.composer textarea:focus { outline: none; border-color: var(--_accent); }
.send { flex: none; width: 48px; height: 48px; border-radius: 50%; border: 0; display: grid; place-items: center; background: var(--_accent); color: var(--_on-accent); }
.send:disabled { opacity: 0.4; cursor: default; }
.send svg { width: 20px; height: 20px; }
@media (max-width: 560px) {
  .starters { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
  .starters::-webkit-scrollbar { display: none; }
  .chip { flex: none; }
}
@media (prefers-reduced-motion: reduce) {
  .thinking span { animation: none; opacity: 0.7; }
}
`;
