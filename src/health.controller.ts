import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  get() {
    return {
      service: "xeno-channel",
      status: "ok",
      timestamp: new Date().toISOString()
    };
  }
}
