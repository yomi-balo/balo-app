CREATE TYPE "public"."signup_intent" AS ENUM('client', 'expert');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_intent" "signup_intent";