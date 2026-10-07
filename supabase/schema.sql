create table if not exists public.leaderboard (
  player_key text primary key check (char_length(player_key) between 1 and 14),
  player_name text not null check (char_length(player_name) between 1 and 14),
  highest_level smallint not null check (highest_level between 1 and 7),
  level_time_ms bigint check (level_time_ms >= 0),
  verified boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.leaderboard
  add column if not exists verified boolean not null default false;

alter table public.leaderboard
  add column if not exists level_time_ms bigint check (level_time_ms >= 0);

alter table public.leaderboard enable row level security;

create index if not exists leaderboard_rank_idx
  on public.leaderboard (highest_level desc, updated_at asc);

drop index if exists public.leaderboard_verified_rank_idx;

create index leaderboard_verified_rank_idx
  on public.leaderboard (highest_level desc, level_time_ms asc nulls last, updated_at asc)
  where verified;

create table if not exists public.game_sessions (
  token_hash text primary key check (char_length(token_hash) = 64),
  player_name text not null check (char_length(player_name) between 1 and 14),
  player_email text,
  player_key text not null check (char_length(player_key) between 1 and 14),
  current_level smallint not null check (current_level between 1 and 8),
  level_active boolean not null default false,
  fragment_seen boolean not null default false,
  progress_state jsonb not null default '{"version":[3]}'::jsonb,
  passwords jsonb,
  level_started_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);

alter table public.game_sessions
  add column if not exists passwords jsonb;

alter table public.game_sessions
  add column if not exists player_email text;

alter table public.game_sessions
  add column if not exists progress_state jsonb not null default '{"version":[3]}'::jsonb;

alter table public.game_sessions
  alter column progress_state set default '{"version":[3]}'::jsonb;

-- Reset sessions carrying progress from the previous challenge ruleset once.
update public.game_sessions
set current_level = 1,
    level_active = false,
    fragment_seen = false,
    progress_state = '{"version":[3]}'::jsonb,
    level_started_at = clock_timestamp()
where progress_state->'version' is distinct from '[3]'::jsonb;

alter table public.game_sessions
  add column if not exists level_started_at timestamptz;

alter table public.game_sessions
  add column if not exists level_active boolean not null default false;

update public.game_sessions
set level_started_at = clock_timestamp()
where level_started_at is null;

alter table public.game_sessions
  alter column level_started_at set default clock_timestamp(),
  alter column level_started_at set not null;

alter table public.game_sessions enable row level security;

create index if not exists game_sessions_expiry_idx
  on public.game_sessions (expires_at);

create table if not exists public.used_game_passwords (
  player_key text not null check (char_length(player_key) between 1 and 14),
  password text not null check (char_length(password) = 19),
  created_at timestamptz not null default now(),
  primary key (player_key, password)
);

alter table public.used_game_passwords enable row level security;

create or replace function public.reserve_game_passwords(
  reserved_player_key text,
  candidate_passwords jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if candidate_passwords is null
    or jsonb_typeof(candidate_passwords) is distinct from 'array'
    or jsonb_array_length(candidate_passwords) <> 7
    or (select count(distinct candidate.password)
        from jsonb_array_elements_text(candidate_passwords) as candidate(password)) <> 7 then
    return false;
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(candidate_passwords) as candidate(password)
    join public.used_game_passwords as used
      on used.player_key = reserved_player_key
      and used.password = candidate.password
  ) then
    return false;
  end if;

  begin
    insert into public.used_game_passwords (player_key, password)
    select reserved_player_key, candidate.password
    from jsonb_array_elements_text(candidate_passwords) as candidate(password);
    return true;
  exception when unique_violation then
    return false;
  end;
end;
$$;

drop function if exists public.submit_score(text, text, smallint);

create or replace function public.mark_fragment_seen(
  session_token_hash text,
  expected_level smallint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.game_sessions
  set fragment_seen = true
  where token_hash = session_token_hash
    and current_level = expected_level
    and not fragment_seen
    and expires_at > now();
  return found;
end;
$$;

create or replace function public.complete_game_level(
  session_token_hash text,
  expected_level smallint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_session public.game_sessions;
  completed_at timestamptz;
  elapsed_ms bigint;
begin
  select * into active_session
  from public.game_sessions
  where token_hash = session_token_hash
    and expires_at > now()
  for update;

  if not found or active_session.current_level <> expected_level or expected_level not between 1 and 7 or not active_session.level_active then
    return null;
  end if;

  completed_at := clock_timestamp();
  elapsed_ms := greatest(0, floor(extract(epoch from (completed_at - active_session.level_started_at)) * 1000)::bigint);

  update public.game_sessions
  set current_level = expected_level + 1,
      fragment_seen = false,
      progress_state = '{"version":[3]}'::jsonb,
      level_active = false,
      level_started_at = completed_at
  where token_hash = session_token_hash;

  insert into public.leaderboard as current_score (player_key, player_name, highest_level, level_time_ms, verified)
  values (active_session.player_key, active_session.player_name, expected_level, elapsed_ms, true)
  on conflict (player_key) do update
    set player_name = excluded.player_name,
        highest_level = case
          when current_score.verified then greatest(current_score.highest_level, excluded.highest_level)
          else excluded.highest_level
        end,
        level_time_ms = case
          when not current_score.verified or excluded.highest_level > current_score.highest_level then excluded.level_time_ms
          when excluded.highest_level = current_score.highest_level then
            case
              when current_score.level_time_ms is null then excluded.level_time_ms
              else least(current_score.level_time_ms, excluded.level_time_ms)
            end
          else current_score.level_time_ms
        end,
        verified = true,
        updated_at = case
          when not current_score.verified
            or excluded.highest_level > current_score.highest_level
            or (excluded.highest_level = current_score.highest_level
              and (current_score.level_time_ms is null or excluded.level_time_ms < current_score.level_time_ms))
            then completed_at
          else current_score.updated_at
        end;
  return jsonb_build_object(
    'completed_level', expected_level,
    'current_level', expected_level + 1,
    'level_time_ms', elapsed_ms,
    'next_level_started_at', completed_at
  );
end;
$$;

create or replace function public.begin_game_level(
  session_token_hash text,
  expected_level smallint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_session public.game_sessions;
  started_at timestamptz;
begin
  select * into active_session
  from public.game_sessions
  where token_hash = session_token_hash
    and expires_at > now()
  for update;

  if not found or active_session.current_level <> expected_level or expected_level not between 1 and 7 then
    return null;
  end if;

  if active_session.level_active then
    return jsonb_build_object(
      'current_level', active_session.current_level,
      'level_started_at', active_session.level_started_at,
      'level_active', true
    );
  end if;

  started_at := clock_timestamp();
  update public.game_sessions
  set level_active = true,
      level_started_at = started_at
  where token_hash = session_token_hash;

  return jsonb_build_object(
    'current_level', expected_level,
    'level_started_at', started_at,
    'level_active', true
  );
end;
$$;

create or replace function public.restart_game_level(
  session_token_hash text,
  expected_level smallint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_session public.game_sessions;
  restarted_at timestamptz;
begin
  select * into active_session
  from public.game_sessions
  where token_hash = session_token_hash
    and expires_at > now()
  for update;

  if not found
    or expected_level not between 1 and 7
    or active_session.current_level not in (expected_level, expected_level + 1) then
    return null;
  end if;

  restarted_at := clock_timestamp();
  update public.game_sessions
  set current_level = expected_level,
      fragment_seen = false,
      progress_state = '{"version":[3]}'::jsonb,
      level_active = false,
      level_started_at = restarted_at
  where token_hash = session_token_hash;

  return jsonb_build_object(
    'current_level', expected_level,
    'level_started_at', restarted_at,
    'level_active', false
  );
end;
$$;

create or replace function public.restart_game_run(
  session_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_session public.game_sessions;
  restarted_at timestamptz;
begin
  select * into active_session
  from public.game_sessions
  where token_hash = session_token_hash
    and expires_at > now()
  for update;

  if not found then
    return null;
  end if;

  restarted_at := clock_timestamp();
  update public.game_sessions
  set current_level = 1,
      fragment_seen = false,
      progress_state = '{"version":[3]}'::jsonb,
      level_active = false,
      level_started_at = restarted_at
  where token_hash = session_token_hash;

  return jsonb_build_object(
    'current_level', 1,
    'level_started_at', restarted_at,
    'level_active', false
  );
end;
$$;

revoke all on public.leaderboard from public, anon, authenticated;
revoke all on public.game_sessions from public, anon, authenticated;
revoke all on public.used_game_passwords from public, anon, authenticated;
revoke all on function public.mark_fragment_seen(text, smallint) from public, anon, authenticated;
revoke all on function public.complete_game_level(text, smallint) from public, anon, authenticated;
revoke all on function public.begin_game_level(text, smallint) from public, anon, authenticated;
revoke all on function public.restart_game_level(text, smallint) from public, anon, authenticated;
revoke all on function public.restart_game_run(text) from public, anon, authenticated;
revoke all on function public.reserve_game_passwords(text, jsonb) from public, anon, authenticated;
grant select on public.leaderboard to service_role;
grant select, insert, update, delete on public.game_sessions to service_role;
grant execute on function public.mark_fragment_seen(text, smallint) to service_role;
grant execute on function public.complete_game_level(text, smallint) to service_role;
grant execute on function public.begin_game_level(text, smallint) to service_role;
grant execute on function public.restart_game_level(text, smallint) to service_role;
grant execute on function public.restart_game_run(text) to service_role;
grant execute on function public.reserve_game_passwords(text, jsonb) to service_role;
