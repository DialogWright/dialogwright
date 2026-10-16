import type { DocumentCode } from './data';

/**
 * The claims intake service: the insurer's own triage of a claim just filed, which says which
 * documents it needs, how soon an adjuster will be in touch, and whether the claim is fast-tracked.
 * Here it is a stand-in with the service's rules, run in process; the real service replaces it
 * (src/app.ts reaches it through the `triageClaim` tool, whose `check` holds its reply to the codes
 * and numbers the lines can say). What it says is never repeated: the line says only the documents
 * Harbor has approved wording for (`doc_<code>` in prompts.yaml), the number of days and whether it
 * is fast-tracked.
 */
export interface IntakeTriage {
  fastTrack: boolean;
  documents: DocumentCode[];
  adjusterContactDays: number;
}

/** What the service is sent: exactly the fields policy.yaml's `fields` rule lets it have. */
export type IntakeRequest = Readonly<Record<string, string>>;

/** A claims intake service: anything that answers a request with a triage, or with nothing. */
export interface IntakeService {
  triage(request: IntakeRequest): unknown;
}

const DOCS: Readonly<Record<string, readonly DocumentCode[]>> = {
  accident_injury: ['discharge_summary', 'imaging_report'],
  hospital_stay: ['admission_dates', 'itemized_bill'],
  diagnosis: ['physician_statement'],
};

/** The stand-in's rules: the documents by the kind of loss, and a simple injury fast-tracked. */
export const STAND_IN_INTAKE: IntakeService = {
  triage(request): IntakeTriage {
    const type = request.lossType ?? '';
    const fastTrack = type === 'accident_injury' && !/\b(surgery|admitted|ambulance)\b/i.test(request.lossDescription ?? '');
    return { fastTrack, documents: [...(DOCS[type] ?? ['loss_description'])], adjusterContactDays: fastTrack ? 2 : 5 };
  },
};
