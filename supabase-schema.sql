create table signals (
  ticker text primary key,
  exch text,
  company text,
  headline text,
  sentiment text,
  score int,
  vol int,
  updated_at timestamptz
);
