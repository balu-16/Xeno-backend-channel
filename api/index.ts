import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import serverless from "serverless-http";
import { AppModule } from "../src/app.module";

let cachedHandler: ReturnType<typeof serverless>;

const allowedOrigins = [
  process.env.FRONTEND_URL,
  "https://xeno-frontend-kappa.vercel.app",
  "http://localhost:5173",
].filter(Boolean) as string[];

async function createApp() {
  const expressApp = express();

  expressApp.use(
    cors({
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow: boolean) => void,
      ) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
    }),
  );

  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
    bufferLogs: true,
  });

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.enableCors({ origin: false });
  await app.init();
  return expressApp;
}

export default async function handler(req: express.Request, res: express.Response) {
  if (!cachedHandler) {
    const app = await createApp();
    cachedHandler = serverless(app, { binary: false });
  }
  return cachedHandler(req, res);
}
