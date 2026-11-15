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
  if (request.method !== 'POST') return jsonResponse({ error: 'Use POST for case drafts.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !supabaseAnonKey || !geminiApiKey) {
    return jsonResponse({ error: 'The secure case-drafting service is not configured yet.' }, 503);
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization) return jsonResponse({ error: 'Sign in before creating an AI case draft.' }, 401);
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return jsonResponse({ error: 'Your sign-in could not be verified.' }, 401);

  let prompt: string;
  try {
    const body = await request.json();
    prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  } catch {
    return jsonResponse({ error: 'Send a valid case idea.' }, 400);
  }
  if (prompt.length < 12 || prompt.length > 800) {
    return jsonResponse({ error: 'Describe a case idea in 12 to 800 characters.' }, 400);
  }

  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: 'Create a concise, beginner-friendly Earth-science investigation case. Keep it an open question, distinguish observations from hypotheses, never invent measurements or claim a discovery, and do not invent URLs or citations. Suggest only source categories such as NASA Earthdata, NASA POWER, Landsat, or local official data. Return only JSON with title, location_label, summary, research_question, latitude, longitude, and source_suggestions. Coordinates must be numbers only when the place is unambiguous; otherwise return null.',
        }],
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            location_label: { type: 'STRING' },
            summary: { type: 'STRING' },
            research_question: { type: 'STRING' },
            latitude: { type: 'NUMBER', nullable: true },
            longitude: { type: 'NUMBER', nullable: true },
            source_suggestions: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['title', 'location_label', 'summary', 'research_question', 'source_suggestions'],
        },
        maxOutputTokens: 700,
      },
    }),
  });
  if (!response.ok) return jsonResponse({ error: 'Gemini could not draft the case right now. Check the provider configuration and try again.' }, 502);

  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('');
  if (!text) return jsonResponse({ error: 'Gemini returned an empty case draft.' }, 502);

  let draft: Record<string, unknown>;
  try {
    draft = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Gemini returned a case draft that could not be read. Try a more specific idea.' }, 502);
  }

  const stringField = (field: string, maximum: number) => typeof draft[field] === 'string' ? (draft[field] as string).trim().slice(0, maximum) : '';
  const latitude = typeof draft.latitude === 'number' && Number.isFinite(draft.latitude) && draft.latitude >= -90 && draft.latitude <= 90 ? draft.latitude : null;
  const longitude = typeof draft.longitude === 'number' && Number.isFinite(draft.longitude) && draft.longitude >= -180 && draft.longitude <= 180 ? draft.longitude : null;
  const suggestions = Array.isArray(draft.source_suggestions)
    ? draft.source_suggestions.filter((item): item is string => typeof item === 'string').slice(0, 5).map((item) => item.slice(0, 100))
    : [];
  return jsonResponse({
    title: stringField('title', 100),
    location_label: stringField('location_label', 140),
    summary: stringField('summary', 700),
    research_question: stringField('research_question', 300),
    latitude,
    longitude,
    source_suggestions: suggestions,
  });
});
