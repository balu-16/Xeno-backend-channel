import { Controller, Get } from "@nestjs/common";
import { ChannelWorker } from "./channel.worker";

@Controller("health")
export class HealthController {
  constructor(private readonly worker: ChannelWorker) {}

  @Get()
  get() {
    return {
      service: "xeno-channel",
      status: "ok",
      worker: this.worker.status,
      timestamp: new Date().toISOString()
    };
  }
}
