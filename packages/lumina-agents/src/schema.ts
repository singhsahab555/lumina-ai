// Work-order bundle: what Muse Spark distils a long maintenance document into,
// and what the air-gapped verifier checks before anything reaches an HMI.
//
// The JSON Schema is sent to Spark as a strict structured-output schema, and
// validateBundle() re-checks it locally: never trust that the model complied.
// This is a lossy *semantic summary* of the source, not compression of it.

export const BUNDLE_SCHEMA_ID = 'lumina.work-order/v1';

/** Canonical parameter vocabulary shared by packer and policy. */
export const PARAMETER_KEYS = [
  'vfd_ramp_time',
  'vibration_alarm',
  'vibration_trip',
  'discharge_pressure_high_limit',
  'bearing_temp_limit',
  'flow_setpoint',
] as const;
export type ParameterKey = (typeof PARAMETER_KEYS)[number];

export interface Setpoint {
  parameter: ParameterKey;
  value: number;
  unit: string;
}

export interface Step {
  order: number;
  instruction: string;
  setpoint: Setpoint | null;
}

export interface WorkOrderBundle {
  schema: typeof BUNDLE_SCHEMA_ID;
  kind: 'neural-summary';
  work_order_id: string;
  site: string;
  asset_id: string;
  summary: string;
  steps: Step[];
  source: { title: string; bytes: number; sha256: string };
}

const str = { type: 'string' } as const;

// Strict-mode compatible: every object closes additionalProperties and lists
// every property as required; optional values are expressed as nullable.
export const WORK_ORDER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'kind', 'work_order_id', 'site', 'asset_id', 'summary', 'steps', 'source'],
  properties: {
    schema: { type: 'string', enum: [BUNDLE_SCHEMA_ID] },
    kind: { type: 'string', enum: ['neural-summary'] },
    work_order_id: str,
    site: str,
    asset_id: { type: 'string', description: 'Tag of the single asset the steps act on, e.g. P-07B' },
    summary: { type: 'string', description: 'At most 3 sentences: what happened and why the work is needed' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['order', 'instruction', 'setpoint'],
        properties: {
          order: { type: 'integer' },
          instruction: str,
          setpoint: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['parameter', 'value', 'unit'],
            properties: {
              parameter: { type: 'string', enum: [...PARAMETER_KEYS] },
              value: { type: 'number' },
              unit: str,
            },
          },
        },
      },
    },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'bytes', 'sha256'],
      properties: { title: str, bytes: { type: 'integer' }, sha256: str },
    },
  },
} as const;

export type ValidationResult = { ok: true; bundle: WorkOrderBundle } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function closed(obj: Record<string, unknown>, keys: string[], path: string, errors: string[]): void {
  for (const k of keys) if (!(k in obj)) errors.push(`${path}.${k}: required`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${path}.${k}: unexpected property`);
}

function nonEmpty(v: unknown, path: string, errors: string[]): void {
  if (typeof v !== 'string' || v.trim() === '') errors.push(`${path}: expected non-empty string`);
}

export function validateBundle(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['$: expected object'] };
  closed(input, [...WORK_ORDER_JSON_SCHEMA.required], '$', errors);
  if (input.schema !== BUNDLE_SCHEMA_ID) errors.push(`$.schema: expected ${BUNDLE_SCHEMA_ID}`);
  if (input.kind !== 'neural-summary') errors.push('$.kind: expected neural-summary');
  for (const k of ['work_order_id', 'site', 'asset_id', 'summary'] as const) nonEmpty(input[k], `$.${k}`, errors);

  if (!Array.isArray(input.steps) || input.steps.length === 0) errors.push('$.steps: expected non-empty array');
  else {
    input.steps.forEach((step: unknown, i) => {
      const p = `$.steps[${i}]`;
      if (!isObj(step)) return errors.push(`${p}: expected object`);
      closed(step, ['order', 'instruction', 'setpoint'], p, errors);
      if (!Number.isInteger(step.order)) errors.push(`${p}.order: expected integer`);
      nonEmpty(step.instruction, `${p}.instruction`, errors);
      const sp = step.setpoint;
      if (sp === null) return;
      if (!isObj(sp)) return errors.push(`${p}.setpoint: expected object or null`);
      closed(sp, ['parameter', 'value', 'unit'], `${p}.setpoint`, errors);
      if (!PARAMETER_KEYS.includes(sp.parameter as ParameterKey)) errors.push(`${p}.setpoint.parameter: unknown parameter`);
      if (typeof sp.value !== 'number' || !Number.isFinite(sp.value)) errors.push(`${p}.setpoint.value: expected number`);
      if (typeof sp.unit !== 'string') errors.push(`${p}.setpoint.unit: expected string`);
    });
  }

  const src = input.source;
  if (!isObj(src)) errors.push('$.source: expected object');
  else {
    closed(src, ['title', 'bytes', 'sha256'], '$.source', errors);
    if (!Number.isInteger(src.bytes)) errors.push('$.source.bytes: expected integer');
    if (typeof src.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(src.sha256)) errors.push('$.source.sha256: expected hex SHA-256');
  }

  return errors.length ? { ok: false, errors } : { ok: true, bundle: input as unknown as WorkOrderBundle };
}
