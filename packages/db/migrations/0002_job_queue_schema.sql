-- The job queue (pg-boss) installs its tables into this schema using the
-- owning role. The application role must be able to enqueue, so it is
-- granted access to whatever the owning role creates here later.
create schema if not exists pgboss;
grant usage on schema pgboss to fdv_app;
alter default privileges in schema pgboss
  grant select, insert, update, delete on tables to fdv_app;
alter default privileges in schema pgboss
  grant usage, select on sequences to fdv_app;
alter default privileges in schema pgboss
  grant execute on functions to fdv_app;
