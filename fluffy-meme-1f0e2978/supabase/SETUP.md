# Fieldnotes community setup

The original Fieldnotes page stays usable without an account. Google sign-in, public community cases, research posts, private field notes, and Gemini features require a Supabase project. New community cases use NASA Worldview imagery for their coordinates; the image is geographic context, not evidence that a claim is true.

1. Create a Supabase project and run `schema.sql` in its SQL Editor.
2. In Authentication, enable Google and configure the Google OAuth client. Add the Supabase callback URL shown by the provider setup, then add the deployed Fieldnotes URL to Supabase's allowed redirect URLs.
3. Copy the project URL and the public anon/publishable key into `supabase-config.js`. Never put a Supabase service-role key or Gemini API key in that file or the browser.
4. Install and log in to the Supabase CLI, then deploy `functions/draft-case`, `functions/community-summary`, and `functions/draft-guardian-app`.
5. Add `GEMINI_API_KEY` as a Supabase Edge Function secret. Optionally set `GEMINI_MODEL`; otherwise the functions use `gemini-2.5-flash`.
6. Publish the original Fieldnotes files over HTTPS. Test Google sign-in, private drafts, public publishing, and row-level access before inviting users. The page loads the Supabase browser SDK from jsDelivr, so community features also require that CDN to be reachable.

## Guardian monitor notifications

Guardian monitors are not active until the database schema, browser push settings, and scheduled check are all configured. Alerts are opt-in, informational only, and may be late or blocked; they are not emergency warnings.

1. Run the current `schema.sql` so the `guardian_apps` and `guardian_app_subscriptions` tables and their row-level security policies exist.
2. Generate a VAPID key pair with a trusted `web-push` installation. Put only its **public** key in `webPushVapidPublicKey` in `supabase-config.js`. Keep the private key secret.
3. Add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a contact such as `mailto:admin@example.org`) to the Supabase Edge Function secrets. Confirm that `SUPABASE_SERVICE_ROLE_KEY` is available to the scheduled function; never put it in `supabase-config.js`.
4. Deploy `functions/check-guardian-apps`. Schedule it to POST `{}` to `/functions/v1/check-guardian-apps` once per day, using the service-role key as the Bearer token. Store the URL and key in Supabase Vault or another server-side secret store; do not paste them into public SQL, this repository, or browser code. The function refuses requests without that exact server-side authorization.
5. Publish over HTTPS, sign in, create a monitor, and explicitly subscribe a test device. Verify that `last_checked_at` updates and that only subscribed devices receive notifications before inviting a community.

The monitor reads NASA POWER daily modeled weather data, typically delayed by 2–3 days. A low-rainfall monitor requires seven valid daily precipitation estimates and sums them; it does not measure water supply. Air quality is deliberately unsupported because these measures are not AQI or pollutant data. Until the schedule and secrets are configured, the site can save monitors but cannot send automatic notifications.

AI case drafts are suggestions that people must review before saving or publishing. A research post is sent to Gemini only when its author explicitly opts in to community summaries; a summary requires at least three eligible public posts. The summary describes reported patterns; it does not train a model, average unlike measurements or p-values, or establish scientific consensus. Community cases and findings are public once published, so authors should not include private or personal information.
