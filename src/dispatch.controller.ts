import { Body, Controller, Post } from "@nestjs/common";
import { campaignDispatchJobSchema } from "./contracts";
import { ChannelWorker } from "./channel.worker";

@Controller("api/dispatch")
export class DispatchController {
  constructor(private readonly worker: ChannelWorker) {}

  @Post()
  async dispatch(@Body() input: unknown) {
    const job = campaignDispatchJobSchema.parse(input);
    await this.worker.dispatch(job);
    return { dispatched: true, campaignId: job.campaignId, customerId: job.customerId };
  }
}
