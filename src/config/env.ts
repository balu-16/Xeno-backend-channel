import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CHANNEL_PORT: z.coerce.number().int().positive().default(3001),
  CRM_SERVICE_URL: z.string().url().default("http://localhost:3000"),
  CHANNEL_WEBHOOK_SECRET: z.string().min(32).default("xeno-webhook-secret-default-change-me-in-production-32ch!")
});

export type ChannelEnvironment = z.infer<typeof envSchema>;

export function validateEnvironment(
  config: Record<string, unknown>
): ChannelEnvironment {
  return envSchema.parse(config);
}
