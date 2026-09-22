#!/bin/sh
# Runs once, on first start of an empty data volume. Creates the application
# role with its password so that migrations (which run as the owning role
# $POSTGRES_USER) only have to grant it privileges.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
do \$\$
begin
  if not exists (select 1 from pg_roles where rolname = 'fdv_app') then
    create role fdv_app login password '${FDV_DB_APP_PASSWORD}';
  else
    alter role fdv_app password '${FDV_DB_APP_PASSWORD}';
  end if;
end \$\$;
SQL
