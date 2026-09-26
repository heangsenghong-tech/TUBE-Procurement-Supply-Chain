CREATE TYPE "public"."request_group" AS ENUM('procurement', 'supply_chain', 'projects', 'other');--> statement-breakpoint
ALTER TYPE "public"."request_kind" ADD VALUE 'service';--> statement-breakpoint
CREATE TABLE "request_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"group" "request_group" NOT NULL,
	"handling" "request_kind" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_types_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "request_type_id" uuid;--> statement-breakpoint
-- Existing requests get the two types that existed before request types were configurable.
INSERT INTO "request_types" ("key", "name", "group", "handling", "description", "sort_order") VALUES
  ('purchase_request', 'Purchase Request', 'procurement', 'purchase', 'Buy items from the catalog. Under $100 becomes a petty cash record your HOD acknowledges.', 10),
  ('new_item_sample', 'New Item / Sample Request', 'procurement', 'sample', 'Not sure yet? Get a sample sourced and tried before buying.', 20);--> statement-breakpoint
UPDATE "requests" SET "request_type_id" = (SELECT "id" FROM "request_types" WHERE "key" = CASE WHEN "requests"."kind" = 'purchase' THEN 'purchase_request' ELSE 'new_item_sample' END);--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "request_type_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "is_urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "urgent_reason" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_request_type_id_request_types_id_fk" FOREIGN KEY ("request_type_id") REFERENCES "public"."request_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_type_idx" ON "requests" USING btree ("request_type_id");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_urgent_reason" CHECK (not "requests"."is_urgent" or "requests"."urgent_reason" is not null);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_petty_cash_not_urgent" CHECK (not ("requests"."is_petty_cash" and "requests"."is_urgent"));