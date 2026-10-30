import { ToolError } from '../core/errors.mjs';

export const visionTools = [
  {
    name: 'vision.status',
    title: 'Vision adapter status',
    category: 'vision',
    permission: 'observe',
    description: 'Report whether a vision-language model is configured AND empirically verified to read image pixels. Reports the reason when vision is unavailable; it never claims vision that was not proven.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    examples: [{}],
    handler: async (_args, ctx) => {
      if (!ctx.vision) {
        return {
          available: false,
          configured: false,
          reason: 'No vision adapter is configured. The primary reasoning model is text-only; desktop perception uses UI Automation and OCR.',
          recommendation: 'Run scripts/verify_vision.mjs against a vision-capable local model before enabling vision.',
        };
      }
      return ctx.vision.status();
    },
  },
  {
    name: 'vision.describe',
    title: 'Describe a screenshot with a VLM',
    category: 'vision',
    permission: 'observe',
    description: 'Ask a verified vision-language model about a screenshot. Returns description text only, never coordinates. Fails with VISION_UNAVAILABLE when no verified vision adapter exists.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot_ref: { type: 'string', description: 'Path to a screenshot PNG' },
        question: { type: 'string', description: 'Question about the image', default: 'Describe the application state, visible dialogs and errors.' },
        max_tokens: { type: 'integer', minimum: 16, maximum: 800, default: 300 },
      },
      required: ['screenshot_ref'],
      additionalProperties: false,
    },
    examples: [{ screenshot_ref: '.agent/screenshots/shot_x.png', question: 'Is there an error dialog?' }],
    whenNotToUse: 'Do not use for precise element coordinates; VLM captions are not reliable GUI grounding.',
    handler: async (args, ctx) => {
      if (!ctx.vision) throw new ToolError('VISION_UNAVAILABLE', 'No verified vision adapter. Do not pretend visual understanding occurred.');
      return ctx.vision.describe(args);
    },
  },
  {
    name: 'vision.locate',
    title: 'Visual grounding (low confidence)',
    category: 'vision',
    permission: 'observe',
    description: 'Attempt visual grounding of a described element in a screenshot. Only available with a verified grounding-capable model; results are low confidence and must be confirmed visually or with UIA before clicking.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot_ref: { type: 'string', description: 'Path to a screenshot PNG' },
        description: { type: 'string', description: 'Element description, e.g. blue Save button top right' },
      },
      required: ['screenshot_ref', 'description'],
      additionalProperties: false,
    },
    examples: [{ screenshot_ref: '.agent/screenshots/shot_x.png', description: 'Save button' }],
    whenNotToUse: 'Do not use when UI Automation or the DOM can identify the element.',
    handler: async (args, ctx) => {
      if (!ctx.vision) throw new ToolError('VISION_UNAVAILABLE', 'Visual grounding requires a verified grounding model.');
      return ctx.vision.locate(args);
    },
  },
];
