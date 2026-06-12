/**
 * Chat-with-your-data agent.
 *
 * Tool-calling loop against OpenRouter. The LLM never computes numbers —
 * it picks tools, our deterministic metrics code returns exact values, and
 * the LLM phrases the answer. Aggregates only: no customer names/emails are
 * ever sent to the model.
 *
 * Returns { answer, charts:[{title, kind, points}] }.
 */

import { getSchema, queryMetrics, monthlySeries, comparePeriods } from './metrics.js';
import { runSql, SQL_COLUMNS } from './sql.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const MAX_ROUNDS = 6;

function systemPrompt(today) {
  const schema = getSchema();
  return [
    'You are the analytics assistant embedded in the Mr. Vig LLC revenue dashboard.',
    'You answer questions about the business by CALLING TOOLS. You must never compute or estimate numbers yourself — every figure you state must come from a tool result. If you need a number, call a tool.',
    '',
    `Today is ${today}. Data covers ${schema.data_min_date} to ${schema.data_max_date}. Primary currency is EUR.`,
    `Tracked products: ${schema.tracked_products.join(', ')}. Anything else is "Other".`,
    `Channels: ${schema.channels.join(', ')}.`,
    schema.notes,
    '',
    'Guidance:',
    '- Resolve relative dates ("last month", "Q1", "last 90 days") to explicit YYYY-MM-DD ranges before calling tools.',
    '- For comparisons ("vs last month", "year over year"), use compare_periods so the delta is exact.',
    '- For trends or when a visual helps, call monthly_series and then call make_chart with those points to render a chart.',
    '- Be concise and concrete. Lead with the number, then brief context. Use € formatting.',
    '- If data for a requested period is outside the available range, say so.',
    '',
    'TWO WAYS TO GET NUMBERS — pick the right one:',
    '1. For subscriber counts, churn, MRR, active subscribers, sales/rebills splits → use query_metrics / monthly_series / compare_periods. These encode the price→cadence rules (e.g. €99 Vig Village = 1 month, €594 = annual) needed to define "active" and "churn" correctly. Do NOT compute active/churn from raw SQL — the raw table has no cadence logic.',
    '2. For anything those tools cannot express — LTV, average revenue per customer, cohort/retention analysis, "customers who bought X then later bought Y", per-customer totals, refund rates, distributions, one-off counts → use run_sql against the `charges` table. The query engine computes exact results; never estimate yourself.',
    '',
    'The run_sql `charges` table has one row per Paid/Refunded charge with columns: ' +
      SQL_COLUMNS.map((c) => c.name).join(', ') + '.',
    'Column notes: ' + SQL_COLUMNS.map((c) => `${c.name} = ${c.desc}`).join('; ') + '.',
    'SQL tips:',
    '- Revenue is net = amount-amount_refunded; filter status=\'Paid\' for revenue; amounts are EUR unless currency=\'usd\'.',
    '- COUNTING CUSTOMERS: always dedupe to one row per customer BEFORE counting or joining. Use COUNT(DISTINCT customer_email), or a subquery that does GROUP BY customer_email. NEVER count rows of a charges-to-charges join as customers — that multiplies charge pairs and massively overcounts.',
    '- LTV per customer: SELECT AVG(t) ltv FROM (SELECT customer_email, SUM(net) t FROM charges WHERE status=\'Paid\' AND product=\'Mr. Vigs Atomic Homework\' AND customer_email<>\'\' GROUP BY customer_email).',
    '- "Bought both X and Y": join two per-customer subqueries (each already GROUP BY customer_email) on customer_email; the result has one row per shared customer. Example: SELECT COUNT(*) n FROM (SELECT customer_email FROM charges WHERE status=\'Paid\' AND product=\'X\' AND customer_email<>\'\' GROUP BY customer_email) a JOIN (SELECT customer_email FROM charges WHERE status=\'Paid\' AND product=\'Y\' AND customer_email<>\'\' GROUP BY customer_email) b ON a.customer_email=b.customer_email.',
    '- After running a query, sanity-check the magnitude; if a customer count exceeds the total distinct customers, your query is double-counting — fix it before answering.',
  ].join('\n');
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_schema',
      description: 'Returns available products, channels, the data date range, and metric definitions. Call this if unsure what is available.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_metrics',
      description: 'Exact metrics for a date window with optional product/channel filter: revenue, sales (new), rebills (recurring), refunds, active_subscribers, MRR, cancelled, churn_pct, channel split, and per-product breakdown.',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
          end_date: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
          product: { type: 'string', description: 'One of the tracked products, or "Other". Omit for all.' },
          channel: { type: 'string', enum: ['kartra_orchestrated', 'native_stripe_sub', 'paypal'], description: 'Omit for all channels.' },
        },
        required: ['start_date', 'end_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'monthly_series',
      description: 'Monthly time series of one metric over a window. Use for trends and to feed make_chart. NOTE: metric "churn" returns a monthly churn RATE as a percentage (subs active at month start that lapsed by next month start ÷ active at month start), NOT a raw count. revenue/sales/rebills are EUR.',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['revenue', 'sales', 'rebills', 'churn'] },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          product: { type: 'string' },
          channel: { type: 'string', enum: ['kartra_orchestrated', 'native_stripe_sub', 'paypal'] },
        },
        required: ['metric', 'start_date', 'end_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_periods',
      description: 'Exact comparison of one metric between two date windows. Returns both values, delta, and percent change.',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['revenue_eur', 'sales_eur', 'rebills_eur', 'active_subscribers', 'mrr_eur', 'churn_pct', 'refunds_eur'] },
          a_start: { type: 'string' }, a_end: { type: 'string' },
          b_start: { type: 'string' }, b_end: { type: 'string' },
          product: { type: 'string' },
          channel: { type: 'string', enum: ['kartra_orchestrated', 'native_stripe_sub', 'paypal'] },
        },
        required: ['metric', 'a_start', 'a_end', 'b_start', 'b_end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description: 'Run a read-only SELECT query against the `charges` table (one row per Paid/Refunded charge) and get exact rows back. Use for LTV, average revenue per customer, cohort/retention, per-customer rollups, distributions, and anything the metric tools cannot express. Do NOT use for active-subscriber/churn/MRR (use query_metrics for those — they encode cadence rules). Read-only: SELECT/WITH only.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A single read-only SQL SELECT statement over table `charges`.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_chart',
      description: 'Render a bar chart in the chat. Provide points you obtained from monthly_series or query_metrics. Use after gathering the data.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['revenue', 'churn'], description: 'Color theme: revenue (blue) or churn (red).' },
          unit: { type: 'string', enum: ['eur', 'count', 'percent'], description: 'How to format values: eur (€), count, or percent (%). Use percent for churn-rate charts.' },
          points: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] },
          },
        },
        required: ['title', 'points'],
      },
    },
  },
];

function runTool(name, args) {
  switch (name) {
    case 'get_schema': return getSchema();
    case 'query_metrics': return queryMetrics(args || {});
    case 'monthly_series': return monthlySeries(args || {});
    case 'compare_periods': return comparePeriods(args || {});
    case 'run_sql': return runSql((args && args.query) || '');
    case 'make_chart': return { ok: true }; // chart captured separately by caller
    default: return { error: 'unknown tool: ' + name };
  }
}

async function callOpenRouter(messages, model) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY not set');
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mr-vig-dashboard-production.up.railway.app',
      'X-Title': 'Mr. Vig Dashboard',
    },
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2 }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * @param {Array<{role, content}>} history  prior chat turns (user/assistant)
 * @param {string} todayISO  YYYY-MM-DD
 */
export async function chatWithData(history, todayISO) {
  const model = process.env.CHAT_MODEL || DEFAULT_MODEL;
  const messages = [
    { role: 'system', content: systemPrompt(todayISO) },
    ...history.map((m) => ({ role: m.role, content: String(m.content || '') })),
  ];
  const charts = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await callOpenRouter(messages, model);
    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error('No response from model');

    if (msg.tool_calls && msg.tool_calls.length) {
      // record the assistant's tool-call turn verbatim
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        if (tc.function.name === 'make_chart') {
          charts.push({
            title: args.title || 'Chart',
            kind: args.kind === 'churn' ? 'churn' : 'revenue',
            unit: args.unit || 'eur',
            points: Array.isArray(args.points) ? args.points : [],
          });
        }
        const result = runTool(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue; // let the model read tool results
    }

    // final answer
    return { answer: (msg.content || '').trim(), charts };
  }
  return { answer: 'Sorry — I couldn’t resolve that within the step limit. Try narrowing the question.', charts };
}
