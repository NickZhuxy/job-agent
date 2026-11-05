// A provider has one method: completeJSON({ system, user, schema }) returns { data, usage }.
export function parseJSON(text) {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

async function anthropicProvider(env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY.');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const model = env.JOB_AGENT_MODEL || 'claude-sonnet-5-5';
  return {
    name: `anthropic:${model}`,
    async completeJSON({ system, user, schema }) {
      const res = await client.messages.create({
        model,
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema } },
      });
      if (res.stop_reason !== 'end_turn') throw new Error(`The model stopped early: ${res.stop_reason}.`);
      const text = res.content.find(block => block.type === 'text')?.text;
      return { data: parseJSON(text), usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
    },
  };
}

function openAICompatibleProvider(env) {
  if (!env.JOB_AGENT_MODEL) throw new Error('Set JOB_AGENT_MODEL.');
  const base = (env.JOB_AGENT_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  return {
    name: `openai-compatible:${env.JOB_AGENT_MODEL}`,
    async completeJSON({ system, user, schema }) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(env.JOB_AGENT_API_KEY ? { Authorization: `Bearer ${env.JOB_AGENT_API_KEY}` } : {}) },
        body: JSON.stringify({
          model: env.JOB_AGENT_MODEL,
          messages: [
            { role: 'system', content: `${system}\n\nReturn only JSON that matches this JSON Schema:\n${JSON.stringify(schema)}` },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
        }),
      });
      if (!res.ok) throw new Error(`The model API returned ${res.status}.`);
      const body = await res.json();
      return {
        data: parseJSON(body.choices?.[0]?.message?.content),
        usage: { input_tokens: body.usage?.prompt_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

export async function createProvider(env = process.env) {
  const kind = env.JOB_AGENT_PROVIDER || 'anthropic';
  if (kind === 'anthropic') return anthropicProvider(env);
  if (kind === 'openai-compatible') return openAICompatibleProvider(env);
  throw new Error(`Unknown provider: ${kind}.`);
}
