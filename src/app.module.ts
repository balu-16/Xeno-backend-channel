import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ChannelWorker } from "./channel.worker";
import { validateEnvironment } from "./config/env";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../.env", ".env"],
      validate: validateEnvironment
    })
  ],
  controllers: [HealthController],
  providers: [ChannelWorker]
})
export class AppModule {}
