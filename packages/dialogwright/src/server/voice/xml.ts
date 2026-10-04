/** The XML helpers every carrier's documents share (TwiML and TeXML are the same shape). */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A whole document: the XML declaration and one `<Response>` around `body`. */
export function xmlResponse(body: string): string {
  return `${XML_HEAD}<Response>${body}</Response>`;
}

/** A form-encoded body's fields; a repeated key keeps its last value, as the carriers send none. */
export function formFields(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}
