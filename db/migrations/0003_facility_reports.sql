-- 0003_facility_reports: anonymous visitor problem-reports (docs/ROADMAP.md
-- Stage 2.2). All-new table + two enums, so plain CREATE is safe. No IP or
-- other identifier column by design — the request IP is used transiently for
-- rate-limiting and never persisted (privacy page states this). An optional
-- photo lands in facility_photos (status=pending) and is referenced by photo_id;
-- photo_id is indexed so ON DELETE SET NULL never seq-scans this table.
--
-- rollback (compensating SQL, reverse order):
--   DROP TABLE "facility_reports";
--   DROP TYPE "report_status"; DROP TYPE "report_issue";
CREATE TYPE "public"."report_issue" AS ENUM('broken_equipment', 'no_lighting', 'bad_surface', 'does_not_exist', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('pending', 'reviewed', 'dismissed');--> statement-breakpoint
CREATE TABLE "facility_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"issue" "report_issue" NOT NULL,
	"body" text,
	"photo_id" uuid,
	"status" "report_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_reports_body_len" CHECK ("facility_reports"."body" IS NULL OR char_length("facility_reports"."body") <= 500),
	CONSTRAINT "facility_reports_body_not_blank" CHECK ("facility_reports"."body" IS NULL OR btrim("facility_reports"."body") <> '')
);
--> statement-breakpoint
ALTER TABLE "facility_reports" ADD CONSTRAINT "facility_reports_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_reports" ADD CONSTRAINT "facility_reports_photo_id_facility_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."facility_photos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facility_reports_pending_created_idx" ON "facility_reports" USING btree ("created_at") WHERE "facility_reports"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "facility_reports_facility_id_idx" ON "facility_reports" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "facility_reports_photo_id_idx" ON "facility_reports" USING btree ("photo_id");