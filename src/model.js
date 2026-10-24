// Gemma 4 for reading and writing, bge-m3 for embeddings: open weights, local (Ollama) or on DigitalOcean.
// MODEL_API=ollama  -> Ollama's native API (development, and the private local mode)
// MODEL_API=openai  -> any OpenAI-compatible endpoint (DigitalOcean serverless inference in production)
const API = process.env.MODEL_API ?? 'ollama';
const BASE = process.env.MODEL_URL ?? 'http://localhost:11434';
export const MODEL = process.env.MODEL_NAME ?? 'gemma4:latest';
const EMBED = process.env.EMBED_MODEL ?? 'bge-m3';
const KEY = process.env.MODEL_KEY;
const auth = KEY ? { authorization: `Bearer ${KEY}` } : {};

// Returns the parsed JSON reply. `schema` is enforced by Ollama, and spelled out for OpenAI-style endpoints.
export async function ask(prompt, { schema, temperature = 0.3, maxTokens = 1500 } = {}) {
  if (schema && API === 'openai') {
    prompt += `\nThe JSON object must use exactly these keys: ${schema.required.map((k) => `"${k}"${schema.properties[k].type === 'array' ? ' (array of strings)' : ''}`).join(', ')}.`;
  }
  const text = API === 'openai' ? await viaOpenAI(prompt, temperature, maxTokens) : await viaOllama(prompt, schema, temperature, maxTokens);
  let data = JSON.parse(extractJson(text));
  const vals = Object.values(data); // some replies wrap everything in one outer key
  if (schema && vals.length === 1 && vals[0] && typeof vals[0] === 'object' && !Array.isArray(vals[0]) && !(schema.required[0] in data)) data = vals[0];
  return data;
}

async function viaOllama(prompt, schema, temperature, maxTokens) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, stream: false, think: false, keep_alive: '30m',
      ...(schema && { format: schema }),
      options: { temperature, num_predict: maxTokens },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  return (await res.json()).message.content;
}

async function viaOpenAI(prompt, temperature, maxTokens) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({
      model: MODEL, temperature, max_tokens: maxTokens,
      ...(process.env.MODEL_JSON_MODE !== 'false' && { response_format: { type: 'json_object' } }),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content ?? '';
}

function extractJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error(`model returned no JSON: ${text.slice(0, 200)}`);
  return text.slice(s, e + 1);
}

// 1024-dimension embedding for search.
export async function embed(text) {
  const input = text.slice(0, 6000);
  if (API === 'openai') {
    const res = await fetch(`${BASE}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: EMBED, input }) });
    if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
    return (await res.json()).data[0].embedding;
  }
  const res = await fetch(`${BASE}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: EMBED, input, keep_alive: '30m' }) });
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings[0];
}
