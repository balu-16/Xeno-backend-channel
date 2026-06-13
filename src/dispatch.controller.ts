import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { campaignDispatchJobSchema } from "./contracts";
import { ChannelSimulatorService } from "./channel-simulator.service";

@Controller("api/dispatch")
export class DispatchController {
  constructor(private readonly simulator: ChannelSimulatorService) {}

  @Post()
  @HttpCode(202)
  async dispatch(@Body() input: unknown) {
    const job = campaignDispatchJobSchema.parse(input);
    await this.simulator.dispatch(job);
    return { accepted: true, campaignId: job.campaignId, customerId: job.customerId };
  }
}
