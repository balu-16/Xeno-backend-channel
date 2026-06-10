import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CHANNEL_PORT: z.coerce.number().int().positive().default(3001),
  CRM_SERVICE_URL: z.string().url().default("http://localhost:3000"),
  CHANNEL_WEBHOOK_SECRET: z.string().min(32),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_USERNAME: z.string().default("default"),
  REDIS_PASSWORD: z.string().min(1),
  REDIS_TLS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true")
});

export type ChannelEnvironment = z.infer<typeof envSchema>;

export function validateEnvironment(
  config: Record<string, unknown>
): ChannelEnvironment {
  return envSchema.parse(config);
}
