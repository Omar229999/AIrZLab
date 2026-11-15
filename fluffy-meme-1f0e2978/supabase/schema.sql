create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Earth researcher',
  avatar_url text,
  created_at timestamptz not null default now()
);

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), nullif(new.raw_user_meta_data ->> 'name', ''), 'Earth researcher'),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_profile_after_signup on auth.users;
create trigger create_profile_after_signup
after insert on auth.users
for each row execute procedure public.create_profile_for_new_user();

create table if not exists public.community_cases (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 4 and 100),
  location_label text not null check (char_length(location_label) between 2 and 140),
  summary text not null check (char_length(summary) between 20 and 700),
  research_question text not null check (char_length(research_question) between 10 and 300),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  source_suggestions jsonb not null default '[]'::jsonb check (jsonb_typeof(source_suggestions) = 'array'),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists public.private_case_notes (
  id uuid primary key default gen_random_uuid(),
  case_ref text not null check (char_length(case_ref) between 1 and 100),
  author_id uuid not null references public.profiles (id) on delete cascade,
  note text not null check (char_length(note) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table if not exists public.research_posts (
  id uuid primary key default gen_random_uuid(),
  case_ref text not null check (char_length(case_ref) between 1 and 100),
  author_id uuid not null references public.profiles (id) on delete cascade,
  author_name text not null default 'Earth researcher' check (char_length(author_name) between 1 and 80),
  title text not null check (char_length(title) between 4 and 140),
  finding text not null check (char_length(finding) between 20 and 3000),
  method text not null default '' check (char_length(method) <= 500),
  variable_name text not null default '' check (char_length(variable_name) <= 120),
  unit text not null default '' check (char_length(unit) <= 40),
  location_label text not null default '' check (char_length(location_label) <= 140),
  period_label text not null default '' check (char_length(period_label) <= 120),
  p_value numeric check (p_value between 0 and 1),
  result_direction text not null default 'descriptive_only'
    check (result_direction in ('increase', 'decrease', 'no_clear_difference', 'descriptive_only')),
  citation_urls jsonb not null default '[]'::jsonb check (jsonb_typeof(citation_urls) = 'array'),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  include_in_summary boolean not null default false,
  created_at timestamptz not null default now(),
  check (not include_in_summary or visibility = 'public')
);

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  content_type text not null check (content_type in ('case', 'research_post')),
  content_id uuid not null,
  reason text not null check (char_length(reason) between 4 and 500),
  created_at timestamptz not null default now()
);

create table if not exists public.guardian_apps (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 4 and 100),
  summary text not null check (char_length(summary) between 20 and 700),
  notification_message text not null check (char_length(notification_message) between 20 and 500),
  hazard text not null check (hazard in ('heat', 'water', 'custom')),
  location_label text not null check (char_length(location_label) between 2 and 140),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  parameter text not null check (parameter in ('T2M_MAX', 'PRECTOTCORR', 'RH2M', 'WS2M')),
  threshold_operator text not null check (threshold_operator in ('above', 'below')),
  threshold_value double precision not null check (abs(threshold_value) < 10000),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  active boolean not null default true,
  last_data_date date,
  last_checked_at timestamptz,
  last_alerted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.guardian_app_subscriptions (
  id uuid primary key default gen_random_uuid(),
  guardian_app_id uuid not null references public.guardian_apps (id) on delete cascade,
  subscriber_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  unique (guardian_app_id, subscriber_id, endpoint)
);

alter table public.profiles enable row level security;
alter table public.community_cases enable row level security;
alter table public.private_case_notes enable row level security;
alter table public.research_posts enable row level security;
alter table public.content_reports enable row level security;
alter table public.guardian_apps enable row level security;
alter table public.guardian_app_subscriptions enable row level security;

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
on public.profiles for select
using (true);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
on public.profiles for update
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "Public cases or owned cases are readable" on public.community_cases;
create policy "Public cases or owned cases are readable"
on public.community_cases for select
using (visibility = 'public' or auth.uid() = author_id);

drop policy if exists "Users can create their own cases" on public.community_cases;
create policy "Users can create their own cases"
on public.community_cases for insert
with check (auth.uid() = author_id);

drop policy if exists "Users can update their own cases" on public.community_cases;
create policy "Users can update their own cases"
on public.community_cases for update
using (auth.uid() = author_id)
with check (auth.uid() = author_id);

drop policy if exists "Users can delete their own cases" on public.community_cases;
create policy "Users can delete their own cases"
on public.community_cases for delete
using (auth.uid() = author_id);

drop policy if exists "Users can read their own private notes" on public.private_case_notes;
create policy "Users can read their own private notes"
on public.private_case_notes for select
using (auth.uid() = author_id);

drop policy if exists "Users can create their own private notes" on public.private_case_notes;
create policy "Users can create their own private notes"
on public.private_case_notes for insert
with check (auth.uid() = author_id);

drop policy if exists "Users can update their own private notes" on public.private_case_notes;
create policy "Users can update their own private notes"
on public.private_case_notes for update
using (auth.uid() = author_id)
with check (auth.uid() = author_id);

drop policy if exists "Users can delete their own private notes" on public.private_case_notes;
create policy "Users can delete their own private notes"
on public.private_case_notes for delete
using (auth.uid() = author_id);

drop policy if exists "Public posts or owned posts are readable" on public.research_posts;
create policy "Public posts or owned posts are readable"
on public.research_posts for select
using (visibility = 'public' or auth.uid() = author_id);

drop policy if exists "Users can create their own research posts" on public.research_posts;
create policy "Users can create their own research posts"
on public.research_posts for insert
with check (
  auth.uid() = author_id
  and (
    case_ref like 'builtin:%'
    or exists (
      select 1
      from public.community_cases as cases
      where cases.id::text = case_ref
        and cases.visibility = 'public'
    )
  )
);

drop policy if exists "Users can update their own research posts" on public.research_posts;
create policy "Users can update their own research posts"
on public.research_posts for update
using (auth.uid() = author_id)
with check (
  auth.uid() = author_id
  and (
    case_ref like 'builtin:%'
    or exists (
      select 1
      from public.community_cases as cases
      where cases.id::text = case_ref
        and cases.visibility = 'public'
    )
  )
);

drop policy if exists "Users can delete their own research posts" on public.research_posts;
create policy "Users can delete their own research posts"
on public.research_posts for delete
using (auth.uid() = author_id);

drop policy if exists "Users can file content reports" on public.content_reports;
create policy "Users can file content reports"
on public.content_reports for insert
with check (auth.uid() = reporter_id);

drop policy if exists "Users can view their own content reports" on public.content_reports;
create policy "Users can view their own content reports"
on public.content_reports for select
using (auth.uid() = reporter_id);

drop policy if exists "Public or owned Guardian apps are readable" on public.guardian_apps;
create policy "Public or owned Guardian apps are readable"
on public.guardian_apps for select
using ((visibility = 'public' and active) or auth.uid() = creator_id);

drop policy if exists "Users can create their own Guardian apps" on public.guardian_apps;
create policy "Users can create their own Guardian apps"
on public.guardian_apps for insert
with check (auth.uid() = creator_id);

drop policy if exists "Users can update their own Guardian apps" on public.guardian_apps;
create policy "Users can update their own Guardian apps"
on public.guardian_apps for update
using (auth.uid() = creator_id)
with check (auth.uid() = creator_id);

drop policy if exists "Users can delete their own Guardian apps" on public.guardian_apps;
create policy "Users can delete their own Guardian apps"
on public.guardian_apps for delete
using (auth.uid() = creator_id);

drop policy if exists "Users can view their own Guardian subscriptions" on public.guardian_app_subscriptions;
create policy "Users can view their own Guardian subscriptions"
on public.guardian_app_subscriptions for select
using (auth.uid() = subscriber_id);

drop policy if exists "Users can subscribe to a public Guardian app" on public.guardian_app_subscriptions;
create policy "Users can subscribe to a public Guardian app"
on public.guardian_app_subscriptions for insert
with check (
  auth.uid() = subscriber_id
  and exists (
    select 1
    from public.guardian_apps as apps
    where apps.id = guardian_app_id
      and apps.active
      and (apps.visibility = 'public' or apps.creator_id = auth.uid())
  )
);

drop policy if exists "Users can remove their own Guardian subscriptions" on public.guardian_app_subscriptions;
create policy "Users can remove their own Guardian subscriptions"
on public.guardian_app_subscriptions for delete
using (auth.uid() = subscriber_id);

create or replace view public.community_research_rollup
with (security_invoker = true)
as
select
  case_ref,
  variable_name,
  unit,
  location_label,
  result_direction,
  count(*)::integer as contribution_count
from public.research_posts
where visibility = 'public'
  and include_in_summary = true
  and variable_name <> ''
group by case_ref, variable_name, unit, location_label, result_direction;

grant select on public.profiles to anon, authenticated;
grant select on public.community_cases to anon, authenticated;
grant insert, update, delete on public.community_cases to authenticated;
grant select, insert, update, delete on public.private_case_notes to authenticated;
grant select on public.research_posts to anon, authenticated;
grant insert, update, delete on public.research_posts to authenticated;
grant insert, select on public.content_reports to authenticated;
grant select on public.community_research_rollup to anon, authenticated;
grant select on public.guardian_apps to anon, authenticated;
grant insert, update, delete on public.guardian_apps to authenticated;
grant select, insert, delete on public.guardian_app_subscriptions to authenticated;
