import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  campaignDispatchJobSchema,
  queueNames,
  type CampaignDispatchJob,
  type CampaignEventType,
  type ChannelWebhook
} from "./contracts";
import { Job, Worker } from "bullmq";
import {
  createHash,
  createHmac,
  randomUUID
} from "node:crypto";
import type { ChannelEnvironment } from "./config/env";

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

@Injectable()
export class ChannelWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelWorker.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService<ChannelEnvironment, true>
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      queueNames.campaignDispatch,
      async (job: Job) => {
        const input = campaignDispatchJobSchema.parse(job.data);
        await this.simulate(input);
      },
      {
        connection: {
          host: this.config.get("REDIS_HOST", { infer: true }),
          port: this.config.get("REDIS_PORT", { infer: true }),
          username: this.config.get("REDIS_USERNAME", { infer: true }),
          password: this.config.get("REDIS_PASSWORD", { infer: true }),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: (attempt: number) =>
            Math.min(attempt * 1000, 30000),
          ...(this.config.get("REDIS_TLS", { infer: true }) ? { tls: {} } : {})
        },
        concurrency: 30,
        limiter: { max: 120, duration: 1000 }
      }
    );
    this.worker.on("completed", (job) => {
      this.logger.debug(`Dispatched ${job.id ?? "message"}`);
    });
    this.worker.on("error", (error) => {
      this.logger.error(`Campaign dispatch worker unavailable: ${error.message}`);
    });
    this.worker.on("failed", (job, error) => {
      this.logger.error(
        `Dispatch ${job?.id ?? "unknown"} failed after ${job?.attemptsMade ?? 0} attempts`,
        error.stack
      );
    });
  }

  private score(input: CampaignDispatchJob): number {
    const digest = createHash("sha256")
      .update(`${input.campaignId}:${input.customerId}`)
      .digest();
    return digest[0] ?? 0;
  }

  private async callback(
    input: CampaignDispatchJob,
    type: CampaignEventType,
    payload: Record<string, unknown>
  ): Promise<void> {
    const event: ChannelWebhook = {
      eventId: randomUUID(),
      type,
      occurredAt: new Date().toISOString(),
      campaignId: input.campaignId,
      customerId: input.customerId,
      correlationId: input.correlationId,
      payload
    };
    const body = JSON.stringify(event);
    const signature = createHmac(
      "sha256",
      this.config.get("CHANNEL_WEBHOOK_SECRET", { infer: true })
    )
      .update(body)
      .digest("hex");
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(
          `${this.config.get("CRM_SERVICE_URL", { infer: true }).replace(/\/$/, "")}/api/webhooks/channel`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-xeno-signature": `sha256=${signature}`,
              "x-correlation-id": input.correlationId
            },
            body,
            signal: AbortSignal.timeout(5000)
          }
        );
        if (!response.ok) {
          throw new Error(`CRM webhook returned HTTP ${String(response.status)}`);
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 2) {
          await sleep(250 * 2 ** attempt);
        }
      }
    }
    throw lastError ?? new Error("Webhook delivery failed");
  }

  private async simulate(input: CampaignDispatchJob): Promise<void> {
    const score = this.score(input);
    await sleep(50 + (score % 100));
    await this.callback(input, "MessageSent", {
      provider: "xeno-channel-simulator",
      channel: input.channel,
      destination:
        input.destination.length > 4
          ? input.destination.replace(/^(.{2}).+(.{2})$/, "$1***$2")
          : "***"
    });

    if (score < 20) {
      await sleep(80);
      await this.callback(input, "MessageFailed", {
        reason:
          score % 2 === 0
            ? "Simulated provider rejection"
            : "Invalid destination"
      });
      return;
    }

    await sleep(80 + (score % 120));
    await this.callback(input, "MessageDelivered", {
      provider: "xeno-channel-simulator"
    });
    if (score < 95) {
      return;
    }

    await sleep(100 + (score % 140));
    await this.callback(input, "MessageOpened", {
      device: score % 2 === 0 ? "mobile" : "desktop"
    });
    if (score < 155) {
      return;
    }

    await sleep(100 + (score % 160));
    await this.callback(input, "MessageClicked", {
      destination: "/campaign-offer"
    });
    if (score < 220) {
      return;
    }

    await sleep(120 + (score % 180));
    await this.callback(input, "MessageConverted", {
      orderAmount: 40 + (score % 160),
      attributionWindow: "7d"
    });
  }

  get status(): { running: boolean; paused: boolean } {
    return {
      running: Boolean(this.worker?.isRunning()),
      paused: Boolean(this.worker?.isPaused())
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close(true);
  }
}
