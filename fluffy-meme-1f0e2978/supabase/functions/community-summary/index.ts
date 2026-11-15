import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Use POST for community summaries.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !supabaseAnonKey || !geminiApiKey) {
    return jsonResponse({ error: 'The secure community-summary service is not configured yet.' }, 503);
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization) return jsonResponse({ error: 'Sign in to request a community research summary.' }, 401);
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return jsonResponse({ error: 'Your sign-in could not be verified.' }, 401);

  let caseRef: string;
  try {
    const body = await request.json();
    caseRef = typeof body.case_ref === 'string' ? body.case_ref.trim() : '';
  } catch {
    return jsonResponse({ error: 'Send a valid case reference.' }, 400);
  }
  if (!caseRef || caseRef.length > 100) return jsonResponse({ error: 'Choose a valid case first.' }, 400);

  const { data: posts, error: postsError } = await supabase
    .from('research_posts')
    .select('id,title,finding,method,variable_name,unit,location_label,period_label,p_value,result_direction,citation_urls')
    .eq('case_ref', caseRef)
    .eq('visibility', 'public')
    .eq('include_in_summary', true)
    .order('created_at', { ascending: false })
    .limit(40);
  if (postsError) return jsonResponse({ error: 'Shared research could not be loaded.' }, 500);
  if (!posts || posts.length < 3) {
    return jsonResponse({ error: 'At least three public, opt-in research posts are needed before creating a community summary.' }, 422);
  }

  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: 'Summarize only the provided public, opt-in research notes. This is not model training and not a scientific consensus. Do not claim causation, do not invent facts, sources, sample sizes, or measurements. Identify agreement, disagreement, missing context, and limitations; note that results may use different dates, locations, units, and methods. Do not average or combine measurements from unlike studies or locations. Treat p-values as individual-study results and never average them. Return JSON with summary, patterns (array of strings), and limitations (array of strings).',
        }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: JSON.stringify(posts.map(({ id, ...post }) => ({ id, ...post }))) }],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            summary: { type: 'STRING' },
            patterns: { type: 'ARRAY', items: { type: 'STRING' } },
            limitations: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['summary', 'patterns', 'limitations'],
        },
        maxOutputTokens: 700,
      },
    }),
  });
  if (!response.ok) return jsonResponse({ error: 'Gemini could not summarize the shared research right now.' }, 502);

  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('');
  if (!text) return jsonResponse({ error: 'Gemini returned an empty community summary.' }, 502);
  try {
    const summary = JSON.parse(text);
    return jsonResponse({
      summary: typeof summary.summary === 'string' ? summary.summary.slice(0, 1600) : '',
      patterns: Array.isArray(summary.patterns) ? summary.patterns.filter((item: unknown) => typeof item === 'string').slice(0, 6) : [],
      limitations: Array.isArray(summary.limitations) ? summary.limitations.filter((item: unknown) => typeof item === 'string').slice(0, 6) : [],
      contribution_count: posts.length,
      source_post_ids: posts.map((post) => post.id),
    });
  } catch {
    return jsonResponse({ error: 'Gemini returned a summary that could not be read.' }, 502);
  }
});
