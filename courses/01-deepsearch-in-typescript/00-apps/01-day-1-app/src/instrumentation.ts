import { registerOTel } from "@vercel/otel";
import { LangfuseExporter } from "langfuse-vercel";

export function register() {
  registerOTel({
    serviceName: "dom-deep-search-cohort",
    traceExporter: new LangfuseExporter(),
  });
}
