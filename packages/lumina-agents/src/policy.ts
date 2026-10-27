// Local site policy and the deterministic checks the air-gapped verifier runs.
// These checks are the source of truth: Muse Glimmer calls them as tools and
// may add reasons to reject, but can never approve a bundle they block.

import type { ParameterKey, WorkOrderBundle } from './schema.ts';

export interface ParameterLimit {
  unit: string;
  min?: number;
  max?: number;
}

export interface SitePolicy {
  policy_id: string;
  site: string;
  allowed_assets: string[];
  parameters: Partial<Record<ParameterKey, ParameterLimit>>;
}

export interface Finding {
  code: 'asset_not_allowed' | 'site_mismatch' | 'parameter_not_allowed' | 'unit_mismatch' | 'out_of_range' | 'injection_suspected';
  severity: 'block' | 'warn';
  path: string;
  message: string;
}

export function checkAsset(policy: SitePolicy, assetId: string, path = '$.asset_id'): Finding[] {
  if (policy.allowed_assets.includes(assetId)) return [];
  return [{ code: 'asset_not_allowed', severity: 'block', path, message: `asset ${assetId} is not on the ${policy.policy_id} allow-list` }];
}

export function checkSetpoint(policy: SitePolicy, parameter: string, value: number, unit: string, path = '$'): Finding[] {
  const limit = policy.parameters[parameter as ParameterKey];
  if (!limit) {
    return [{ code: 'parameter_not_allowed', severity: 'block', path, message: `${parameter} may not be changed under ${policy.policy_id}` }];
  }
  if (unit !== limit.unit) {
    return [{ code: 'unit_mismatch', severity: 'block', path, message: `${parameter} unit ${unit}, policy expects ${limit.unit}` }];
  }
  if ((limit.min !== undefined && value < limit.min) || (limit.max !== undefined && value > limit.max)) {
    const range = `${limit.min ?? '-∞'} .. ${limit.max ?? '∞'} ${limit.unit}`;
    return [{ code: 'out_of_range', severity: 'block', path, message: `${parameter} = ${value} ${unit} outside ${range}` }];
  }
  return [];
}

// Phrases that try to steer an agent or an operator rather than describe
// maintenance work. Heuristic: the model judges context, this never misses
// the obvious ones.
const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all|earlier)\b.{0,30}\b(instructions?|rules?|polic(y|ies)|limits?)\b/i,
  /\b(you are now|act as|new instructions?|system prompt)\b/i,
  /\b(bypass|override|disable|defeat|jumper)\b.{0,30}\b(interlock|safety|alarm|trip|polic(y|ies)|verifier|limits?)\b/i,
  /\b(do not|don't|no need to)\b.{0,20}\b(verify|check|validate|log|report)\b/i,
  /\b(auto[- ]?approve|pre[- ]?approved|approve this)\b/i,
];

export function scanText(text: string, path = '$'): Finding[] {
  const hit = INJECTION_PATTERNS.find((re) => re.test(text));
  if (!hit) return [];
  return [{ code: 'injection_suspected', severity: 'block', path, message: `instruction-like text: "${text.slice(0, 120)}"` }];
}

/** Every deterministic check over a whole bundle. */
export function runPolicyChecks(bundle: WorkOrderBundle, policy: SitePolicy): Finding[] {
  const findings: Finding[] = [];
  if (bundle.site !== policy.site) {
    findings.push({ code: 'site_mismatch', severity: 'block', path: '$.site', message: `bundle is for ${bundle.site}, this receiver is ${policy.site}` });
  }
  findings.push(...checkAsset(policy, bundle.asset_id));
  findings.push(...scanText(bundle.summary, '$.summary'));
  bundle.steps.forEach((step, i) => {
    const p = `$.steps[${i}]`;
    findings.push(...scanText(step.instruction, `${p}.instruction`));
    const sp = step.setpoint;
    if (sp) findings.push(...checkSetpoint(policy, sp.parameter, sp.value, sp.unit, `${p}.setpoint`));
  });
  return findings;
}
