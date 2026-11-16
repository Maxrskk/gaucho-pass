-- Gaucho Pass: tables, Row Level Security, and server functions.
--
-- Safe to run more than once. Works with these project settings:
--   Data API on, "Automatically expose new tables" off, automatic RLS on.
-- Every table and function the app uses gets an explicit grant below.
--
-- Rule of thumb for reading this file:
--   * Clients can never insert, update or delete a row directly.
--   * Clients can read only what the RLS policies in section 2 allow.
--   * Every change goes through a function in section 4 or 5, which checks
--     who is calling before it does anything.

create extension if not exists pgcrypto with schema extensions;

-- Private schema for helper functions. It is not exposed through the Data API.
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- =====================================================================
-- 1. Tables
-- =====================================================================

create table if not exists public.locations (
  id text primary key check (id ~ '^[a-z0-9_-]{1,32}$'),
  name text not null,
  short_name text not null,
  type text not null check (type in ('dining', 'rec', 'bus', 'library')),
  sort integer not null default 0
);

-- One row per login, with its role.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('student', 'scanner', 'admin')),
  display_name text not null check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);

-- The ID card.
create table if not exists public.students (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  perm text not null unique check (perm ~ '^[0-9]{7}$'),
  first_name text not null,
  last_name text not null,
  year text not null,
  major text not null,
  avatar text not null check (avatar ~ '^[a-z0-9-]{1,32}$'),
  status text not null default 'active' check (status in ('active', 'lost')),
  lost_by text check (lost_by in ('self', 'admin')),
  status_changed_at timestamptz not null default now(),
  access text[] not null default '{}',
  meal_plan text,                    -- null = no meal plan
  swipes_per_week integer check (swipes_per_week is null or swipes_per_week between 0 and 50), -- null = unlimited
  swipes_left integer check (swipes_left is null or swipes_left >= 0),
  swipes_week date                   -- the Monday the count was last refilled
);

-- TOTP secrets. No client can read this table: RLS is on and there is no policy.
create table if not exists public.student_secrets (
  user_id uuid primary key references public.students (user_id) on delete cascade,
  secret bytea not null check (octet_length(secret) = 20),
  previous_secret bytea check (previous_secret is null or octet_length(previous_secret) = 20),
  version integer not null default 1,
  rotated_at timestamptz not null default now(),
  -- Sign-ins older than this are blocked (set when the phone is reported lost) ...
  sessions_valid_from timestamptz not null default '-infinity',
  -- ... except the one session that made the report.
  trusted_session uuid
);

create table if not exists public.guest_passes (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.students (user_id) on delete cascade,
  guest_name text not null check (char_length(guest_name) between 1 and 40),
  location_type text not null check (location_type in ('dining', 'rec', 'library')),
  token_hash bytea not null unique,  -- SHA-256 of the token; the token itself is never stored
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_scan_id bigint,
  revoked_at timestamptz,
  is_test boolean not null default false
);
create index if not exists guest_passes_host_idx on public.guest_passes (host_id, created_at desc);

-- Every scan attempt, granted or denied.
create table if not exists public.scans (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  scanner_id uuid not null references public.profiles (user_id) on delete cascade,
  location_id text not null references public.locations (id),
  kind text not null check (kind in ('student', 'guest', 'unknown')),
  student_id uuid references public.students (user_id) on delete set null, -- set only when the code proved who it was
  claimed_perm text check (claimed_perm is null or claimed_perm ~ '^[0-9]{7}$'),
  guest_pass_id uuid references public.guest_passes (id) on delete set null,
  result text not null check (result in ('granted', 'denied')),
  reason text not null check (reason ~ '^[a-z_]{2,40}$'),
  time_window bigint,
  shown_ms integer check (shown_ms is null or shown_ms >= 0),               -- ID shown on the phone -> answer
  verify_ms integer check (verify_ms is null or verify_ms between 0 and 60000), -- QR read by the scanner -> answer
  is_test boolean not null default false
);
create index if not exists scans_scanner_idx on public.scans (scanner_id, id desc);
create index if not exists scans_location_idx on public.scans (location_id, result);

-- One-time use. A code is one (student, 30-second window) pair, and the unique
-- constraint means it can be accepted once, by one scanner, ever.
create table if not exists public.used_codes (
  student_id uuid not null references public.students (user_id) on delete cascade,
  time_window bigint not null,
  scan_id bigint references public.scans (id) on delete set null,
  used_at timestamptz not null default now(),
  constraint one_use_per_code unique (student_id, time_window)
);

create table if not exists public.card_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  student_id uuid not null references public.students (user_id) on delete cascade,
  actor_id uuid references public.profiles (user_id) on delete set null,
  action text not null check (action in ('report_lost', 'reactivate', 'admin_deactivate', 'admin_reactivate'))
);

create table if not exists public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  demo_tools boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

-- =====================================================================
-- 2. Row Level Security and grants
-- =====================================================================

alter table public.locations enable row level security;
alter table public.profiles enable row level security;
alter table public.students enable row level security;
alter table public.student_secrets enable row level security;
alter table public.guest_passes enable row level security;
alter table public.scans enable row level security;
alter table public.used_codes enable row level security;
alter table public.card_events enable row level security;
alter table public.rate_limits enable row level security;
alter table public.app_settings enable row level security;

-- Start from nothing, then grant read access only where a policy exists.
revoke all on table
  public.locations, public.profiles, public.students, public.student_secrets, public.guest_passes,
  public.scans, public.used_codes, public.card_events, public.rate_limits, public.app_settings
from anon, authenticated;

grant select on table
  public.locations, public.profiles, public.students, public.scans, public.card_events, public.app_settings
to authenticated;
-- Everything except token_hash.
grant select (id, host_id, guest_name, location_type, created_at, expires_at, used_at, revoked_at, is_test)
  on table public.guest_passes to authenticated;
-- student_secrets, used_codes, rate_limits: no grant, no policy. Nobody reads them directly.

-- The caller's role. SECURITY DEFINER so the policies below can use it
-- without the profiles policy calling itself.
create or replace function app.my_role() returns text
language sql stable security definer set search_path = ''
as $$ select role from public.profiles where user_id = (select auth.uid()) $$;

revoke all on function app.my_role() from public;
grant execute on function app.my_role() to authenticated, service_role;

drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations for select to authenticated using (true);

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to authenticated using (true);

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or (select app.my_role()) = 'admin');

drop policy if exists students_read on public.students;
create policy students_read on public.students for select to authenticated
  using (user_id = (select auth.uid()) or (select app.my_role()) = 'admin');

drop policy if exists scans_read on public.scans;
create policy scans_read on public.scans for select to authenticated
  using (scanner_id = (select auth.uid()) or (select app.my_role()) = 'admin');

drop policy if exists guest_passes_read on public.guest_passes;
create policy guest_passes_read on public.guest_passes for select to authenticated
  using (host_id = (select auth.uid()) or (select app.my_role()) = 'admin');

drop policy if exists card_events_read on public.card_events;
create policy card_events_read on public.card_events for select to authenticated
  using (student_id = (select auth.uid()) or (select app.my_role()) = 'admin');

-- =====================================================================
-- 3. Private helpers (schema app)
-- =====================================================================

create or replace function app.now_ms() returns bigint
language sql volatile set search_path = ''
as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- Meal weeks start on Monday, Santa Barbara time.
create or replace function app.current_week() returns date
language sql stable set search_path = ''
as $$ select date_trunc('week', now() at time zone 'America/Los_Angeles')::date $$;

-- Stops with a short error code unless the caller has one of the given roles.
create or replace function app.require_role(variadic p_allowed text[]) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in';
  end if;
  select role into v_role from public.profiles where user_id = auth.uid();
  if v_role is null or not (v_role = any (p_allowed)) then
    raise exception 'wrong_role';
  end if;
  return v_role;
end $$;

create or replace function app.session_id() returns uuid
language plpgsql stable set search_path = ''
as $$
declare
  v text := auth.jwt() ->> 'session_id';
begin
  if v is null or v = '' then
    return null;
  end if;
  return v::uuid;
exception when others then
  return null;
end $$;

-- When the caller's current sign-in started. Null if that session was signed out.
create or replace function app.session_started() returns timestamptz
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_sid uuid := app.session_id();
  v_started timestamptz;
begin
  if v_sid is null or auth.uid() is null then
    return null;
  end if;
  begin
    select created_at into v_started from auth.sessions where id = v_sid and user_id = auth.uid();
    return v_started;
  exception when insufficient_privilege or undefined_table or undefined_column then
    -- Fallback: the sign-in time recorded inside the token itself.
    raise warning 'gaucho pass: auth.sessions is not readable, using token sign-in time';
    select to_timestamp(min((e ->> 'timestamp')::double precision)) into v_started
      from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) e
     where jsonb_typeof(e) = 'object' and e ->> 'method' is distinct from 'token_refresh';
    return v_started;
  end;
end $$;

-- Is this sign-in still allowed to act for the student? After "Report lost",
-- only the reporting session and later sign-ins are.
create or replace function app.session_trusted(p_user uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_started timestamptz := app.session_started();
  v_valid_from timestamptz;
  v_trusted uuid;
begin
  if v_started is null then
    return false;
  end if;
  select sessions_valid_from, trusted_session into v_valid_from, v_trusted
    from public.student_secrets where user_id = p_user;
  if not found then
    return false;
  end if;
  return coalesce(app.session_id() = v_trusted, false)
      or coalesce(v_started >= v_valid_from - interval '2 seconds', false);
end $$;

-- Refill a counted meal plan when a new week has started.
create or replace function app.refresh_swipes(p_user uuid) returns void
language sql volatile set search_path = ''
as $$
  update public.students
     set swipes_left = swipes_per_week, swipes_week = app.current_week()
   where user_id = p_user
     and swipes_per_week is not null
     and (swipes_week is null or swipes_week < app.current_week());
$$;

create or replace function app.rate_limit_hit(p_key text, p_window_seconds integer) returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;
  return v_count;
end $$;

create or replace function app.student_card(p_user uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'perm', s.perm, 'first_name', s.first_name, 'last_name', s.last_name,
    'year', s.year, 'major', s.major, 'avatar', s.avatar,
    'status', s.status, 'lost_by', s.lost_by, 'status_changed_at', s.status_changed_at,
    'access', to_jsonb(s.access),
    'meal_plan', s.meal_plan, 'swipes_per_week', s.swipes_per_week, 'swipes_left', s.swipes_left)
  from public.students s where s.user_id = p_user
$$;

create or replace function app.guest_passes_json(p_host uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id, 'guest_name', g.guest_name, 'location_type', g.location_type,
      'created_at', g.created_at, 'expires_at', g.expires_at, 'used_at', g.used_at, 'revoked_at', g.revoked_at,
      'state', case when g.revoked_at is not null then 'revoked'
                    when g.used_at is not null then 'used'
                    when g.expires_at <= now() then 'expired'
                    else 'active' end
    ) order by g.created_at desc), '[]'::jsonb)
  from (
    select * from public.guest_passes
     where host_id = p_host and not is_test and created_at > now() - interval '24 hours'
     order by created_at desc limit 10
  ) g
$$;

-- Recent scans as JSON, newest first. p_scanner null = every scanner.
create or replace function app.scan_feed(p_scanner uuid, p_limit integer) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(t.row_json order by t.id desc), '[]'::jsonb)
  from (
    select s.id, jsonb_build_object(
      'id', s.id, 'at', s.created_at, 'result', s.result, 'reason', s.reason, 'kind', s.kind, 'is_test', s.is_test,
      'location', l.short_name, 'location_id', s.location_id, 'scanner', p.display_name,
      'name', case when s.kind = 'guest' then g.guest_name
                   when st.user_id is not null then st.first_name || ' ' || st.last_name end,
      'host', case when s.kind = 'guest' and h.user_id is not null then h.first_name || ' ' || h.last_name end,
      'perm', st.perm, 'claimed_perm', s.claimed_perm, 'avatar', st.avatar,
      'shown_ms', s.shown_ms, 'verify_ms', s.verify_ms) as row_json
    from public.scans s
    left join public.locations l on l.id = s.location_id
    left join public.profiles p on p.user_id = s.scanner_id
    left join public.students st on st.user_id = s.student_id
    left join public.guest_passes g on g.id = s.guest_pass_id
    left join public.students h on h.user_id = g.host_id
    where p_scanner is null or s.scanner_id = p_scanner
    order by s.id desc
    limit least(greatest(coalesce(p_limit, 25), 1), 200)
  ) t
$$;

-- Deactivate a card: used by "Report lost" and by the admin.
--   * the status becomes lost
--   * a new secret is generated; the old one is kept only to recognise the old phone
--   * every other sign-in is blocked (and signed out where Supabase allows it)
--   * the student's unused guest passes are revoked
create or replace function app.deactivate_card(p_student uuid, p_actor uuid, p_keep_session uuid, p_by text) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_was text;
  v_by text;
begin
  select status, lost_by into v_was, v_by from public.students where user_id = p_student for update;
  if not found then
    raise exception 'no_student';
  end if;

  update public.students
     set status = 'lost',
         lost_by = case when v_was = 'lost' and v_by = 'admin' then 'admin' else p_by end,
         status_changed_at = now()
   where user_id = p_student;

  if v_was = 'active' then
    update public.student_secrets
       set previous_secret = secret,
           secret = extensions.gen_random_bytes(20),
           version = version + 1,
           rotated_at = now(),
           sessions_valid_from = now(),
           trusted_session = p_keep_session
     where user_id = p_student;
  else
    -- Already lost: the current secret was never handed out, so keep it. Just re-block devices.
    update public.student_secrets
       set sessions_valid_from = now(), trusted_session = p_keep_session
     where user_id = p_student;
  end if;

  update public.guest_passes set revoked_at = now()
   where host_id = p_student and used_at is null and revoked_at is null and expires_at > now();

  insert into public.card_events (student_id, actor_id, action)
  values (p_student, p_actor, case when p_by = 'admin' then 'admin_deactivate' else 'report_lost' end);

  -- Best effort: really sign the other devices out. If this project doesn't allow it,
  -- session_trusted() above still blocks them.
  begin
    delete from auth.sessions
     where user_id = p_student and (p_keep_session is null or id <> p_keep_session);
  exception when others then
    null;
  end;
end $$;

revoke all on all functions in schema app from public, anon, authenticated;
grant execute on function app.my_role() to authenticated, service_role;

-- =====================================================================
-- 4. Functions the app calls (signed-in users only)
-- =====================================================================

-- Who am I, and what does my role need to start?
create or replace function public.bootstrap() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in';
  end if;
  select * into p from public.profiles where user_id = auth.uid();
  if not found then
    raise exception 'no_profile';
  end if;
  return jsonb_build_object(
    'user_id', p.user_id, 'role', p.role, 'display_name', p.display_name,
    'server_now', app.now_ms(),
    'demo_tools', coalesce((select demo_tools from public.app_settings where id), false),
    'locations', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', l.id, 'name', l.name, 'short_name', l.short_name, 'type', l.type) order by l.sort), '[]'::jsonb)
                    from public.locations l));
end $$;

-- STUDENT: my own card, my own secret (only while the card is active), server time.
create or replace function public.get_my_pass() returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sec public.student_secrets%rowtype;
  v_card jsonb;
begin
  perform app.require_role('student');
  if app.session_trusted(v_uid) is not true then
    return jsonb_build_object('device_blocked', true, 'server_now', app.now_ms());
  end if;
  perform app.refresh_swipes(v_uid);
  v_card := app.student_card(v_uid);
  select * into v_sec from public.student_secrets where user_id = v_uid;
  if v_card is null or not found then
    raise exception 'no_student';
  end if;
  return jsonb_build_object(
    'device_blocked', false,
    'server_now', app.now_ms(),
    'student', v_card,
    'secret', case when v_card ->> 'status' = 'active' then encode(v_sec.secret, 'hex') end,
    'secret_version', v_sec.version,
    'guest_passes', app.guest_passes_json(v_uid));
end $$;

-- STUDENT: report my phone lost. Works from any device I am signed in on.
create or replace function public.report_lost() returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  perform app.require_role('student');
  if app.session_trusted(v_uid) is not true then
    raise exception 'device_blocked';
  end if;
  if app.rate_limit_hit('card:' || v_uid::text, 3600) > 20 then
    raise exception 'rate_limited';
  end if;
  perform app.deactivate_card(v_uid, v_uid, app.session_id(), 'self');
  return public.get_my_pass();
end $$;

-- STUDENT: reactivate after a self-report. A card the admin deactivated stays off.
create or replace function public.reactivate_card() returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_by text;
begin
  perform app.require_role('student');
  if app.session_trusted(v_uid) is not true then
    raise exception 'device_blocked';
  end if;
  select status, lost_by into v_status, v_by from public.students where user_id = v_uid for update;
  if not found then
    raise exception 'no_student';
  end if;
  if v_status = 'lost' then
    if v_by = 'admin' then
      raise exception 'admin_locked';
    end if;
    if app.rate_limit_hit('card:' || v_uid::text, 3600) > 20 then
      raise exception 'rate_limited';
    end if;
    update public.students set status = 'active', lost_by = null, status_changed_at = now() where user_id = v_uid;
    insert into public.card_events (student_id, actor_id, action) values (v_uid, v_uid, 'reactivate');
  end if;
  return public.get_my_pass();
end $$;

-- STUDENT: make a guest pass. Valid for one scan or one hour, whichever comes first.
create or replace function public.create_guest_pass(p_guest_name text, p_location_type text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_guest_name, ''));
  s public.students%rowtype;
  v_token text;
  v_id uuid;
  v_expires timestamptz;
  v_active integer;
  v_today integer;
begin
  perform app.require_role('student');
  if app.session_trusted(v_uid) is not true then
    raise exception 'device_blocked';
  end if;
  if v_name !~ '^[[:alnum:] .''-]{1,40}$' then
    raise exception 'bad_guest_name';
  end if;
  if p_location_type is null or p_location_type not in ('dining', 'rec', 'library') then
    raise exception 'bad_location_type';
  end if;

  perform app.refresh_swipes(v_uid);
  select * into s from public.students where user_id = v_uid for update;
  if not found then
    raise exception 'no_student';
  end if;
  if s.status <> 'active' then
    raise exception 'card_lost';
  end if;
  if not (p_location_type = any (s.access)) then
    raise exception 'no_access';
  end if;
  if p_location_type = 'dining' then
    if s.meal_plan is null then
      raise exception 'no_meal_plan';
    end if;
    if s.swipes_per_week is not null and coalesce(s.swipes_left, 0) <= 0 then
      raise exception 'no_swipes';
    end if;
  end if;

  select count(*) into v_active from public.guest_passes
   where host_id = v_uid and not is_test and used_at is null and revoked_at is null and expires_at > now();
  if v_active >= 2 then
    raise exception 'too_many_active';
  end if;
  select count(*) into v_today from public.guest_passes
   where host_id = v_uid and not is_test and created_at > now() - interval '24 hours';
  if v_today >= 6 then
    raise exception 'daily_limit';
  end if;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  insert into public.guest_passes (host_id, guest_name, location_type, token_hash, expires_at)
  values (v_uid, v_name, p_location_type, extensions.digest(v_token, 'sha256'), now() + interval '1 hour')
  returning id, expires_at into v_id, v_expires;

  return jsonb_build_object(
    'id', v_id, 'token', v_token, 'guest_name', v_name, 'location_type', p_location_type,
    'expires_at', v_expires, 'host_first_name', s.first_name);
end $$;

create or replace function public.revoke_guest_pass(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  perform app.require_role('student');
  if app.session_trusted(v_uid) is not true then
    raise exception 'device_blocked';
  end if;
  update public.guest_passes set revoked_at = now()
   where id = p_id and host_id = v_uid and used_at is null and revoked_at is null;
  return public.get_my_pass();
end $$;

-- SCANNER: my own recent scans, with the names the scanner was already shown.
create or replace function public.my_recent_scans(p_limit integer default 25) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.require_role('scanner', 'admin');
  return app.scan_feed(auth.uid(), least(coalesce(p_limit, 25), 100));
end $$;

-- SCANNER: how long the scanner took from reading the QR to showing the answer.
create or replace function public.log_scan_timing(p_scan_id bigint, p_verify_ms integer) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform app.require_role('scanner', 'admin');
  if p_scan_id is null or p_verify_ms is null or p_verify_ms < 0 or p_verify_ms > 60000 then
    return;
  end if;
  update public.scans set verify_ms = p_verify_ms
   where id = p_scan_id and scanner_id = auth.uid() and verify_ms is null
     and created_at > now() - interval '5 minutes';
end $$;

-- ADMIN: everything the dashboard shows, in one call.
create or replace function public.admin_overview(p_limit integer default 60) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.require_role('admin');
  return jsonb_build_object(
    'server_now', app.now_ms(),
    'demo_tools', coalesce((select demo_tools from public.app_settings where id), false),
    'feed', app.scan_feed(null, p_limit),
    'students', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', s.user_id, 'perm', s.perm, 'name', s.first_name || ' ' || s.last_name, 'avatar', s.avatar,
        'status', s.status, 'lost_by', s.lost_by, 'meal_plan', s.meal_plan, 'swipes_per_week', s.swipes_per_week,
        'swipes_left', case when s.swipes_per_week is not null and (s.swipes_week is null or s.swipes_week < app.current_week())
                            then s.swipes_per_week else s.swipes_left end
      ) order by s.last_name, s.first_name), '[]'::jsonb)
      from public.students s),
    'locations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.short_name,
        'granted', (select count(*) from public.scans s where s.location_id = l.id and s.result = 'granted'),
        'denied', (select count(*) from public.scans s where s.location_id = l.id and s.result = 'denied')
      ) order by l.sort), '[]'::jsonb)
      from public.locations l),
    'reasons', (
      select coalesce(jsonb_object_agg(r.reason, r.n), '{}'::jsonb)
      from (select reason, count(*) as n from public.scans where result = 'denied' group by reason) r),
    'totals', (
      select jsonb_build_object(
        'granted', count(*) filter (where result = 'granted'),
        'denied', count(*) filter (where result = 'denied'))
      from public.scans),
    -- Real (non-test) granted scans only. "Shown" times over 2 minutes are left out:
    -- that is someone waiting in line with their ID already open.
    'speed', (
      select jsonb_build_object(
        'shown_n', count(shown_ms) filter (where shown_ms <= 120000),
        'shown_median', percentile_cont(0.5) within group (order by shown_ms) filter (where shown_ms <= 120000),
        'shown_p90', percentile_cont(0.9) within group (order by shown_ms) filter (where shown_ms <= 120000),
        'verify_n', count(verify_ms),
        'verify_median', percentile_cont(0.5) within group (order by verify_ms),
        'verify_p90', percentile_cont(0.9) within group (order by verify_ms))
      from public.scans where result = 'granted' and not is_test));
end $$;

-- ADMIN: deactivate or reactivate any student's card.
create or replace function public.admin_set_card_status(p_student uuid, p_status text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_status text;
begin
  perform app.require_role('admin');
  if p_status is null or p_status not in ('active', 'lost') then
    raise exception 'bad_status';
  end if;
  select status into v_status from public.students where user_id = p_student for update;
  if not found then
    raise exception 'no_student';
  end if;
  if p_status = 'lost' then
    perform app.deactivate_card(p_student, auth.uid(), null, 'admin');
  elsif v_status = 'lost' then
    update public.students set status = 'active', lost_by = null, status_changed_at = now() where user_id = p_student;
    insert into public.card_events (student_id, actor_id, action) values (p_student, auth.uid(), 'admin_reactivate');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ADMIN: turn the demo tools (one-tap security tests) on or off.
create or replace function public.admin_set_demo_tools(p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform app.require_role('admin');
  update public.app_settings set demo_tools = coalesce(p_on, false), updated_at = now() where id;
  return jsonb_build_object('ok', true, 'demo_tools', coalesce(p_on, false));
end $$;

-- =====================================================================
-- 5. Functions only the Edge Functions may call (service role)
-- =====================================================================

-- Step 1 of a scan: check the scanner, count it against the rate limit, and
-- load what the decision needs. Secrets leave the database only to the Edge Function.
create or replace function public.scan_prepare(
  p_scanner uuid, p_location text, p_kind text, p_perm text, p_token_hash text
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_role text;
  v_count integer;
  v_loc jsonb;
  v_student jsonb;
  v_guest jsonb;
  v_bad integer;
  s public.students%rowtype;
  sec public.student_secrets%rowtype;
  g public.guest_passes%rowtype;
  h public.students%rowtype;
begin
  select role into v_role from public.profiles where user_id = p_scanner;
  if v_role is null or v_role not in ('scanner', 'admin') then
    return jsonb_build_object('error', 'wrong_role');
  end if;

  -- 30 scans per minute per scanner account.
  v_count := app.rate_limit_hit('scan:' || p_scanner::text, 60);
  if v_count > 30 then
    return jsonb_build_object(
      'error', 'rate_limited',
      'retry_after', 60 - (floor(extract(epoch from clock_timestamp()))::bigint % 60));
  end if;
  if random() < 0.02 then
    delete from public.rate_limits where window_start < now() - interval '1 hour';
  end if;

  select jsonb_build_object('id', l.id, 'name', l.name, 'short_name', l.short_name, 'type', l.type)
    into v_loc from public.locations l where l.id = p_location;
  if v_loc is null then
    return jsonb_build_object('error', 'unknown_location');
  end if;

  if p_kind = 'student' and p_perm is not null then
    select * into s from public.students where perm = p_perm;
    if found then
      perform app.refresh_swipes(s.user_id);
      select * into s from public.students where user_id = s.user_id;
      select * into sec from public.student_secrets where user_id = s.user_id;
      select coalesce(sum(r.count), 0) into v_bad from public.rate_limits r
       where r.key = 'bad:' || s.user_id::text and r.window_start > now() - interval '5 minutes';
      v_student := jsonb_build_object(
        'user_id', s.user_id, 'perm', s.perm, 'first_name', s.first_name, 'last_name', s.last_name,
        'year', s.year, 'major', s.major, 'avatar', s.avatar, 'status', s.status,
        'access', to_jsonb(s.access), 'meal_plan', s.meal_plan,
        'swipes_per_week', s.swipes_per_week, 'swipes_left', s.swipes_left,
        'secret', encode(sec.secret, 'hex'), 'previous_secret', encode(sec.previous_secret, 'hex'),
        'bad_attempts', v_bad);
    end if;
  elsif p_kind = 'guest' and p_token_hash is not null and p_token_hash ~ '^[0-9a-f]{64}$' then
    select * into g from public.guest_passes where token_hash = decode(p_token_hash, 'hex');
    if found then
      perform app.refresh_swipes(g.host_id);
      select * into h from public.students where user_id = g.host_id;
      v_guest := jsonb_build_object(
        'id', g.id, 'guest_name', g.guest_name, 'location_type', g.location_type,
        'expires_at', g.expires_at, 'used_at', g.used_at, 'revoked_at', g.revoked_at,
        'host', jsonb_build_object(
          'user_id', h.user_id, 'first_name', h.first_name, 'last_name', h.last_name, 'status', h.status,
          'access', to_jsonb(h.access), 'meal_plan', h.meal_plan,
          'swipes_per_week', h.swipes_per_week, 'swipes_left', h.swipes_left));
    end if;
  end if;

  return jsonb_build_object('location', v_loc, 'student', v_student, 'guest', v_guest, 'server_now', app.now_ms());
end $$;

-- Step 2 of a scan: record the outcome in ONE transaction. A tentative grant
-- can still become a denial here, because this is where one-time use and the
-- swipe count are enforced.
create or replace function public.scan_commit(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_scanner uuid := (p ->> 'scanner_id')::uuid;
  v_location text := p ->> 'location_id';
  v_kind text := p ->> 'kind';
  v_student uuid := nullif(p ->> 'student_id', '')::uuid;
  v_window bigint := nullif(p ->> 'time_window', '')::bigint;
  v_pass uuid := nullif(p ->> 'guest_pass_id', '')::uuid;
  v_owner uuid := nullif(p ->> 'swipe_owner', '')::uuid;
  v_bad uuid := nullif(p ->> 'bad_target', '')::uuid;
  v_shown_at bigint := nullif(p ->> 'shown_at_ms', '')::bigint;
  v_use_swipe boolean := coalesce((p ->> 'use_swipe')::boolean, false);
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_result text := 'denied';
  v_reason text := coalesce(p ->> 'reason', 'invalid_code');
  v_detail jsonb := '{}'::jsonb;
  v_plan text;
  v_per_week integer;
  v_swipes integer;
  v_scan_id bigint;
  v_now_ms bigint;
  v_shown_ms integer;
  v_rows integer;
  g public.guest_passes%rowtype;
begin
  if p ->> 'decision' = 'grant' then
    v_result := 'granted';
    v_reason := 'ok';

    -- Lock the meal plan holder first, so two scans can't both take the last swipe.
    if v_use_swipe and v_owner is not null then
      perform app.refresh_swipes(v_owner);
      select meal_plan, swipes_per_week, swipes_left into v_plan, v_per_week, v_swipes
        from public.students where user_id = v_owner for update;
      if v_plan is null then
        v_result := 'denied';
        v_reason := 'no_meal_plan';
      elsif v_per_week is not null and coalesce(v_swipes, 0) <= 0 then
        v_result := 'denied';
        v_reason := 'no_swipes';
        v_swipes := 0;
      end if;
    end if;

    if v_result = 'granted' and v_kind = 'student' then
      if v_student is null or v_window is null then
        raise exception 'scan_commit: grant without a student or time window';
      end if;
      -- One-time use: the unique constraint lets exactly one scan claim this code.
      insert into public.used_codes (student_id, time_window) values (v_student, v_window)
      on conflict on constraint one_use_per_code do nothing;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        v_result := 'denied';
        v_reason := 'already_used';
        select jsonb_build_object('first_used_at', u.used_at, 'first_used_where', l.short_name) into v_detail
          from public.used_codes u
          left join public.scans sc on sc.id = u.scan_id
          left join public.locations l on l.id = sc.location_id
         where u.student_id = v_student and u.time_window = v_window;
        v_detail := coalesce(v_detail, '{}'::jsonb);
      end if;
    elsif v_result = 'granted' and v_kind = 'guest' then
      update public.guest_passes set used_at = now()
       where id = v_pass and used_at is null and revoked_at is null and expires_at > now();
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        v_result := 'denied';
        select * into g from public.guest_passes where id = v_pass;
        if not found then
          v_reason := 'invalid_code';
        elsif g.revoked_at is not null then
          v_reason := 'guest_revoked';
        elsif g.used_at is not null then
          v_reason := 'guest_used';
          v_detail := jsonb_build_object('used_at', g.used_at);
        else
          v_reason := 'guest_expired';
        end if;
      end if;
    elsif v_result = 'granted' then
      raise exception 'scan_commit: cannot grant kind %', v_kind;
    end if;

    if v_result = 'granted' and v_use_swipe and v_owner is not null and v_per_week is not null then
      update public.students set swipes_left = swipes_left - 1
       where user_id = v_owner returning swipes_left into v_swipes;
    end if;
  elsif v_bad is not null then
    -- A wrong code: count it, so guessing gets locked out.
    perform app.rate_limit_hit('bad:' || v_bad::text, 60);
  end if;

  v_now_ms := app.now_ms();
  if v_shown_at is not null and v_shown_at <= v_now_ms + 2000 and v_shown_at >= v_now_ms - 600000 then
    v_shown_ms := greatest(0, v_now_ms - v_shown_at)::integer;
  end if;

  insert into public.scans
    (scanner_id, location_id, kind, student_id, claimed_perm, guest_pass_id, result, reason, time_window, shown_ms, is_test)
  values
    (v_scanner, v_location, v_kind, v_student, p ->> 'claimed_perm', v_pass, v_result, v_reason, v_window, v_shown_ms, v_is_test)
  returning id into v_scan_id;

  if v_result = 'granted' and v_kind = 'student' then
    update public.used_codes set scan_id = v_scan_id where student_id = v_student and time_window = v_window;
  elsif v_result = 'granted' and v_kind = 'guest' then
    update public.guest_passes set used_scan_id = v_scan_id where id = v_pass;
  end if;

  return jsonb_build_object(
    'scan_id', v_scan_id, 'result', v_result, 'reason', v_reason,
    'swipes_left', case when v_use_swipe and v_per_week is not null then v_swipes end,
    'detail', v_detail, 'shown_ms', v_shown_ms);
end $$;

-- DEMO: what a one-tap test needs for one fixed test student.
create or replace function public.demo_context(p_caller uuid, p_perm text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_role text;
  v_student jsonb;
begin
  select role into v_role from public.profiles where user_id = p_caller;
  if v_role is null or v_role not in ('scanner', 'admin') then
    return jsonb_build_object('error', 'wrong_role');
  end if;
  if not coalesce((select demo_tools from public.app_settings where id), false) then
    return jsonb_build_object('error', 'demo_off');
  end if;
  select jsonb_build_object(
      'user_id', s.user_id, 'perm', s.perm, 'status', s.status,
      'secret', encode(sec.secret, 'hex'), 'previous_secret', encode(sec.previous_secret, 'hex'))
    into v_student
    from public.students s join public.student_secrets sec on sec.user_id = s.user_id
   where s.perm = p_perm;
  if v_student is null then
    return jsonb_build_object('error', 'not_seeded');
  end if;
  return jsonb_build_object(
    'student', v_student,
    'locations', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', l.id, 'name', l.name, 'short_name', l.short_name, 'type', l.type) order by l.sort), '[]'::jsonb)
                    from public.locations l));
end $$;

-- DEMO: make a test guest pass, optionally already expired.
create or replace function public.demo_guest_pass(
  p_caller uuid, p_host_perm text, p_name text, p_type text, p_ttl_seconds integer
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_role text;
  v_host uuid;
  v_token text;
begin
  select role into v_role from public.profiles where user_id = p_caller;
  if v_role is null or v_role not in ('scanner', 'admin') then
    return jsonb_build_object('error', 'wrong_role');
  end if;
  if not coalesce((select demo_tools from public.app_settings where id), false) then
    return jsonb_build_object('error', 'demo_off');
  end if;
  select user_id into v_host from public.students where perm = p_host_perm;
  if not found then
    return jsonb_build_object('error', 'not_seeded');
  end if;
  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  insert into public.guest_passes (host_id, guest_name, location_type, token_hash, expires_at, is_test)
  values (v_host, left(coalesce(p_name, 'Demo Guest'), 40), p_type, extensions.digest(v_token, 'sha256'),
          now() + make_interval(secs => coalesce(p_ttl_seconds, 3600)), true);
  return jsonb_build_object('token', v_token);
end $$;

-- DEMO: write the locations, profiles and students for the test accounts.
-- The Edge Function creates the logins first and passes their ids in.
create or replace function public.demo_seed(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  u jsonb;
  st jsonb;
  v_id uuid;
  v_week date := app.current_week();
begin
  insert into public.app_settings (id) values (true) on conflict (id) do nothing;

  insert into public.locations (id, name, short_name, type, sort)
  select x.id, x.name, x.short_name, x.type, x.sort
    from jsonb_to_recordset(p -> 'locations') as x (id text, name text, short_name text, type text, sort integer)
  on conflict (id) do update
    set name = excluded.name, short_name = excluded.short_name, type = excluded.type, sort = excluded.sort;

  for u in select * from jsonb_array_elements(p -> 'users') loop
    v_id := (u ->> 'user_id')::uuid;
    insert into public.profiles (user_id, role, display_name)
    values (v_id, u ->> 'role', u ->> 'display_name')
    on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name;

    st := u -> 'student';
    if st is not null and jsonb_typeof(st) = 'object' then
      insert into public.students
        (user_id, perm, first_name, last_name, year, major, avatar, status, lost_by, access,
         meal_plan, swipes_per_week, swipes_left, swipes_week)
      values
        (v_id, st ->> 'perm', st ->> 'first_name', st ->> 'last_name', st ->> 'year', st ->> 'major', st ->> 'avatar',
         st ->> 'status', case when st ->> 'status' = 'lost' then 'self' end,
         array(select jsonb_array_elements_text(st -> 'access')),
         st ->> 'meal_plan', (st ->> 'swipes_per_week')::integer, (st ->> 'swipes_left')::integer, v_week)
      on conflict (user_id) do update
        set perm = excluded.perm, first_name = excluded.first_name, last_name = excluded.last_name,
            year = excluded.year, major = excluded.major, avatar = excluded.avatar,
            status = excluded.status, lost_by = excluded.lost_by, status_changed_at = now(),
            access = excluded.access, meal_plan = excluded.meal_plan,
            swipes_per_week = excluded.swipes_per_week, swipes_left = excluded.swipes_left,
            swipes_week = excluded.swipes_week;
      insert into public.student_secrets (user_id, secret)
      values (v_id, extensions.gen_random_bytes(20))
      on conflict (user_id) do nothing;
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- DEMO: "Reset demo data". Clears the scan history and puts every test student
-- back to the starting state. Passwords and active students' secrets stay as
-- they are, so phones that are signed in keep working.
create or replace function public.demo_reset(p_caller uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_role text;
  st jsonb;
  v_id uuid;
  v_status text;
  v_week date := app.current_week();
begin
  select role into v_role from public.profiles where user_id = p_caller;
  if v_role is distinct from 'admin' then
    return jsonb_build_object('error', 'wrong_role');
  end if;

  delete from public.used_codes where true;
  delete from public.scans where true;
  delete from public.guest_passes where true;
  delete from public.card_events where true;
  delete from public.rate_limits where true;

  for st in select * from jsonb_array_elements(p -> 'students') loop
    select user_id, status into v_id, v_status from public.students where perm = st ->> 'perm';
    if not found then
      continue;
    end if;
    update public.students
       set status = st ->> 'status',
           lost_by = case when st ->> 'status' = 'lost' then 'self' end,
           status_changed_at = now(),
           access = array(select jsonb_array_elements_text(st -> 'access')),
           meal_plan = st ->> 'meal_plan',
           swipes_per_week = (st ->> 'swipes_per_week')::integer,
           swipes_left = (st ->> 'swipes_left')::integer,
           swipes_week = v_week
     where user_id = v_id;
    -- A student who goes back to "lost" gets a new secret, as if just reported.
    if st ->> 'status' = 'lost' and v_status = 'active' then
      update public.student_secrets
         set previous_secret = secret, secret = extensions.gen_random_bytes(20),
             version = version + 1, rotated_at = now()
       where user_id = v_id;
    end if;
    -- Start over: every signed-in device is trusted again.
    update public.student_secrets
       set sessions_valid_from = '-infinity', trusted_session = null
     where user_id = v_id;
  end loop;

  update public.app_settings set demo_tools = true, updated_at = now() where id;
  return jsonb_build_object('ok', true);
end $$;

-- =====================================================================
-- 6. Who may run which function
-- =====================================================================

revoke all on function
  public.bootstrap(),
  public.get_my_pass(),
  public.report_lost(),
  public.reactivate_card(),
  public.create_guest_pass(text, text),
  public.revoke_guest_pass(uuid),
  public.my_recent_scans(integer),
  public.log_scan_timing(bigint, integer),
  public.admin_overview(integer),
  public.admin_set_card_status(uuid, text),
  public.admin_set_demo_tools(boolean),
  public.scan_prepare(uuid, text, text, text, text),
  public.scan_commit(jsonb),
  public.demo_context(uuid, text),
  public.demo_guest_pass(uuid, text, text, text, integer),
  public.demo_seed(jsonb),
  public.demo_reset(uuid, jsonb)
from public, anon, authenticated;

-- Signed-in users. Each function checks the caller's role itself.
grant execute on function
  public.bootstrap(),
  public.get_my_pass(),
  public.report_lost(),
  public.reactivate_card(),
  public.create_guest_pass(text, text),
  public.revoke_guest_pass(uuid),
  public.my_recent_scans(integer),
  public.log_scan_timing(bigint, integer),
  public.admin_overview(integer),
  public.admin_set_card_status(uuid, text),
  public.admin_set_demo_tools(boolean)
to authenticated;

-- Edge Functions only.
grant execute on function
  public.scan_prepare(uuid, text, text, text, text),
  public.scan_commit(jsonb),
  public.demo_context(uuid, text),
  public.demo_guest_pass(uuid, text, text, text, integer),
  public.demo_seed(jsonb),
  public.demo_reset(uuid, jsonb)
to service_role;

grant usage on schema public to authenticated, service_role;
