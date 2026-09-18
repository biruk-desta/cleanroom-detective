import {
  type Check,
  type Dataset,
  type Rules,
  type Finding,
  CHECKS,
  profile,
} from './audit.ts';
export type PlannerInput = {
  records: number;
  columns: {
    id: number;
    missing: number;
    distinct: number;
    numeric: number;
    min: number | null;
    max: number | null;
  }[];
  available: Check[];
  completed: {
    check: Check;
    repairs: number;
    issues: number;
    reviews: number;
  }[];
};
export type Plan = { next: Check | 'finish'; reason: string };
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    next: { type: 'string', enum: [...CHECKS, 'finish'] },
    reason: { type: 'string' },
  },
  required: ['next', 'reason'],
  additionalProperties: false,
};
export const PLANNER_INSTRUCTIONS =
  'You are a CSV audit investigator. You receive only measured numerical statistics with opaque column IDs, available checks, and completed check counts. Select the next useful available check based on this evidence, or finish only after all available checks have been completed. Never repeat a completed check. Explain the choice in one short sentence. Do not claim results before a check runs. You have no dataset editing role. Do not use tools, browse, read files or execute commands. Return the requested JSON object.';
export function plannerInput(
  data: Dataset,
  rules: Rules,
  completed: { check: Check; findings: Finding[] }[],
): PlannerInput {
  const p = profile(data, rules);
  return {
    records: p.records,
    columns: p.columns.map((c, id) => ({
      id,
      missing: c.missing,
      distinct: c.distinct,
      numeric: c.numeric,
      min: c.min,
      max: c.max,
    })),
    available: p.availableChecks,
    completed: completed.map((c) => ({
      check: c.check,
      repairs: c.findings.filter((f) => f.kind === 'repair').length,
      issues: c.findings.filter((f) => f.kind === 'issue').length,
      reviews: c.findings.filter((f) => f.kind === 'review').length,
    })),
  };
}
export function validatePlan(value: unknown, input: PlannerInput): Plan {
  if (!value || typeof value !== 'object')
    throw new Error('Model returned no plan.');
  const p = value as Plan;
  if (
    ![...CHECKS, 'finish'].includes(p.next) ||
    typeof p.reason !== 'string' ||
    p.reason.length > 1000
  )
    throw new Error('Model returned an invalid plan.');
  const remaining = input.available.filter(
    (c) => !input.completed.some((x) => x.check === c),
  );
  if (p.next === 'finish') {
    if (remaining.length)
      throw new Error(
        'Model tried to finish before all configured checks ran.',
      );
  } else if (!remaining.includes(p.next))
    throw new Error('Model chose an unavailable or already completed check.');
  return p;
}
