-- Shape of a free try (square/portrait/landscape image, 9:16/16:9/1:1 video),
-- so each SEO tool page can ask for the format its platform uses.
ALTER TABLE "try_generations" ADD COLUMN IF NOT EXISTS "aspect" text;
