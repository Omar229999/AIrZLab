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

const measurements: Record<string, { label: string; unit: string }> = {
  T2M_MAX: { label: 'daily maximum air temperature', unit: 'degrees Celsius' },
  PRECTOTCORR: { label: 'corrected precipitation accumulated over seven days', unit: 'millimeters per seven days' },
  RH2M: { label: 'daily relative humidity at two meters', unit: 'percent' },
  WS2M: { label: 'daily wind speed at two meters', unit: 'meters per second' },
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Use POST to draft a Guardian monitor.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !supabaseAnonKey || !geminiApiKey) {
    return jsonResponse({ error: 'The secure Guardian drafting service is not configured yet.' }, 503);
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization) return jsonResponse({ error: 'Sign in before drafting a Guardian monitor.' }, 401);
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return jsonResponse({ error: 'Your sign-in could not be verified.' }, 401);

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: 'Send a valid Guardian monitor setup.' }, 400);
  }

  const hazard = typeof input.hazard === 'string' ? input.hazard : '';
  const parameter = typeof input.parameter === 'string' ? input.parameter : '';
  const location = typeof input.location_label === 'string' ? input.location_label.trim().slice(0, 140) : '';
  const operator = typeof input.threshold_operator === 'string' ? input.threshold_operator : '';
  const threshold = typeof input.threshold_value === 'number' ? input.threshold_value : Number.NaN;
  const latitude = typeof input.latitude === 'number' ? input.latitude : Number.NaN;
  const longitude = typeof input.longitude === 'number' ? input.longitude : Number.NaN;
  const context = typeof input.context === 'string' ? input.context.trim().slice(0, 500) : '';

  if (!['heat', 'water', 'custom'].includes(hazard)) {
    return jsonResponse({ error: 'Automated NASA POWER monitors are not available for air quality. Use local official AQI alerts.' }, 422);
  }
  if (!measurements[parameter] || !['above', 'below'].includes(operator)) {
    return jsonResponse({ error: 'Choose a supported NASA POWER measure and threshold direction.' }, 400);
  }
  if ((hazard === 'heat' && (parameter !== 'T2M_MAX' || operator !== 'above'))
    || (hazard === 'water' && (parameter !== 'PRECTOTCORR' || operator !== 'below'))) {
    return jsonResponse({ error: 'Choose the matching supported measure and direction for heat or low-rainfall monitoring.' }, 422);
  }
  if (!location || !Number.isFinite(threshold) || Math.abs(threshold) >= 10000
    || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return jsonResponse({ error: 'Enter a place, a reasonable threshold, and valid coordinates.' }, 400);
  }

  const measurement = measurements[parameter];
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: 'Help a beginner draft a small, informational community weather monitor. The user has already chosen the NASA POWER measurement, coordinates, threshold, and trigger. Do not change them, invent a reading, claim an official warning, imply emergency-service reliability, or write code. State that NASA POWER is a modeled estimate that can lag by days, and that crossing a threshold is not proof of danger or causation. Keep the notification calm, practical, and under 240 characters. Return only JSON with app_name, summary, and notification_message.',
        }],
      },
      contents: [{
        role: 'user',
        parts: [{
          text: JSON.stringify({
            hazard,
            location,
            measurement: measurement.label,
            unit: measurement.unit,
            threshold_operator: operator,
            threshold_value: threshold,
            user_context: context,
            check_cadence: 'once per day, using NASA POWER daily data that is typically delayed by 2–3 days',
          }),
        }],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            app_name: { type: 'STRING' },
            summary: { type: 'STRING' },
            notification_message: { type: 'STRING' },
          },
          required: ['app_name', 'summary', 'notification_message'],
        },
        maxOutputTokens: 450,
      },
    }),
  });
  if (!response.ok) return jsonResponse({ error: 'Gemini could not draft the monitor right now. Check the provider configuration and try again.' }, 502);

  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('');
  if (!text) return jsonResponse({ error: 'Gemini returned an empty monitor draft.' }, 502);

  try {
    const draft = JSON.parse(text);
    const boundedText = (field: string, maximum: number) => typeof draft[field] === 'string' ? draft[field].trim().slice(0, maximum) : '';
    const appName = boundedText('app_name', 100);
    const summary = boundedText('summary', 700);
    const notificationMessage = boundedText('notification_message', 500);
    if (appName.length < 4 || summary.length < 20 || notificationMessage.length < 20) {
      return jsonResponse({ error: 'Gemini returned an incomplete draft. Try again with more local context.' }, 502);
    }
    return jsonResponse({ app_name: appName, summary, notification_message: notificationMessage });
  } catch {
    return jsonResponse({ error: 'Gemini returned a monitor draft that could not be read.' }, 502);
  }
});
