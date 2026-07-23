-- 0016_hiking_landmarks: the twenty most-visited hiking landmarks of Bulgaria,
-- as facilities with sport 'hiking' (docs/ROADMAP.md §8, map layer). DATA ONLY
-- — no schema change, no enum, nothing altered or rewritten; forward-only.
--
-- WHERE THE COORDINATES COME FROM, AND WHY THAT IS THE ONLY HONEST ANSWER.
-- Every point is a real OpenStreetMap element, and its ref is carried in two
-- places: the osm_type/osm_id columns and attrs.osm.ref. So each marker is one
-- click from verification at openstreetmap.org/<type>/<id> — Мусала is
-- node/274078231, Черни връх (Витоша, not one of the ten other peaks that share
-- the name) is node/26862677, and so on. The alternative — placing coordinates
-- from memory — would produce exactly the unreliable routes this feature was
-- asked to avoid, so it was never on the table. Two candidates (Попово езеро,
-- Орлово око) were dropped because their exact point could not be confirmed;
-- an omitted landmark is recoverable, a wrong one on a public map is not.
--
-- source = 'osm', WHICH THE CHECK REQUIRES AND WHICH IS TRUE. facilities carries
-- `facilities_osm_source_has_ref` (source='osm' → osm_id NOT NULL); these rows
-- satisfy it honestly because the coordinate IS that OSM node/way/relation. The
-- OSM facility importer keys on (osm_type, osm_id) among sports facilities only,
-- and a natural=peak or leisure=park is never one of its candidates, so it will
-- never match or overwrite these — verified: zero (osm_type, osm_id) collisions
-- against existing rows before writing this file.
--
-- THEY SHOW WITH NO MAP CHANGE. status='active' and a slug means each passes the
-- public visibility rule (status <> 'gone' AND slug IS NOT NULL), so /api/
-- facilities returns them and they cluster on the map like any facility; adding
-- 'hiking' to CANONICAL_SPORTS (lib/src/sports.ts) makes the sport filter offer
-- them. access='free' — a mountain is free to walk.
--
-- Every insert also writes a facility_edits 'created' row, source='osm',
-- actor NULL — the same audit the importer and the crowd add-facility flow
-- write, so a landmark has a provenance trail like every other record.
--
-- LOCKING: two plain INSERTs, no lock on any existing table beyond the row
-- locks of the new rows themselves. Nothing here touches `users`, so none of
-- 0012–0015's erasure lock-ordering concerns apply.
--
-- rollback (DESTRUCTIVE): the facility_edits rows are append-only and cannot be
-- deleted, so a true rollback needs the trigger disabled:
--   ALTER TABLE facility_edits DISABLE TRIGGER USER;
--   DELETE FROM facility_edits WHERE (facility_id) IN (SELECT id FROM facilities WHERE attrs->>'curated' = 'hiking_landmark');
--   DELETE FROM facilities WHERE attrs->>'curated' = 'hiking_landmark';
--   ALTER TABLE facility_edits ENABLE TRIGGER USER;

INSERT INTO facilities
  (geom, name, slug, sport_types, access, status, source, osm_type, osm_id, municipality_id, attrs)
VALUES
  (ST_SetSRID(ST_MakePoint(23.58528, 42.17919), 4326), 'Мусала', 'musala', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 274078231,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.58528, 42.17919), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/274078231"},"curated":"hiking_landmark","region":"Рила"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.39884, 41.76733), 4326), 'Вихрен', 'vihren', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 274078063,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.39884, 41.76733), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/274078063"},"curated":"hiking_landmark","region":"Пирин"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.27934, 42.56309), 4326), 'Черни връх', 'cherni-vrah', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 26862677,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.27934, 42.56309), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/26862677"},"curated":"hiking_landmark","region":"Витоша"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(24.91728, 42.71687), 4326), 'Ботев', 'botev', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 26862606,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(24.91728, 42.71687), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/26862606"},"curated":"hiking_landmark","region":"Стара планина"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.36302, 42.17382), 4326), 'Мальовица', 'malyovitsa', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 274078291,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.36302, 42.17382), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/274078291"},"curated":"hiking_landmark","region":"Рила"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.0521, 43.17388), 4326), 'Ком', 'kom', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 26863408,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.0521, 43.17388), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/26863408"},"curated":"hiking_landmark","region":"Стара планина"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.51223, 41.73055), 4326), 'Безбог', 'bezbog', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 274078192,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.51223, 41.73055), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/274078192"},"curated":"hiking_landmark","region":"Пирин"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(24.92541, 42.70152), 4326), 'Райското пръскало', 'rayskoto-praskalo', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 2874251251,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(24.92541, 42.70152), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/2874251251"},"curated":"hiking_landmark","region":"Стара планина"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.25433, 42.62962), 4326), 'Боянски водопад', 'boyanski-vodopad', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 5633059085,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.25433, 42.62962), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/5633059085"},"curated":"hiking_landmark","region":"Витоша"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.30647, 42.22045), 4326), 'Скакавица', 'skakavitsa', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 3939182072,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.30647, 42.22045), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/3939182072"},"curated":"hiking_landmark","region":"Рила"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(25.03323, 43.24321), 4326), 'Крушунски водопади', 'krushunski-vodopadi', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 5903307485,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(25.03323, 43.24321), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/5903307485"},"curated":"hiking_landmark","region":"Ловешко"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(24.58187, 41.81891), 4326), 'Чудните мостове', 'chudnite-mostove', '{hiking}'::text[], 'free', 'active', 'osm',
   'way', 122009185,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(24.58187, 41.81891), 4326)) LIMIT 1),
   '{"osm":{"ref":"way/122009185"},"curated":"hiking_landmark","region":"Родопи"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(25.11417, 41.62058), 4326), 'Дяволски мост', 'dyavolski-most', '{hiking}'::text[], 'free', 'active', 'osm',
   'way', 58478181,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(25.11417, 41.62058), 4326)) LIMIT 1),
   '{"osm":{"ref":"way/58478181"},"curated":"hiking_landmark","region":"Родопи"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.31723, 42.20225), 4326), 'Седемте рилски езера', 'sedemte-rilski-ezera', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 6698043496,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.31723, 42.20225), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/6698043496"},"curated":"hiking_landmark","region":"Рила"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(22.68067, 43.61197), 4326), 'Белоградчишки скали', 'belogradchishki-skali', '{hiking}'::text[], 'free', 'active', 'osm',
   'relation', 14393169,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(22.68067, 43.61197), 4326)) LIMIT 1),
   '{"osm":{"ref":"relation/14393169"},"curated":"hiking_landmark","region":"Белоградчик"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.12136, 42.09214), 4326), 'Стобски пирамиди', 'stobski-piramidi', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 4471942522,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.12136, 42.09214), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/4471942522"},"curated":"hiking_landmark","region":"Рила"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.24472, 42.60837), 4326), 'Златните мостове', 'zlatnite-mostove', '{hiking}'::text[], 'free', 'active', 'osm',
   'relation', 5491731,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.24472, 42.60837), 4326)) LIMIT 1),
   '{"osm":{"ref":"relation/5491731"},"curated":"hiking_landmark","region":"Витоша"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.49366, 43.20443), 4326), 'Леденика', 'ledenika', '{hiking}'::text[], 'free', 'active', 'osm',
   'node', 1216487615,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.49366, 43.20443), 4326)) LIMIT 1),
   '{"osm":{"ref":"node/1216487615"},"curated":"hiking_landmark","region":"Врачански Балкан"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.3415, 42.6741), 4326), 'Борисова градина', 'borisova-gradina', '{hiking}'::text[], 'free', 'active', 'osm',
   'relation', 16947241,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.3415, 42.6741), 4326)) LIMIT 1),
   '{"osm":{"ref":"relation/16947241"},"curated":"hiking_landmark","region":"София"}'::jsonb),
  (ST_SetSRID(ST_MakePoint(23.30746, 42.67303), 4326), 'Южен парк', 'yuzhen-park', '{hiking}'::text[], 'free', 'active', 'osm',
   'relation', 16878152,
   (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(23.30746, 42.67303), 4326)) LIMIT 1),
   '{"osm":{"ref":"relation/16878152"},"curated":"hiking_landmark","region":"София"}'::jsonb);
--> statement-breakpoint

-- One audit row per landmark, exactly as the OSM importer writes on create.
INSERT INTO facility_edits (facility_id, actor, source, field, new_value)
SELECT f.id, NULL, 'osm', 'created',
       jsonb_build_object(
         'name', to_jsonb(f.name),
         'sport_types', to_jsonb(f.sport_types),
         'access', to_jsonb(f.access::text),
         'geom', jsonb_build_object('lon', ST_X(f.geom), 'lat', ST_Y(f.geom))
       )
FROM facilities f
WHERE (f.osm_type, f.osm_id) IN (('node',274078231), ('node',274078063), ('node',26862677), ('node',26862606), ('node',274078291), ('node',26863408), ('node',274078192), ('node',2874251251), ('node',5633059085), ('node',3939182072), ('node',5903307485), ('way',122009185), ('way',58478181), ('node',6698043496), ('relation',14393169), ('node',4471942522), ('relation',5491731), ('node',1216487615), ('relation',16947241), ('relation',16878152));
