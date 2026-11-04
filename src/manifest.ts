// The manifest: two kinds and their JSON Schemas (docs/kinds.md#manifest).
// The schemas use only keywords that draft-07 and draft 2020-12 share.

import { PLUGIN } from './util.ts';

const str = { type: 'string', minLength: 1 };
const strings = { type: 'array', uniqueItems: true, items: str };
const forgeKinds = ['github', 'gitlab', 'fake'];

export const sourceSpecSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['forge', 'repositories', 'review'],
  properties: {
    forge: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'host', 'tokenEnv'],
      properties: {
        kind: { enum: forgeKinds },
        host: { type: 'string', pattern: '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' },
        apiUrl: { type: 'string', pattern: '^https://[^\\s]+$' },
        tokenEnv: { type: 'string', pattern: '^[A-Z_][A-Z0-9_]{0,127}$' },
        maxCallsPerMinute: { type: 'integer', minimum: 1, maximum: 600 },
      },
    },
    repositories: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['project'],
        properties: {
          project: { type: 'string', pattern: '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$' },
          url: { type: 'string', pattern: '^[^\\s-][^\\s]*$' },
          targetBranches: strings,
        },
      },
    },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requestedReviewer: str,
        drafts: { type: 'boolean' },
        bots: { type: 'boolean' },
        deletedAuthors: { type: 'boolean' },
        ownChanges: { type: 'boolean' },
        staleAfterDays: { type: 'integer', minimum: 1, maximum: 365 },
        excludeAuthors: strings,
        onlyAuthors: { ...strings, minItems: 1 },
        requireLabels: strings,
        excludeLabels: strings,
      },
    },
    review: {
      type: 'object',
      additionalProperties: false,
      required: ['taskConfig'],
      properties: {
        taskConfig: { type: 'string', pattern: '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' },
        template: { enum: ['generic', 'thurview'] },
        output: { enum: ['post', 'report'] },
        page: { enum: ['none', 'snapshot'] },
        approveAt: { type: 'integer', minimum: 1, maximum: 5 },
        guidance: { type: 'string', maxLength: 4000 },
      },
    },
    dispatch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        by: { enum: ['person', 'policy'] },
        maxActive: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    suspend: { type: 'boolean' },
    pollMs: { type: 'integer', minimum: 60000 },
    retention: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reviewMs: { type: 'integer', minimum: 0 },
      },
    },
  },
};

export const reviewSpecSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'forge', 'project', 'number', 'url'],
  properties: {
    source: str,
    forge: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'host'],
      properties: { kind: { enum: forgeKinds }, host: { type: 'string' } },
    },
    project: str,
    number: { type: 'integer', minimum: 1 },
    url: { type: 'string', pattern: '^https://[^\\s]+$' },
  },
};

function statusSchema(phases: string[], fields: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['phase'],
    properties: Object.fromEntries([['phase', { enum: phases }], ...fields.map((f) => [f, {}])]),
  };
}

export const sourceStatusSchema = statusSchema(
  ['Listing', 'Suspended', 'Throttled'],
  ['observedGeneration', 'account', 'repositories', 'changes', 'budget', 'throttle', 'conditions'],
);

export const reviewStatusSchema = statusSchema(
  ['Queued', 'Reviewing', 'Reviewed', 'Excluded', 'Settled', 'Retiring'],
  [
    'observedGeneration',
    'head',
    'task',
    'reviews',
    'cancelled',
    'change',
    'settledAt',
    'conditions',
  ],
);

export function manifest() {
  return {
    protocol: 1,
    name: PLUGIN,
    kinds: [
      {
        kind: 'ReviewSource',
        pollMs: 300000,
        finalizer: false,
        immutableSpec: false,
        spec: sourceSpecSchema,
        status: sourceStatusSchema,
      },
      {
        kind: 'Review',
        pollMs: 120000,
        finalizer: true,
        immutableSpec: true,
        spec: reviewSpecSchema,
        status: reviewStatusSchema,
      },
    ],
  };
}
