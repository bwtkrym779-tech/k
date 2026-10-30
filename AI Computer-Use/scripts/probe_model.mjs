// Capability probe for a local OpenAI-compatible endpoint.
// Usage: node probe_model.mjs <baseUrl> [model]
const base = process.argv[2] ?? 'http://127.0.0.1:5000/v1';
const model = process.argv[3];

async function post(path, body, timeoutMs = 180000) {
  const started = Date.now();
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - started, text };
}

function report(name, r) {
  console.log(`\n=== ${name} ===`);
  console.log(`status=${r.status} latency_ms=${r.ms}`);
  console.log(r.text.slice(0, 1500));
}

const m = model ?? (await (await fetch(base + '/models')).json()).data[0].id;
console.log('endpoint:', base, 'model:', m);

// 1. Tool calling
const tools = [{
  type: 'function',
  function: {
    name: 'computer_open_application',
    description: 'Open an application by name on the Windows desktop.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Application name, e.g. notepad' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
}];
report('tools', await post('/chat/completions', {
  model: m,
  messages: [
    { role: 'system', content: 'You are a Windows automation agent. Use tools when needed. Reply with JSON only if no tool is needed.' },
    { role: 'user', content: 'Please open Notepad for me.' },
  ],
  tools,
  tool_choice: 'auto',
  temperature: 0,
  max_tokens: 200,
}));

// 2. JSON schema structured output
report('json_schema', await post('/chat/completions', {
  model: m,
  messages: [
    { role: 'system', content: 'Return a single JSON object, no markdown.' },
    { role: 'user', content: 'Classify: click the Save button. Return {"action": "...", "risk": "low|medium|high"}.' },
  ],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'decision',
      strict: true,
      schema: {
        type: 'object',
        properties: { action: { type: 'string' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] } },
        required: ['action', 'risk'],
        additionalProperties: false,
      },
    },
  },
  temperature: 0,
  max_tokens: 150,
}));

// 3. Arabic
report('arabic', await post('/chat/completions', {
  model: m,
  messages: [
    { role: 'system', content: 'Answer in the same language as the user.' },
    { role: 'user', content: 'اكتب الجملة التالية فقط: أهلاً بك في نظام Computer Use' },
  ],
  temperature: 0,
  max_tokens: 120,
}));

// 4. Vision (1x1 red PNG)
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
report('vision', await post('/chat/completions', {
  model: m,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What color is this image? Answer with one word.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } },
    ],
  }],
  temperature: 0,
  max_tokens: 30,
}));
