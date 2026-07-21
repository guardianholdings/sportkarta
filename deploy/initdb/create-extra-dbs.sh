#!/bin/bash
# Runs once on first init of the Postgres volume (dev and prod):
# creates the databases Umami and GlitchTip need alongside the app DB.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE DATABASE umami;
	CREATE DATABASE glitchtip;
EOSQL
