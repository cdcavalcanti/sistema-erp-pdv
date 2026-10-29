#!/bin/sh
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -f /docker-entrypoint-initdb.d/init-roles.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -c "CREATE DATABASE vortex_erp OWNER vortex_owner"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -c "CREATE DATABASE vortex_erp_test OWNER vortex_owner"
