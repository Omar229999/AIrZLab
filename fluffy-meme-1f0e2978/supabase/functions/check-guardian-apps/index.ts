import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

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

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function trustedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (host === 'fcm.googleapis.com'
        || host === 'fcmregistrations.googleapis.com'
        || host === 'web.push.apple.com'
        || host.endsWith('.push.services.mozilla.com')
        || host.endsWith('.notify.windows.com'));
  } catch {
    return false;
  }
}

function supportedValue(value: unknown, fillValue: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > fillValue;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Use POST to check Guardian monitors.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT');
  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return jsonResponse({ error: 'The scheduled Guardian alert service is not configured.' }, 503);
  }
  if (request.headers.get('Authorization') !== `Bearer ${serviceRoleKey}`) {
    return jsonResponse({ error: 'This endpoint is reserved for the configured schedule.' }, 401);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: apps, error: appsError } = await supabase.from('guardian_apps')
    .select('id,creator_id,name,notification_message,hazard,location_label,latitude,longitude,parameter,threshold_operator,threshold_value,visibility,active,last_data_date')
    .eq('active', true)
    .limit(500);
  if (appsError) return jsonResponse({ error: 'Guardian monitors could not be loaded.' }, 500);

  const availableThrough = new Date();
  availableThrough.setUTCHours(0, 0, 0, 0);
  availableThrough.setUTCDate(availableThrough.getUTCDate() - 3);
  const endDate = dateKey(availableThrough);
  const processed = [];

  for (const app of apps || []) {
    const lastDataDate = app.last_data_date ? String(app.last_data_date).replace(/-/g, '') : '';
    if (lastDataDate && lastDataDate >= endDate) {
      processed.push({ id: app.id, status: 'already_checked' });
      continue;
    }

    const rainMonitor = app.parameter === 'PRECTOTCORR';
    const start = new Date(availableThrough);
    if (rainMonitor) start.setUTCDate(start.getUTCDate() - 6);
    const startDate = dateKey(start);
    const params = new URLSearchParams({
      parameters: app.parameter,
      community: 'AG',
      longitude: String(app.longitude),
      latitude: String(app.latitude),
      start: startDate,
      end: endDate,
      format: 'JSON',
    });
    const dataUrl = `https://power.larc.nasa.gov/api/temporal/daily/point?${params}`;

    try {
      const dataResponse = await fetch(dataUrl);
      if (!dataResponse.ok) {
        console.error(`NASA POWER request failed for Guardian app ${app.id}: HTTP ${dataResponse.status}`);
        processed.push({ id: app.id, status: 'data_unavailable' });
        continue;
      }
      const payload = await dataResponse.json();
      const values = payload.properties?.parameter?.[app.parameter];
      if (!values || typeof values !== 'object') {
        processed.push({ id: app.id, status: 'data_unavailable' });
        continue;
      }

      const fillValue = Number(payload.header?.fill_value ?? -999);
      const dailyValues = Object.entries(values)
        .filter(([key, value]) => key >= startDate && key <= endDate && supportedValue(value, fillValue))
        .map(([key, value]) => ({ date: key, value: Number(value) }))
        .sort((left, right) => left.date.localeCompare(right.date));
      if (!dailyValues.length) {
        processed.push({ id: app.id, status: 'data_unavailable' });
        continue;
      }
      if (rainMonitor && dailyValues.length !== 7) {
        processed.push({ id: app.id, status: 'seven_day_data_unavailable' });
        continue;
      }
      const valueDate = dailyValues[dailyValues.length - 1].date;
      if (lastDataDate && valueDate <= lastDataDate) {
        const { error: checkedError } = await supabase.from('guardian_apps')
          .update({ last_checked_at: new Date().toISOString() }).eq('id', app.id);
        if (checkedError) {
          console.error(`Could not update Guardian app ${app.id} check time: ${checkedError.message}`);
          processed.push({ id: app.id, status: 'state_update_failed' });
          continue;
        }
        processed.push({ id: app.id, status: 'no_new_data' });
        continue;
      }
      const measurement = rainMonitor
        ? dailyValues.reduce((total, item) => total + item.value, 0)
        : dailyValues[dailyValues.length - 1].value;
      const thresholdCrossed = app.threshold_operator === 'above'
        ? measurement >= Number(app.threshold_value)
        : measurement <= Number(app.threshold_value);
      const now = new Date().toISOString();
      const update = {
        last_data_date: `${valueDate.slice(0, 4)}-${valueDate.slice(4, 6)}-${valueDate.slice(6, 8)}`,
        last_checked_at: now,
        ...(thresholdCrossed ? { last_alerted_at: now } : {}),
      };
      const { error: updateError } = await supabase.from('guardian_apps').update(update).eq('id', app.id);
      if (updateError) {
        console.error(`Could not update Guardian app ${app.id} check state: ${updateError.message}`);
        processed.push({ id: app.id, status: 'state_update_failed' });
        continue;
      }
      if (!thresholdCrossed) {
        processed.push({ id: app.id, status: 'threshold_not_crossed' });
        continue;
      }

      let subscriptionsQuery = supabase.from('guardian_app_subscriptions')
        .select('id,subscriber_id,endpoint,p256dh,auth')
        .eq('guardian_app_id', app.id);
      if (app.visibility !== 'public') subscriptionsQuery = subscriptionsQuery.eq('subscriber_id', app.creator_id);
      const { data: subscriptions, error: subscriptionsError } = await subscriptionsQuery;
      if (subscriptionsError) {
        console.error(`Could not load Guardian app ${app.id} subscribers: ${subscriptionsError.message}`);
        processed.push({ id: app.id, status: 'subscribers_unavailable' });
        continue;
      }

      const parameterMetadata = payload.parameters?.[app.parameter] || {};
      const unit = rainMonitor ? 'mm over 7 days' : parameterMetadata.units || 'NASA POWER units';
      const detail = rainMonitor
        ? `7-day precipitation total ${measurement.toFixed(1)} ${unit}`
        : `${parameterMetadata.longname || app.parameter}: ${measurement.toFixed(1)} ${unit}`;
      const message = `${app.notification_message} · NASA POWER estimate for ${app.location_label}: ${detail} (${valueDate.slice(0, 4)}-${valueDate.slice(4, 6)}-${valueDate.slice(6, 8)}). Not an official warning.`;
      let sent = 0;
      let failed = 0;

      for (const subscription of subscriptions || []) {
        if (!trustedPushEndpoint(subscription.endpoint)) {
          failed += 1;
          console.error(`Rejected an unsupported push endpoint for Guardian app ${app.id}.`);
          continue;
        }
        try {
          await webpush.sendNotification({
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          }, JSON.stringify({
            title: app.name,
            body: message.slice(0, 1200),
            tag: `guardian-${app.id}-${valueDate}`,
            url: './index.html#guardian',
          }));
          sent += 1;
        } catch (error) {
          const statusCode = Number((error as { statusCode?: number }).statusCode);
          if (statusCode === 404 || statusCode === 410) {
            const { error: deleteError } = await supabase.from('guardian_app_subscriptions')
              .delete().eq('id', subscription.id);
            if (deleteError) console.error(`Could not remove expired push subscription ${subscription.id}: ${deleteError.message}`);
          } else {
            console.error(`Push delivery failed for Guardian app ${app.id}: ${error instanceof Error ? error.message : 'unknown provider error'}`);
          }
          failed += 1;
        }
      }
      processed.push({ id: app.id, status: 'threshold_crossed', notifications_sent: sent, notifications_failed: failed });
    } catch (error) {
      console.error(`Guardian app ${app.id} could not be checked: ${error instanceof Error ? error.message : 'unknown error'}`);
      processed.push({ id: app.id, status: 'check_failed' });
    }
  }

  return jsonResponse({ checked: processed.length, results: processed });
});
