import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";
import type { ChannelEnvironment } from "./config/env";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<ChannelEnvironment, true>);
  app.use(helmet());
  app.enableShutdownHooks();
  await app.listen(config.get("CHANNEL_PORT", { infer: true }));
}

void bootstrap();
