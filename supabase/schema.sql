create table if not exists public.leaderboard (
  player_key text primary key check (char_length(player_key) between 1 and 14),
  player_name text not null check (char_length(player_name) between 1 and 14),
  highest_level smallint not null check (highest_level between 1 and 7),
  verified boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.leaderboard
  add column if not exists verified boolean not null default false;

alter table public.leaderboard enable row level security;

create index if not exists leaderboard_rank_idx
  on public.leaderboard (highest_level desc, updated_at asc);

create index if not exists leaderboard_verified_rank_idx
  on public.leaderboard (highest_level desc, updated_at asc)
  where verified;

create table if not exists public.game_sessions (
  token_hash text primary key check (char_length(token_hash) = 64),
  player_name text not null check (char_length(player_name) between 1 and 14),
  player_key text not null check (char_length(player_key) between 1 and 14),
  current_level smallint not null check (current_level between 1 and 8),
  fragment_seen boolean not null default false,
  passwords jsonb,
  expires_at timestamptz not null
);

alter table public.game_sessions
  add column if not exists passwords jsonb;

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
begin
  select * into active_session
  from public.game_sessions
  where token_hash = session_token_hash
    and expires_at > now()
  for update;

  if not found or active_session.current_level <> expected_level or expected_level not between 1 and 7 then
    return null;
  end if;

  update public.game_sessions
  set current_level = expected_level + 1,
      fragment_seen = false
  where token_hash = session_token_hash;

  insert into public.leaderboard as current_score (player_key, player_name, highest_level, verified)
  values (active_session.player_key, active_session.player_name, expected_level, true)
  on conflict (player_key) do update
    set player_name = excluded.player_name,
        highest_level = case
          when current_score.verified then greatest(current_score.highest_level, excluded.highest_level)
          else excluded.highest_level
        end,
        verified = true,
        updated_at = case
          when excluded.highest_level > current_score.highest_level then now()
          else current_score.updated_at
        end;
  return jsonb_build_object(
    'completed_level', expected_level,
    'current_level', expected_level + 1
  );
end;
$$;

revoke all on public.leaderboard from public, anon, authenticated;
revoke all on public.game_sessions from public, anon, authenticated;
revoke all on public.used_game_passwords from public, anon, authenticated;
revoke all on function public.mark_fragment_seen(text, smallint) from public, anon, authenticated;
revoke all on function public.complete_game_level(text, smallint) from public, anon, authenticated;
revoke all on function public.reserve_game_passwords(text, jsonb) from public, anon, authenticated;
grant select on public.leaderboard to service_role;
grant select, insert, update, delete on public.game_sessions to service_role;
grant execute on function public.mark_fragment_seen(text, smallint) to service_role;
grant execute on function public.complete_game_level(text, smallint) to service_role;
grant execute on function public.reserve_game_passwords(text, jsonb) to service_role;