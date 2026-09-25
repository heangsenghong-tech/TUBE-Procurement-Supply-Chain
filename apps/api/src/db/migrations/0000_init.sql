CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'changes_requested', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approver_type" AS ENUM('hod', 'role');--> statement-breakpoint
CREATE TYPE "public"."contract_stage" AS ENUM('draft', 'review', 'clause_negotiation', 'pending_approval', 'pending_signature', 'signed', 'on_hold', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('request', 'po');--> statement-breakpoint
CREATE TYPE "public"."item_category" AS ENUM('Food', 'Non-food');--> statement-breakpoint
CREATE TYPE "public"."line_status" AS ENUM('pending_approval', 'open', 'in_qcs', 'ordered', 'delivered', 'cancelled', 'petty_cash');--> statement-breakpoint
CREATE TYPE "public"."org_unit_type" AS ENUM('store', 'department');--> statement-breakpoint
CREATE TYPE "public"."ownership" AS ENUM('franchiser', 'franchisee');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('pending_approval', 'approved', 'delivered', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."procurement_type" AS ENUM('Direct', 'Indirect');--> statement-breakpoint
CREATE TYPE "public"."qcs_status" AS ENUM('open', 'reopened', 'converted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."request_kind" AS ENUM('purchase', 'sample');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending_approval', 'changes_requested', 'approved', 'in_progress', 'ordered', 'completed', 'rejected', 'cancelled', 'petty_cash_approved', 'petty_cash_reconciled', 'sourcing', 'under_review', 'under_evaluation', 'under_consideration', 'pass', 'fail', 'not_meet_requirement');--> statement-breakpoint
CREATE TYPE "public"."selection_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('waiting', 'pending', 'approved', 'rejected', 'changes_requested', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."supplier_category" AS ENUM('Food', 'Non-food', 'Both');--> statement-breakpoint
CREATE TYPE "public"."track" AS ENUM('store', 'hq');--> statement-breakpoint
CREATE TABLE "approval_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_kind" "document_kind" NOT NULL,
	"document_id" uuid NOT NULL,
	"rule_id" uuid,
	"rule_name" text NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"status" "approval_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_rule_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"approver_type" "approver_type" NOT NULL,
	"role_key" text,
	"action_label" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_kind" "document_kind" NOT NULL,
	"name" text NOT NULL,
	"min_amount" numeric(14, 4) DEFAULT 0 NOT NULL,
	"max_amount" numeric(14, 4),
	"is_petty_cash" boolean DEFAULT false NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_rules_range" CHECK ("approval_rules"."max_amount" is null or "approval_rules"."max_amount" > "approval_rules"."min_amount")
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"approver_type" "approver_type" NOT NULL,
	"role_key" text,
	"org_unit_id" uuid,
	"action_label" text NOT NULL,
	"status" "step_status" NOT NULL,
	"acted_by" uuid,
	"acted_at" timestamp with time zone,
	"acted_as_override" boolean DEFAULT false NOT NULL,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"supplier_id" uuid,
	"stage" "contract_stage" NOT NULL,
	"start_date" date,
	"expiry_date" date,
	"key_terms" text,
	"document_pointer" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"prefix" text NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_sequences_prefix_year_pk" PRIMARY KEY("prefix","year")
);
--> statement-breakpoint
CREATE TABLE "item_supplier_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"rank" integer DEFAULT 1 NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_by" uuid,
	CONSTRAINT "isp_price_nonneg" CHECK ("item_supplier_prices"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"category" "item_category" NOT NULL,
	"procurement_type" "procurement_type" NOT NULL,
	"uom" text NOT NULL,
	"specification" text,
	"brand" text,
	"standard_cost" numeric(14, 4),
	"is_reference" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "org_unit_type" NOT NULL,
	"ownership" "ownership",
	"hod_user_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_line_allocations" (
	"po_line_id" uuid NOT NULL,
	"request_line_id" uuid NOT NULL,
	CONSTRAINT "po_line_allocations_po_line_id_request_line_id_pk" PRIMARY KEY("po_line_id","request_line_id")
);
--> statement-breakpoint
CREATE TABLE "po_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"uom" text NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"original_price" numeric(14, 4) NOT NULL,
	"prior_unit_price" numeric(14, 4),
	"qcs_item_id" uuid,
	"quotation_id" uuid,
	CONSTRAINT "po_lines_qty_pos" CHECK ("po_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"qcs_id" uuid,
	"status" "po_status" NOT NULL,
	"total" numeric(14, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"expected_delivery_date" date,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivered_by" uuid,
	"delivery_note" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "qcs_item_lines" (
	"qcs_item_id" uuid NOT NULL,
	"request_line_id" uuid NOT NULL,
	CONSTRAINT "qcs_item_lines_qcs_item_id_request_line_id_pk" PRIMARY KEY("qcs_item_id","request_line_id")
);
--> statement-breakpoint
CREATE TABLE "qcs_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qcs_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"uom" text NOT NULL,
	CONSTRAINT "qcs_items_qty_pos" CHECK ("qcs_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "qcs_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qcs_item_id" uuid NOT NULL,
	"quotation_id" uuid NOT NULL,
	"status" "selection_status" NOT NULL,
	"reason" text,
	"selected_by" uuid NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_reason" text,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qcs_item_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"original_price" numeric(14, 4) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"lead_time_days" integer,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotations_prices" CHECK ("quotations"."unit_price" >= 0 and "quotations"."original_price" >= "quotations"."unit_price")
);
--> statement-breakpoint
CREATE TABLE "quote_comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"status" "qcs_status" NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_comparisons_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"uom" text NOT NULL,
	"est_unit_price" numeric(14, 4) DEFAULT 0 NOT NULL,
	"status" "line_status" NOT NULL,
	"cancel_reason" text,
	CONSTRAINT "request_lines_qty_pos" CHECK ("request_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"kind" "request_kind" NOT NULL,
	"track" "track" NOT NULL,
	"org_unit_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"status" "request_status" NOT NULL,
	"is_petty_cash" boolean DEFAULT false NOT NULL,
	"estimated_total" numeric(14, 4) DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"required_date" date,
	"purpose" text,
	"reference_url" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	"reconcile_reference" text,
	"reconcile_amount" numeric(14, 4),
	"reconcile_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_number_unique" UNIQUE("number"),
	CONSTRAINT "requests_petty_cash_purchase" CHECK (not "requests"."is_petty_cash" or "requests"."kind" = 'purchase')
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"approver" boolean DEFAULT false NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "supplier_category" NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"address" text,
	"payment_terms" text,
	"delivery_terms" text,
	"lead_time_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "uoms" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"org_unit_id" uuid,
	"google_sub" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_rule_id_approval_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."approval_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rule_steps" ADD CONSTRAINT "approval_rule_steps_rule_id_approval_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."approval_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_instance_id_approval_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_acted_by_users_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_supplier_prices" ADD CONSTRAINT "item_supplier_prices_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_supplier_prices" ADD CONSTRAINT "item_supplier_prices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_supplier_prices" ADD CONSTRAINT "item_supplier_prices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_uom_uoms_code_fk" FOREIGN KEY ("uom") REFERENCES "public"."uoms"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_hod_user_id_users_id_fk" FOREIGN KEY ("hod_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_line_allocations" ADD CONSTRAINT "po_line_allocations_po_line_id_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."po_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_line_allocations" ADD CONSTRAINT "po_line_allocations_request_line_id_request_lines_id_fk" FOREIGN KEY ("request_line_id") REFERENCES "public"."request_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_qcs_item_id_qcs_items_id_fk" FOREIGN KEY ("qcs_item_id") REFERENCES "public"."qcs_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_qcs_id_quote_comparisons_id_fk" FOREIGN KEY ("qcs_id") REFERENCES "public"."quote_comparisons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_delivered_by_users_id_fk" FOREIGN KEY ("delivered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qcs_item_lines" ADD CONSTRAINT "qcs_item_lines_qcs_item_id_qcs_items_id_fk" FOREIGN KEY ("qcs_item_id") REFERENCES "public"."qcs_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qcs_item_lines" ADD CONSTRAINT "qcs_item_lines_request_line_id_request_lines_id_fk" FOREIGN KEY ("request_line_id") REFERENCES "public"."request_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qcs_items" ADD CONSTRAINT "qcs_items_qcs_id_quote_comparisons_id_fk" FOREIGN KEY ("qcs_id") REFERENCES "public"."quote_comparisons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qcs_items" ADD CONSTRAINT "qcs_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qcs_selections" ADD CONSTRAINT "qcs_selections_qcs_item_id_qcs_items_id_fk" FOREIGN KEY ("qcs_item_id") REFERENCES "public"."qcs_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qcs_selections" ADD CONSTRAINT "qcs_selections_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qcs_selections" ADD CONSTRAINT "qcs_selections_selected_by_users_id_fk" FOREIGN KEY ("selected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_qcs_item_id_qcs_items_id_fk" FOREIGN KEY ("qcs_item_id") REFERENCES "public"."qcs_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_comparisons" ADD CONSTRAINT "quote_comparisons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_lines" ADD CONSTRAINT "request_lines_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_lines" ADD CONSTRAINT "request_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_reconciled_by_users_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_instances_doc_idx" ON "approval_instances" USING btree ("document_kind","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rule_steps_seq_uq" ON "approval_rule_steps" USING btree ("rule_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_steps_seq_uq" ON "approval_steps" USING btree ("instance_id","seq");--> statement-breakpoint
CREATE INDEX "approval_steps_pending_idx" ON "approval_steps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "comments_entity_idx" ON "comments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "isp_current_uq" ON "item_supplier_prices" USING btree ("item_id","supplier_id") WHERE "item_supplier_prices"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "isp_item_idx" ON "item_supplier_prices" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_code_uq" ON "items" USING btree (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "org_units_code_uq" ON "org_units" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "pla_request_line_idx" ON "po_line_allocations" USING btree ("request_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_lines_no_uq" ON "po_lines" USING btree ("po_id","line_no");--> statement-breakpoint
CREATE INDEX "po_lines_item_idx" ON "po_lines" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qcs_items_item_uq" ON "qcs_items" USING btree ("qcs_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qcs_selections_active_uq" ON "qcs_selections" USING btree ("qcs_item_id") WHERE "qcs_selections"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_supplier_uq" ON "quotations" USING btree ("qcs_item_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_lines_no_uq" ON "request_lines" USING btree ("request_id","line_no");--> statement-breakpoint
CREATE INDEX "request_lines_status_item_idx" ON "request_lines" USING btree ("status","item_id");--> statement-breakpoint
CREATE INDEX "requests_requester_idx" ON "requests" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "requests_org_unit_idx" ON "requests" USING btree ("org_unit_id");--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_uq" ON "users" USING btree ("google_sub");