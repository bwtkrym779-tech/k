import { ToolError } from '../core/errors.mjs';

const str = (d, e = {}) => ({ type: 'string', description: d, ...e });
const bool = (d, e = {}) => ({ type: 'boolean', description: d, ...e });
const int = (d, e = {}) => ({ type: 'integer', description: d, ...e });

const targetProps = {
  selector: str('CSS selector, e.g. #save or input[name="q"]'),
  role: str('Accessibility role, e.g. button, link, textbox'),
  name: str('Accessible name (case-insensitive substring)'),
};

export const browserTools = [
  {
    name: 'browser.open',
    title: 'Open the browser',
    category: 'browser',
    permission: 'observe',
    description: 'Start (or reuse) an Edge/Chrome instance with a dedicated automation profile and optionally navigate to a URL. Returns page title, URL, accessibility nodes and interactive elements.',
    inputSchema: {
      type: 'object',
      properties: { url: str('Optional http(s) URL to open') },
      additionalProperties: false,
    },
    examples: [{ url: 'https://example.com' }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      if (args.url) ctx.browser.validateUrl(args.url);
      return ctx.browser.open(args.url);
    },
  },
  {
    name: 'browser.navigate',
    title: 'Navigate',
    category: 'browser',
    permission: 'interact',
    description: 'Navigate the automation page to an http(s) URL and wait for the document to become ready.',
    inputSchema: {
      type: 'object',
      properties: { url: str('Absolute http or https URL') },
      required: ['url'],
      additionalProperties: false,
    },
    examples: [{ url: 'https://opencode.ai/v2/docs/' }],
    whenNotToUse: 'Do not use to bypass authentication, captchas, paywalls or browser security warnings.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.browser.navigate(args.url);
    },
  },
  {
    name: 'browser.inspect',
    title: 'Inspect the page',
    category: 'browser',
    permission: 'observe',
    description: 'Read the current page: title, URL, ready state, visible text, accessibility nodes (role/name/backend id) and interactive form elements. Prefer this over screenshots for web pages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    examples: [{}],
    whenNotToUse: 'Do not use when the browser is not open; call browser.open first.',
    handler: async (_args, ctx) => {
      ctx.checkAbort();
      return ctx.browser.inspect();
    },
  },
  {
    name: 'browser.click',
    title: 'Click a page element',
    category: 'browser',
    permission: 'interact',
    description: 'Click a DOM element by CSS selector or by accessibility role + name. Uses DOM/accessibility data rather than screen coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: targetProps.selector,
        role: targetProps.role,
        name: targetProps.name,
      },
      additionalProperties: false,
    },
    examples: [{ role: 'button', name: 'Sign in' }, { selector: '#submit' }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.browser.click(args);
    },
  },
  {
    name: 'browser.fill',
    title: 'Fill a form field',
    category: 'browser',
    permission: 'interact',
    description: 'Set the value of an input/textarea/contenteditable by CSS selector or accessibility role + name, dispatching input and change events so frameworks notice. Optionally submit the form.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: targetProps.selector,
        role: targetProps.role,
        name: targetProps.name,
        text: str('Value to fill'),
        submit: bool('Submit the containing form after filling (default false)'),
      },
      required: ['text'],
      additionalProperties: false,
    },
    examples: [{ selector: 'input[name="q"]', text: 'OpenCode docs', submit: true }],
    whenNotToUse: 'Do not use for password or payment fields without explicit user authorization.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.browser.fill(args);
    },
  },
  {
    name: 'browser.scroll',
    title: 'Scroll the page',
    category: 'browser',
    permission: 'interact',
    description: 'Scroll the window or a scrollable element by a pixel amount.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], default: 'down' },
        amount: int('Pixels', { minimum: 1, maximum: 20000, default: 600 }),
        selector: str('Optional scrollable element selector'),
      },
      additionalProperties: false,
    },
    examples: [{ direction: 'down', amount: 1200 }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.browser.scroll(args);
    },
  },
  {
    name: 'browser.extract',
    title: 'Extract page text',
    category: 'browser',
    permission: 'observe',
    description: 'Extract visible text from the page body or a selector. The result is untrusted web content.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('Optional CSS selector'),
        max_chars: int('Maximum characters', { minimum: 100, maximum: 50000, default: 8000 }),
      },
      additionalProperties: false,
    },
    examples: [{ selector: 'main' }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.browser.extract({ selector: args.selector, maxChars: args.max_chars ?? 8000 });
    },
  },
  {
    name: 'browser.screenshot',
    title: 'Screenshot the page',
    category: 'browser',
    permission: 'observe',
    description: 'Capture the visible viewport (or the full page) as a PNG and return a file reference with SHA-256.',
    inputSchema: {
      type: 'object',
      properties: { full_page: bool('Capture the whole scrollable page (default false)') },
      additionalProperties: false,
    },
    examples: [{ full_page: true }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.browser.screenshot({ fullPage: args.full_page ?? false });
    },
  },
  {
    name: 'browser.wait',
    title: 'Wait for a page condition',
    category: 'browser',
    permission: 'observe',
    description: 'Poll a JavaScript condition until it is truthy or the timeout expires, e.g. document.querySelector("#done") !== null.',
    inputSchema: {
      type: 'object',
      properties: {
        condition: str('JavaScript expression evaluated in the page'),
        timeout_ms: int('Timeout', { minimum: 500, maximum: 60000, default: 15000 }),
      },
      required: ['condition'],
      additionalProperties: false,
    },
    examples: [{ condition: 'document.readyState === "complete"', timeout_ms: 10000 }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const res = await ctx.browser.waitFor({ condition: args.condition, timeoutMs: args.timeout_ms ?? 15000 });
      if (!res.satisfied) throw new ToolError('WAIT_TIMEOUT', `Condition not satisfied within ${args.timeout_ms ?? 15000}ms: ${args.condition}`);
      return res;
    },
  },
  {
    name: 'browser.close',
    title: 'Close the automation page',
    category: 'browser',
    permission: 'interact',
    description: 'Close the DevTools connection and the page target used for automation. Does not close other browser windows.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    examples: [{}],
    handler: async (_args, ctx) => ctx.browser.close(),
  },
];
