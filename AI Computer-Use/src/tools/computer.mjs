import path from 'node:path';
import { ToolError } from '../core/errors.mjs';
import { launchProcess, resolveApplication, waitForElement, waitForWindow, arrayify } from '../controller/desktop.mjs';

const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });

const regionSchema = {
  type: 'object',
  description: 'Rectangle in physical screen pixels.',
  properties: {
    x: int('Left edge (physical px)'),
    y: int('Top edge (physical px)'),
    width: int('Width (physical px)', { minimum: 1 }),
    height: int('Height (physical px)', { minimum: 1 }),
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
};

const elementOrPoint = {
  type: 'object',
  properties: {
    element_id: str('Verified UIA element id from computer.get_ui_tree / locate_element (preferred)'),
    x: int('Screen x in physical pixels (only when no element_id)'),
    y: int('Screen y in physical pixels (only when no element_id)'),
    button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
    count: int('Click count', { minimum: 1, maximum: 3, default: 1 }),
    window_handle: int('Target window handle; focused and verified before the click'),
  },
  additionalProperties: false,
};

function requirePointOrElement(args) {
  const hasElement = typeof args.element_id === 'string' && args.element_id.length > 0;
  const hasPoint = Number.isInteger(args.x) && Number.isInteger(args.y);
  if (hasElement === hasPoint) {
    throw new ToolError('INVALID_ARGUMENT', 'Provide exactly one of element_id or (x and y). Element ids are preferred because they are verified.');
  }
  return { hasElement, hasPoint };
}

async function focusIfRequested(ctx, args) {
  if (!args.window_handle) return null;
  const info = await ctx.host.call('focus_window', { handle: args.window_handle });
  if (!info.focus_ok) {
    throw new ToolError('FOCUS_FAILED', `Window '${info.title}' could not be focused; not clicking blindly`);
  }
  return info;
}

async function clickTool(ctx, args, { button, defaultCount = 1 }) {
  ctx.checkAbort();
  const { hasElement } = requirePointOrElement(args);
  const focus = await focusIfRequested(ctx, args);
  if (hasElement) {
    if ((args.button && args.button !== 'left') || (args.count ?? defaultCount) > 1) {
      const rect = await ctx.host.call('element_rect', { element_id: args.element_id });
      if (!rect.bounds) throw new ToolError('NOT_FOUND', 'Element has no bounding rectangle');
      const cx = rect.bounds.x + Math.floor(rect.bounds.width / 2);
      const cy = rect.bounds.y + Math.floor(rect.bounds.height / 2);
      const res = await ctx.host.call('click', { x: cx, y: cy, button: args.button ?? 'left', count: args.count ?? defaultCount });
      return { method: 'coordinate_from_element_bounds', element_id: args.element_id, ...res, focused: focus?.title ?? null };
    }
    const res = await ctx.host.call('invoke_element', { element_id: args.element_id });
    return { ...res, focused: focus?.title ?? null };
  }
  const res = await ctx.host.call('click', { x: args.x, y: args.y, button: args.button ?? 'left', count: args.count ?? defaultCount });
  return { method: 'coordinate', ...res, focused: focus?.title ?? null, note: 'Coordinate click is a visual estimate, not a verified element action.' };
}

export const computerTools = [
  {
    name: 'computer.get_screenshot',
    title: 'Capture a screenshot',
    category: 'perception',
    permission: 'observe',
    description: 'Capture a real screenshot of the desktop, active window, a specific window, a monitor, or a screen region. Returns a file reference, physical-pixel dimensions, DPI scale, origin, SHA-256 and average-hash. Password fields are masked by default.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['full', 'active_window', 'window', 'region', 'monitor'], default: 'full' },
        region: regionSchema,
        window_handle: int('Window handle for target=window'),
        monitor: int('Monitor index for target=monitor (0-based)', { minimum: 0 }),
        mask_password_fields: bool('Black out UI Automation password fields (default true)'),
      },
      additionalProperties: false,
    },
    examples: [{ target: 'active_window' }],
    whenNotToUse: 'Do not use as the only source of truth when a UIA tree is available; screenshots do not prove element identity.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const shot = await ctx.perception.screenshot(args);
      return { ...shot, note: 'Coordinates are physical pixels. Use this reference for evidence and for compare_screenshots.' };
    },
  },
  {
    name: 'computer.get_active_window',
    title: 'Get active window',
    category: 'perception',
    permission: 'observe',
    description: 'Return the foreground window: title, process, pid, handle, bounds, DPI scale and focus state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    examples: [{}],
    handler: async (_args, ctx) => {
      ctx.checkAbort();
      return ctx.host.call('active_window');
    },
  },
  {
    name: 'computer.list_windows',
    title: 'List windows',
    category: 'perception',
    permission: 'observe',
    description: 'List visible top-level windows with handle, title, process, pid, bounds and state. Optionally filter by title or process substring.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: str('Case-insensitive substring of window title or process name'),
        include_minimized: bool('Include minimized windows (default true)'),
      },
      additionalProperties: false,
    },
    examples: [{ filter: 'notepad' }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const res = await ctx.host.call('list_windows', { filter: args.filter ?? '', include_minimized: args.include_minimized ?? true });
      return { count: res.count, windows: arrayify(res.windows) };
    },
  },
  {
    name: 'computer.get_screen_resolution',
    title: 'Get screen geometry',
    category: 'perception',
    permission: 'observe',
    description: 'Return virtual-screen bounds, monitor list, DPI scale, cursor position, foreground window and available OCR languages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    examples: [{}],
    whenNotToUse: 'Do not use to detect UI state; use get_ui_tree or a screenshot.',
    handler: async (_args, ctx) => {
      ctx.checkAbort();
      const info = await ctx.host.call('screen_info');
      return {
        ...info,
        monitors: arrayify(info.monitors),
        ocr_languages: arrayify(info.ocr_languages),
        note: 'All coordinates in this agent are physical pixels (Per-Monitor-V2 DPI aware).',
      };
    },
  },
  {
    name: 'computer.get_ui_tree',
    title: 'Read the UI Automation tree',
    category: 'perception',
    permission: 'observe',
    description: 'Read the accessibility (UI Automation) tree of the active window or desktop. Returns verified element ids, roles, names, automation ids, bounds and supported patterns. Element ids expire when a new snapshot is taken.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['active_window', 'desktop'], default: 'active_window' },
        window_handle: int('Window to inspect (defaults to the foreground window)'),
        depth: int('Maximum tree depth', { minimum: 1, maximum: 8, default: 4 }),
        max_nodes: int('Maximum number of nodes', { minimum: 10, maximum: 800, default: 250 }),
        include_offscreen: bool('Include offscreen elements (default false)'),
      },
      additionalProperties: false,
    },
    examples: [{ depth: 4, max_nodes: 200 }],
    whenNotToUse: 'Do not use for canvas/game/custom-drawn UIs that do not expose accessibility; use a screenshot plus OCR there.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const tree = await ctx.perception.uiTree(args);
      return { ...tree, nodes: arrayify(tree.nodes), grounding: 'verified_uia', note: 'Element ids are valid only for this snapshot; re-read the tree after any action.' };
    },
  },
  {
    name: 'computer.inspect_element',
    title: 'Inspect a UI element',
    category: 'perception',
    permission: 'observe',
    description: 'Return detailed properties of a verified element id: role, name, automation id, bounds, enabled/offscreen state, value, toggle/selection state and supported UIA patterns.',
    inputSchema: {
      type: 'object',
      properties: { element_id: str('Element id from the current UIA snapshot') },
      required: ['element_id'],
      additionalProperties: false,
    },
    examples: [{ element_id: 's3-e12' }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.perception.inspectElement(args.element_id);
    },
  },
  {
    name: 'computer.locate_element',
    title: 'Locate a UI element by description',
    category: 'perception',
    permission: 'observe',
    description: 'Find UI elements by name, partial name, regex, role and/or automation id. UI Automation matches are verified; if none match, Windows OCR is used and the result is explicitly marked as a visual estimate (verified=false).',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Exact accessible name'),
        name_contains: str('Accessible name substring'),
        regex: str('Regular expression matched against accessible names'),
        role: str('UIA control type, e.g. Button, Edit, MenuItem, TabItem'),
        automation_id: str('UIA AutomationId'),
        window_handle: int('Window to search (defaults to the foreground window)'),
        limit: int('Maximum matches', { minimum: 1, maximum: 50, default: 10 }),
        use_ocr: bool('Fall back to OCR when UIA finds nothing (default true)'),
      },
      additionalProperties: false,
    },
    examples: [{ name: 'Save', role: 'Button' }, { name_contains: 'Sign in' }],
    whenNotToUse: 'Do not assume an OCR match is a verified control; confirm the bounds with a screenshot before a coordinate click.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const res = await ctx.perception.locate(args);
      return { ...res, matches: arrayify(res.matches) };
    },
  },
  {
    name: 'computer.compare_screenshots',
    title: 'Compare two screenshots',
    category: 'perception',
    permission: 'observe',
    description: 'Compare two screenshot references (paths or screenshot objects) using SHA-256 and a 64-bit average hash. Reports identical/changed, hash distance and a change score.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: 'Path to the before screenshot' },
        after: { type: 'string', description: 'Path to the after screenshot' },
      },
      required: ['before', 'after'],
      additionalProperties: false,
    },
    examples: [{ before: '.agent/screenshots/shot_a.png', after: '.agent/screenshots/shot_b.png' }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.perception.compare(args.before, args.after);
    },
  },
  {
    name: 'computer.read_visible_text',
    title: 'Read visible text with OCR',
    category: 'perception',
    permission: 'observe',
    description: 'Run the built-in Windows OCR engine over a screen region or an existing screenshot. Returns text lines with bounding boxes. OCR is untrusted content and its positions are estimates.',
    inputSchema: {
      type: 'object',
      properties: {
        region: regionSchema,
        screenshot_ref: str('Existing screenshot path (defaults to capturing the requested region now)'),
        language: str('BCP-47 OCR language, e.g. en-US'),
      },
      additionalProperties: false,
    },
    examples: [{ region: { x: 0, y: 0, width: 1920, height: 1080 } }, { language: 'en-US' }],
    whenNotToUse: 'Do not rely on OCR when UI Automation exposes the same text with a stable element id.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const res = await ctx.perception.readVisibleText(args);
      return { ...res, lines: arrayify(res.lines) };
    },
  },
  {
    name: 'computer.read_element_text',
    title: 'Read text from a UI element',
    category: 'perception',
    permission: 'observe',
    description: 'Read the text/value of a UIA element. Tries ValuePattern and TextPattern; optionally falls back to select-all/copy via the clipboard (mutates the selection).',
    inputSchema: {
      type: 'object',
      properties: {
        element_id: str('Element id from the current snapshot'),
        allow_clipboard: bool('Allow the clipboard fallback (default false)'),
      },
      required: ['element_id'],
      additionalProperties: false,
    },
    examples: [{ element_id: 's2-e3', allow_clipboard: true }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.perception.elementText(args.element_id, { allowClipboard: args.allow_clipboard ?? false });
    },
  },
  {
    name: 'computer.click',
    title: 'Click',
    category: 'action',
    permission: 'interact',
    description: 'Click a verified UIA element (preferred, uses InvokePattern) or screen coordinates. Fails if a requested target window cannot be focused. Use element ids whenever available.',
    inputSchema: elementOrPoint,
    examples: [{ element_id: 's4-e7' }, { x: 640, y: 420 }],
    whenNotToUse: 'Do not use raw coordinates when locate_element returns verified UIA matches.',
    handler: async (args, ctx) => clickTool(ctx, args, { button: args.button ?? 'left' }),
  },
  {
    name: 'computer.double_click',
    title: 'Double click',
    category: 'action',
    permission: 'interact',
    description: 'Double-click a verified element (resolved to its bounding-box centre) or screen coordinates.',
    inputSchema: elementOrPoint,
    examples: [{ x: 300, y: 200 }],
    handler: async (args, ctx) => clickTool(ctx, args, { button: args.button ?? 'left', defaultCount: 2 }),
  },
  {
    name: 'computer.right_click',
    title: 'Right click',
    category: 'action',
    permission: 'interact',
    description: 'Right-click a verified element (bounding-box centre) or screen coordinates.',
    inputSchema: elementOrPoint,
    examples: [{ x: 300, y: 200 }],
    handler: async (args, ctx) => clickTool(ctx, args, { button: 'right' }),
  },
  {
    name: 'computer.move_mouse',
    title: 'Move mouse',
    category: 'action',
    permission: 'interact',
    description: 'Move the cursor to physical screen coordinates without clicking.',
    inputSchema: {
      type: 'object',
      properties: { x: int('Screen x (physical px)'), y: int('Screen y (physical px)') },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    examples: [{ x: 800, y: 500 }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.host.call('move_mouse', { x: args.x, y: args.y });
    },
  },
  {
    name: 'computer.scroll',
    title: 'Scroll',
    category: 'action',
    permission: 'interact',
    description: 'Scroll the wheel at the current cursor position or at given coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        x: int('Optional x to move to first'),
        y: int('Optional y to move to first'),
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], default: 'down' },
        clicks: int('Wheel clicks (1 click = 3 lines)', { minimum: 1, maximum: 50, default: 3 }),
      },
      additionalProperties: false,
    },
    examples: [{ direction: 'down', clicks: 5 }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.host.call('scroll', { x: args.x, y: args.y, direction: args.direction ?? 'down', clicks: args.clicks ?? 3 });
    },
  },
  {
    name: 'computer.type_text',
    title: 'Type text',
    category: 'action',
    permission: 'interact',
    description: 'Type Unicode text with SendInput (Arabic, English and other scripts). Optionally focus a verified element first and optionally replace existing content.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('Text to type (Unicode)', { maxLength: 8000 }),
        element_id: str('Optional verified element to focus before typing'),
        window_handle: int('Optional window to focus and verify before typing'),
        replace: bool('Select all before typing (default false)'),
      },
      required: ['text'],
      additionalProperties: false,
    },
    examples: [{ text: 'أهلاً بك في نظام Computer Use' }, { text: 'hello', element_id: 's2-e4', replace: true }],
    whenNotToUse: 'Do not use to transmit passwords; mark sensitive operations explicitly and prefer the app’s own flow.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      if (args.window_handle) await focusIfRequested(ctx, args);
      if (args.replace) {
        await ctx.host.call('hotkey', { keys: ['ctrl', 'a'] });
        await ctx.host.call('wait', { ms: 60 });
      }
      const res = await ctx.host.call('type_text', { text: args.text, element_id: args.element_id }, { timeoutMs: Math.max(15000, Math.ceil(args.text.length / 20) * 1000) });
      return { ...res, note: 'Typed with KEYEVENTF_UNICODE; the target application must have keyboard focus.' };
    },
  },
  {
    name: 'computer.press_key',
    title: 'Press a key',
    category: 'action',
    permission: 'interact',
    description: 'Press a named key (Enter, Tab, Escape, F5, Up, a letter, etc.) one or more times.',
    inputSchema: {
      type: 'object',
      properties: {
        key: str('Key name, e.g. enter, tab, escape, f5, a, left'),
        times: int('Repeat count', { minimum: 1, maximum: 50, default: 1 }),
      },
      required: ['key'],
      additionalProperties: false,
    },
    examples: [{ key: 'enter' }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.host.call('press_key', { key: args.key, times: args.times ?? 1 });
    },
  },
  {
    name: 'computer.hotkey',
    title: 'Press a hotkey',
    category: 'action',
    permission: 'interact',
    description: 'Press a key combination such as ctrl+s, ctrl+shift+escape or alt+f4. Keys are pressed in order and released in reverse.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: 'Keys in order, e.g. ["ctrl","s"]',
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
    examples: [{ keys: ['ctrl', 's'] }],
    whenNotToUse: 'Do not use alt+f4 to close documents with unsaved work without a recovery plan.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.host.call('hotkey', { keys: args.keys });
    },
  },
  {
    name: 'computer.drag',
    title: 'Drag',
    category: 'action',
    permission: 'interact',
    description: 'Drag from one screen point to another with a smooth interpolated movement.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'object', properties: { x: int('x'), y: int('y') }, required: ['x', 'y'], additionalProperties: false },
        to: { type: 'object', properties: { x: int('x'), y: int('y') }, required: ['x', 'y'], additionalProperties: false },
        duration_ms: int('Drag duration', { minimum: 50, maximum: 5000, default: 500 }),
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    examples: [{ from: { x: 200, y: 300 }, to: { x: 600, y: 300 } }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.host.call('drag', args);
    },
  },
  {
    name: 'computer.focus_window',
    title: 'Focus a window',
    category: 'action',
    permission: 'interact',
    description: 'Bring a window to the foreground by handle, pid or title substring. Verifies that the foreground window actually changed.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: int('Window handle'),
        pid: int('Process id'),
        title: str('Title substring'),
      },
      additionalProperties: false,
    },
    examples: [{ title: 'Notepad' }],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      if (!args.handle && !args.pid && !args.title) throw new ToolError('INVALID_ARGUMENT', 'Provide handle, pid, or title');
      return ctx.host.call('focus_window', args);
    },
  },
  {
    name: 'computer.open_application',
    title: 'Open an application',
    category: 'action',
    permission: 'modify',
    description: 'Launch an approved application by name (notepad, calc, mspaint, explorer, code, ...) or an absolute executable path. Unknown/executables outside the approved list require explicit approval. Waits for the window and returns launch evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Approved application name or executable path'),
        args: { type: 'array', items: { type: 'string' }, description: 'Optional arguments' },
        wait_for_window: bool('Wait for a window to appear (default true)'),
        timeout_ms: int('Window wait timeout', { minimum: 1000, maximum: 60000, default: 15000 }),
        approval_id: str('Approval id when the application is not on the approved list'),
      },
      required: ['name'],
      additionalProperties: false,
    },
    examples: [{ name: 'notepad' }],
    whenNotToUse: 'Do not use to install software or launch downloaded executables; those always require explicit approval.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const resolved = resolveApplication(args.name, ctx.config);
      if (!resolved.path) throw new ToolError('APP_NOT_FOUND', `Could not resolve application '${args.name}'`);
      const isExe = resolved.path.toLowerCase().endsWith('.exe');
      const approved = resolved.approved && isExe;
      if (!approved) {
        ctx.ensureApproval('unapproved_app', args, {
          summary: `Launch unapproved application: ${resolved.path}`,
          risk: 'modify',
        });
      }
      const before = await ctx.perception.listWindows();
      const beforeHandles = arrayify(before.windows).map((w) => w.handle);
      const launch = launchProcess(resolved.path, args.args ?? []);
      let window = null;
      let wait = null;
      if ((args.wait_for_window ?? true)) {
        const expected = path.basename(resolved.path, '.exe').toLowerCase();
        wait = await waitForWindow(ctx.perception, {
          beforeHandles,
          processNames: expected === 'calc' ? ['calculatorapp', 'calc', 'applicationframehost'] : [expected],
          timeoutMs: args.timeout_ms ?? 15000,
        });
        if (wait.found) {
          window = wait.window;
          await ctx.host.call('focus_window', { handle: window.handle }).catch(() => null);
        }
      }
      return {
        launched: true,
        pid: launch.pid,
        executable: resolved.path,
        application: args.name,
        approved,
        window_found: Boolean(window),
        window,
        wait_ms: wait?.elapsed_ms ?? 0,
        note: window ? 'Window detected after launch (evidence recorded).' : 'Process launched but no matching window was detected within the timeout.',
      };
    },
  },
  {
    name: 'computer.wait_for_element',
    title: 'Wait for an element',
    category: 'action',
    permission: 'observe',
    description: 'Poll UI Automation until an element matching name/role/automation id appears, or fail after the timeout. Use after actions that open dialogs or menus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Exact accessible name'),
        name_contains: str('Name substring'),
        role: str('UIA control type'),
        automation_id: str('AutomationId'),
        window_handle: int('Window to search'),
        timeout_ms: int('Timeout', { minimum: 500, maximum: 60000, default: 8000 }),
      },
      additionalProperties: false,
    },
    examples: [{ name: 'Save As', role: 'Window', timeout_ms: 5000 }],
    handler: async (args, ctx) => {
      const res = await waitForElement(ctx.host, args);
      if (!res.found) {
        throw new ToolError('ELEMENT_NOT_FOUND', `No matching element appeared within ${args.timeout_ms ?? 8000}ms (${res.attempts} polls)`, res);
      }
      return { ...res, grounding: 'verified_uia' };
    },
  },
  {
    name: 'computer.close_window',
    title: 'Close a window',
    category: 'action',
    permission: 'destructive',
    description: 'Request that a window close (WM_CLOSE). This can discard unsaved work, so it always requires explicit approval. Returns whether the window still exists.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: int('Window handle'),
        force: bool('Also request the owning process to close its main window (default false)'),
        approval_id: str('Approval id for this exact call'),
      },
      required: ['handle'],
      additionalProperties: false,
    },
    examples: [{ handle: 123456 }],
    whenNotToUse: 'Do not close windows you do not own without checking for unsaved changes first.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      return ctx.host.call('close_window', { handle: args.handle, force: args.force ?? false });
    },
  },
];
